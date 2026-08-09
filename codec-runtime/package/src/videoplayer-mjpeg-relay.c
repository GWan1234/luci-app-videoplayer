/* SPDX-License-Identifier: GPL-2.0-or-later */
/*
 * Frame-aligned MJPEG relay for luci-app-videoplayer.
 *
 * FFmpeg writes multipart/x-mixed-replace to stdin.  This helper validates and
 * normalizes one complete JPEG part at a time before forwarding it to stdout.
 * A segment deadline is observed only between complete parts, so a handoff can
 * never consume several small frames and then drop them in a buffered write.
 * Once the root-owned terminal marker appears, the deadline is ignored and the
 * remaining FIFO is drained to a real EOF.
 */

#define _GNU_SOURCE
#define _POSIX_C_SOURCE 200809L

#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#define MAX_BOUNDARY_BYTES 96U
#define MAX_HEADER_BYTES 16384U
#define MAX_FRAME_BYTES (4U * 1024U * 1024U)
#define MAX_SEGMENT_PAYLOAD_BYTES (16U * 1024U * 1024U)
#define HEADER_WAIT_SECONDS 10U
#define MAX_SCAN_BYTES \
	(MAX_FRAME_BYTES + MAX_HEADER_BYTES + 2U * MAX_BOUNDARY_BYTES + 16U)

enum relay_result {
	RELAY_EOF = 0,
	RELAY_ERROR = 1,
	RELAY_SEGMENT_END = 2,
	RELAY_USAGE = 64
};

static int write_all(const void *buffer, size_t length)
{
	const unsigned char *cursor = buffer;

	while (length > 0) {
		ssize_t written = write(STDOUT_FILENO, cursor, length);

		if (written < 0) {
			if (errno == EINTR)
				continue;
			return -1;
		}
		if (written == 0)
			return -1;
		cursor += (size_t)written;
		length -= (size_t)written;
	}
	return 0;
}

static int read_exact(void *buffer, size_t length)
{
	unsigned char *cursor = buffer;

	while (length > 0) {
		ssize_t received = read(STDIN_FILENO, cursor, length);

		if (received < 0) {
			if (errno == EINTR)
				continue;
			return -1;
		}
		if (received == 0)
			return 0;
		cursor += (size_t)received;
		length -= (size_t)received;
	}
	return 1;
}

/* Return 1 for a complete line, 0 for clean EOF before any byte, -1 otherwise. */
static int read_line(char *line, size_t capacity, size_t *length,
		     size_t *scan_total)
{
	size_t used = 0;

	if (capacity < 2)
		return -1;
	for (;;) {
		unsigned char byte;
		ssize_t received = read(STDIN_FILENO, &byte, 1);

		if (received < 0) {
			if (errno == EINTR)
				continue;
			return -1;
		}
		if (received == 0) {
			if (used == 0)
				return 0;
			return -1;
		}
		if (scan_total != NULL) {
			if (*scan_total >= MAX_SCAN_BYTES)
				return -1;
			(*scan_total)++;
		}
		if (used + 1 >= capacity)
			return -1;
		line[used++] = (char)byte;
		if (byte == '\n')
			break;
	}
	line[used] = '\0';
	*length = used;
	return 1;
}

static int parse_decimal_size(const char *value, size_t *result)
{
	uint64_t parsed = 0;
	const unsigned char *cursor = (const unsigned char *)value;

	while (*cursor == ' ' || *cursor == '\t')
		cursor++;
	if (!isdigit(*cursor))
		return -1;
	while (isdigit(*cursor)) {
		parsed = parsed * 10U + (uint64_t)(*cursor - '0');
		if (parsed > MAX_FRAME_BYTES)
			return -1;
		cursor++;
	}
	while (*cursor == ' ' || *cursor == '\t')
		cursor++;
	if (*cursor == '\r')
		cursor++;
	if (*cursor != '\n' || cursor[1] != '\0' || parsed < 4U)
		return -1;
	*result = (size_t)parsed;
	return 0;
}

static int terminal_marker_is_safe(const char *path, const char *boundary,
				   const char *nonce)
{
	struct stat file_status;
	char expected[128];
	char actual[128];
	const char *token;
	int expected_length;
	int descriptor;
	ssize_t length;
	ssize_t extra;
	size_t used = 0;

	if (strncmp(boundary, "videoplayer-", 12) != 0 ||
	    strlen(boundary) != 44U)
		return 0;
	token = boundary + 12;
	expected_length = snprintf(expected, sizeof(expected),
		"snapshot-v1\n%s\n%s\nready\n", token, nonce);
	if (expected_length < 0 || (size_t)expected_length >= sizeof(expected))
		return 0;
	descriptor = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
	if (descriptor < 0)
		return 0;
	if (fstat(descriptor, &file_status) != 0 ||
	    !S_ISREG(file_status.st_mode) || file_status.st_uid != 0 ||
	    (file_status.st_mode & 0777) != 0600) {
		(void)close(descriptor);
		return 0;
	}
	while (used < (size_t)expected_length) {
		do {
			length = read(descriptor, actual + used,
				(size_t)expected_length - used);
		} while (length < 0 && errno == EINTR);
		if (length <= 0)
			break;
		used += (size_t)length;
	}
	do {
		extra = read(descriptor, actual + sizeof(actual) - 1U, 1);
	} while (extra < 0 && errno == EINTR);
	(void)close(descriptor);
	return used == (size_t)expected_length && extra == 0 &&
		memcmp(actual, expected, (size_t)expected_length) == 0;
}

static int deadline_reached(const struct timespec *started,
			    unsigned int segment_seconds)
{
	struct timespec now;
	time_t seconds;
	long nanoseconds;

	if (clock_gettime(CLOCK_MONOTONIC, &now) != 0)
		return -1;
	seconds = now.tv_sec - started->tv_sec;
	nanoseconds = now.tv_nsec - started->tv_nsec;
	if (nanoseconds < 0) {
		seconds--;
		nanoseconds += 1000000000L;
	}
	(void)nanoseconds;
	return seconds >= (time_t)segment_seconds;
}

/* Wait only while positioned between complete parts. Returning 0 is a clean
 * segment handoff: no byte of the next boundary has been consumed. */
static int wait_for_boundary(const struct timespec *started,
			     unsigned int segment_seconds,
			     const char *terminal_marker,
			     const char *boundary, const char *nonce)
{
	struct pollfd input = {
		.fd = STDIN_FILENO,
		.events = POLLIN | POLLHUP,
		.revents = 0
	};

	for (;;) {
		int terminal = terminal_marker_is_safe(
			terminal_marker, boundary, nonce);
		int expired = deadline_reached(started, segment_seconds);
		int result;

		if (expired < 0)
			return -1;
		if (!terminal && expired)
			return 0;
		input.revents = 0;
		do {
			/* Recheck a newly published terminal marker promptly. Once it is
			 * valid, the worker closes its FIFO anchor and POLLHUP releases us. */
			result = poll(&input, 1, 250);
		} while (result < 0 && errno == EINTR);
		if (result < 0)
			return -1;
		if (result > 0) {
			if (input.revents & (POLLIN | POLLHUP))
				return 1;
			return -1;
		}
	}
}

/* FFmpeg's mpjpeg trailer is an ordinary opening-boundary line with no part
 * headers after it.  The renderer keeps a FIFO writer anchor open until the
 * authenticated terminal marker is published, so EOF alone cannot identify
 * that trailer.  Once a boundary has been consumed, prefer any already queued
 * header bytes; otherwise the marker proves that the boundary is the trailer.
 * A non-terminal deadline here is an error because the boundary has already
 * been consumed and therefore cannot be handed to a successor relay. */
static int wait_for_headers(unsigned int header_wait_seconds,
			    const char *terminal_marker,
			    const char *boundary, const char *nonce)
{
	struct timespec started;
	struct pollfd input = {
		.fd = STDIN_FILENO,
		.events = POLLIN | POLLHUP,
		.revents = 0
	};

	/* The opening boundary has already been consumed and cannot be handed to a
	 * successor. Start a fresh, explicitly bounded clock for distinguishing a
	 * queued part header from FFmpeg's bare terminal boundary. */
	if (clock_gettime(CLOCK_MONOTONIC, &started) != 0)
		return -1;

	for (;;) {
		int result;
		int expired;

		input.revents = 0;
		do {
			result = poll(&input, 1, 0);
		} while (result < 0 && errno == EINTR);
		if (result < 0)
			return -1;
		if (result > 0 && (input.revents & POLLIN))
			return 1;
		if (result > 0 && !(input.revents & POLLHUP))
			return -1;
		if (terminal_marker_is_safe(terminal_marker, boundary, nonce))
			return 0;
		if (result > 0 && (input.revents & POLLHUP))
			return 1;

		expired = deadline_reached(&started, header_wait_seconds);
		if (expired != 0)
			return -1;
		input.revents = 0;
		do {
			result = poll(&input, 1, 250);
		} while (result < 0 && errno == EINTR);
		if (result < 0)
			return -1;
		if (result > 0 && (input.revents & POLLIN))
			return 1;
		if (result > 0 && !(input.revents & POLLHUP))
			return -1;
		/* POLLHUP without bytes is re-evaluated at the top, where a marker
		 * wins and an unauthenticated EOF is handed to the strict parser. */
	}
}

static int valid_boundary(const char *boundary)
{
	size_t length = strlen(boundary);
	size_t index;

	if (length < 1 || length > MAX_BOUNDARY_BYTES)
		return 0;
	for (index = 0; index < length; index++) {
		unsigned char byte = (unsigned char)boundary[index];

		if (!isalnum(byte) && byte != '-' && byte != '_')
			return 0;
	}
	return 1;
}

static int scan_boundary(const char *open_boundary,
			 const char *close_boundary, int *closed)
{
	char candidate[MAX_BOUNDARY_BYTES + 7U];
	size_t candidate_length = 0;
	size_t scanned = 0;
	int at_line_start = 1;
	int candidate_valid = 1;

	while (scanned < MAX_SCAN_BYTES) {
		unsigned char byte;
		ssize_t received = read(STDIN_FILENO, &byte, 1);

		if (received < 0) {
			if (errno == EINTR)
				continue;
			return -1;
		}
		if (received == 0)
			return scanned == 0 ? 0 : -1;
		scanned++;
		if (at_line_start) {
			candidate_length = 0;
			candidate_valid = 1;
			at_line_start = 0;
		}
		if (candidate_valid) {
			if (candidate_length < sizeof(candidate) - 1U)
				candidate[candidate_length++] = (char)byte;
			else
				candidate_valid = 0;
		}
		if (byte != '\n')
			continue;
		if (candidate_valid) {
			candidate[candidate_length] = '\0';
			if (strcmp(candidate, open_boundary) == 0) {
				*closed = 0;
				return 1;
			}
			if (strcmp(candidate, close_boundary) == 0) {
				*closed = 1;
				return 1;
			}
		}
		at_line_start = 1;
	}
	return -1;
}

static int read_part_headers(size_t *content_length)
{
	char line[MAX_HEADER_BYTES + 1U];
	size_t line_length;
	size_t total = 0;
	int saw_type = 0;
	int saw_length = 0;

	for (;;) {
		char *colon;
		char *value;
		int result = read_line(line, sizeof(line), &line_length, NULL);

		if (result != 1)
			return -1;
		if (total > MAX_HEADER_BYTES - line_length)
			return -1;
		total += line_length;
		if (strcmp(line, "\r\n") == 0)
			break;
		colon = strchr(line, ':');
		if (colon == NULL)
			return -1;
		*colon = '\0';
		value = colon + 1;
		if (strcasecmp(line, "Content-Type") == 0) {
			while (*value == ' ' || *value == '\t')
				value++;
			if (strcasecmp(value, "image/jpeg\r\n") != 0 || saw_type)
				return -1;
			saw_type = 1;
		} else if (strcasecmp(line, "Content-Length") == 0) {
			if (saw_length || parse_decimal_size(value, content_length) != 0)
				return -1;
			saw_length = 1;
		}
	}
	return saw_type && saw_length ? 0 : -1;
}

static int read_frame(unsigned char *buffer, size_t length,
		      unsigned char trailer[2])
{
	if (read_exact(buffer, length) != 1 ||
	    read_exact(trailer, 2U) != 1 ||
	    trailer[0] != '\r' || trailer[1] != '\n')
		return -1;
	return 0;
}

static int valid_nonce(const char *nonce)
{
	size_t left = 0;
	size_t right = 0;
	int saw_dash = 0;

	if (nonce == NULL || *nonce == '\0')
		return 0;
	while (*nonce != '\0') {
		unsigned char byte = (unsigned char)*nonce++;

		if (byte == '-') {
			if (saw_dash || left == 0U)
				return 0;
			saw_dash = 1;
			continue;
		}
		if (!isdigit(byte))
			return 0;
		if (saw_dash) {
			if (++right > 16U)
				return 0;
		} else if (++left > 16U) {
			return 0;
		}
	}
	return left > 0U && (!saw_dash || right > 0U);
}

int main(int argc, char **argv)
{
	const char *boundary;
	const char *terminal_marker;
	char open_boundary[MAX_BOUNDARY_BYTES + 5U];
	char close_boundary[MAX_BOUNDARY_BYTES + 7U];
	struct timespec started;
	char *end = NULL;
	unsigned long parsed_seconds;
	unsigned long parsed_frames;
	unsigned int segment_seconds;
	unsigned int max_frames;
	unsigned int frame_count = 0;
	size_t payload_bytes = 0;
	int prefetched;
	int have_boundary = 0;

	if (argc != 7)
		return RELAY_USAGE;
	boundary = argv[1];
	terminal_marker = argv[4];
	if (!valid_boundary(boundary) ||
	    (strcmp(argv[2], "0") != 0 && strcmp(argv[2], "1") != 0) ||
	    terminal_marker[0] != '/' || !valid_nonce(argv[5]))
		return RELAY_USAGE;
	errno = 0;
	parsed_seconds = strtoul(argv[3], &end, 10);
	if (errno != 0 || end == argv[3] || *end != '\0' ||
	    parsed_seconds < 1 || parsed_seconds > 3600)
		return RELAY_USAGE;
	errno = 0;
	end = NULL;
	parsed_frames = strtoul(argv[6], &end, 10);
	if (errno != 0 || end == argv[6] || *end != '\0' ||
	    parsed_frames < 1 || parsed_frames > 300)
		return RELAY_USAGE;
	segment_seconds = (unsigned int)parsed_seconds;
	max_frames = (unsigned int)parsed_frames;
	prefetched = argv[2][0] == '1';
	if (snprintf(open_boundary, sizeof(open_boundary), "--%s\r\n", boundary) < 0 ||
	    snprintf(close_boundary, sizeof(close_boundary), "--%s--\r\n", boundary) < 0 ||
	    clock_gettime(CLOCK_MONOTONIC, &started) != 0)
		return RELAY_ERROR;

	/* Do not inherit a caller which ignored SIGPIPE. */
	(void)signal(SIGPIPE, SIG_DFL);
	if (prefetched)
		have_boundary = 1;

	for (;;) {
		size_t content_length;
		unsigned char *frame;
		unsigned char trailer[2];
		char normalized_headers[128];
		int header_length;
		int closed = 0;
		int scan_result;
		int expired;
		int headers_ready;

		if (!have_boundary) {
			int boundary_ready = wait_for_boundary(
				&started, segment_seconds, terminal_marker,
				boundary, argv[5]);

			if (boundary_ready == 0) {
				if (write_all(close_boundary, strlen(close_boundary)) != 0)
					return RELAY_ERROR;
				return RELAY_SEGMENT_END;
			}
			if (boundary_ready < 0)
				return RELAY_ERROR;
			scan_result = scan_boundary(open_boundary, close_boundary, &closed);
			if (scan_result == 0)
				return RELAY_EOF;
			if (scan_result < 0)
				return RELAY_ERROR;
			if (closed) {
				if (write_all(close_boundary, strlen(close_boundary)) != 0)
					return RELAY_ERROR;
				return RELAY_EOF;
			}
		}
		have_boundary = 0;
		headers_ready = wait_for_headers(
			HEADER_WAIT_SECONDS, terminal_marker, boundary, argv[5]);
		if (headers_ready == 0) {
			if (write_all(close_boundary, strlen(close_boundary)) != 0)
				return RELAY_ERROR;
			return RELAY_EOF;
		}
		if (headers_ready < 0)
			return RELAY_ERROR;

		if (read_part_headers(&content_length) != 0)
			return RELAY_ERROR;
		frame = malloc(content_length);
		if (frame == NULL)
			return RELAY_ERROR;
		if (read_frame(frame, content_length, trailer) != 0) {
			free(frame);
			return RELAY_ERROR;
		}
		header_length = snprintf(normalized_headers,
			sizeof(normalized_headers),
			"Content-Type: image/jpeg\r\nContent-Length: %zu\r\n\r\n",
			content_length);
		if (header_length < 0 ||
		    (size_t)header_length >= sizeof(normalized_headers) ||
		    write_all(open_boundary, strlen(open_boundary)) != 0 ||
		    write_all(normalized_headers, (size_t)header_length) != 0 ||
		    write_all(frame, content_length) != 0 ||
		    write_all(trailer, sizeof(trailer)) != 0) {
			free(frame);
			return RELAY_ERROR;
		}
		free(frame);
		frame_count++;
		if (payload_bytes > MAX_SEGMENT_PAYLOAD_BYTES - content_length)
			payload_bytes = MAX_SEGMENT_PAYLOAD_BYTES;
		else
			payload_bytes += content_length;

		if (terminal_marker_is_safe(terminal_marker, boundary, argv[5]))
			continue;
		if (frame_count >= max_frames ||
		    payload_bytes >= MAX_SEGMENT_PAYLOAD_BYTES) {
			if (write_all(close_boundary, strlen(close_boundary)) != 0)
				return RELAY_ERROR;
			return RELAY_SEGMENT_END;
		}
		expired = deadline_reached(&started, segment_seconds);
		if (expired < 0)
			return RELAY_ERROR;
		if (expired) {
			if (write_all(close_boundary, strlen(close_boundary)) != 0)
				return RELAY_ERROR;
			return RELAY_SEGMENT_END;
		}
	}
}
