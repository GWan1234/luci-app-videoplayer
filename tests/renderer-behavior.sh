#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
set -Eeuo pipefail

fail() {
	printf 'renderer-test: %s\n' "$*" >&2
	exit 1
}

assert_eq() {
	[[ "$1" == "$2" ]] ||
		fail "$3: expected '$2', got '$1'"
}

[[ ${EUID} -eq 0 ]] || fail "run with sudo"

repo_root="$(readlink -f -- "${1:-$PWD}")"
source_helper="$repo_root/luci-app-videoplayer/root/usr/libexec/videoplayer-renderer"
[[ -f "$source_helper" ]] || fail "renderer helper not found"

for tool in cc flock python3 readlink sed stat; do
	command -v "$tool" >/dev/null || fail "$tool is required"
done

work="$(mktemp -d /tmp/videoplayer-renderer-ci.XXXXXX)"
bin="$work/bin"
runtime="$work/runtime"
helper="$bin/videoplayer-renderer"
private_exec_dir="$work/private-libexec/videoplayer-ffmpeg"
private_lib_dir="$work/private-lib/videoplayer-ffmpeg"
private_ffmpeg="$private_exec_dir/ffmpeg"

mkdir -m 0755 -- "$bin" "$work/media"

export VIDEOPLAYER_TEST_MEDIA_ROOT="$work/media"
export VIDEOPLAYER_TEST_RUNTIME="$runtime"

terminate_owned_pid() {
	local pid="${1:-}" cmdline

	[[ "$pid" =~ ^[0-9]+$ && "$pid" -gt 1 ]] || return 0
	[[ -r "/proc/$pid/cmdline" ]] || return 0

	cmdline="$(tr '\000' '\n' < "/proc/$pid/cmdline" 2>/dev/null || true)"
	[[ "$cmdline" == *"$work/"* ]] || return 0

	kill -TERM "$pid" 2>/dev/null || true
	sleep 0.1

	[[ -r "/proc/$pid/cmdline" ]] || return 0
	cmdline="$(tr '\000' '\n' < "/proc/$pid/cmdline" 2>/dev/null || true)"
	if [[ "$cmdline" == *"$work/"* ]]; then
		kill -KILL "$pid" 2>/dev/null || true
	fi
}

cleanup() {
	local rc=$?

	trap - EXIT INT TERM
	set +e

	[[ -x "$helper" ]] && "$helper" cleanup >/dev/null 2>&1

	for pid in \
		"${worker1:-}" "${ffmpeg1:-}" "${audio1:-}" "${chunker1:-}" \
		"${worker2:-}" "${ffmpeg2:-}" "${audio2:-}" "${chunker2:-}" \
		"${finite_worker:-}" "${finite_ffmpeg:-}" \
		"${finite_media_worker:-}" "${finite_media_ffmpeg:-}" \
		"${chunker_failure_worker:-}" "${chunker_failure_ffmpeg:-}" \
		"${chunker_failure_audio:-}" "${chunker_failure_chunker:-}"
	do
		terminate_owned_pid "$pid"
	done

	case "$work" in
		/tmp/videoplayer-renderer-ci.*)
			rm -rf -- "$work"
			;;
	esac

	exit "$rc"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Transform only environment-bound paths in a disposable copy.
grep -Fq 'export PATH="/usr/sbin:/usr/bin:/sbin:/bin"' "$source_helper" ||
	fail "unexpected PATH declaration"
grep -Fq '/tmp/videoplayer-render-v1' "$source_helper" ||
	fail "unexpected runtime declaration"
grep -Fq '/usr/libexec/videoplayer-renderer' "$source_helper" ||
	fail "unexpected self path"
grep -Fq '/usr/libexec/videoplayer-ffmpeg/ffmpeg' "$source_helper" ||
	fail "unexpected private FFmpeg path"
grep -Fq '/usr/lib/videoplayer-ffmpeg' "$source_helper" ||
	fail "unexpected private FFmpeg library path"

sed \
	-e "s|export PATH=\"/usr/sbin:/usr/bin:/sbin:/bin\"|export PATH=\"$bin:/usr/sbin:/usr/bin:/sbin:/bin\"|" \
	-e "s|/tmp/videoplayer-render-v1|$runtime|g" \
	-e "s|/usr/libexec/videoplayer-renderer|$helper|g" \
	-e "s|/usr/libexec/videoplayer-ffmpeg/ffmpeg|$private_ffmpeg|g" \
	-e "s|/usr/lib/videoplayer-ffmpeg|$private_lib_dir|g" \
	"$source_helper" > "$helper"

chmod 0755 "$helper"

! grep -Fq '/tmp/videoplayer-render-v1' "$helper" ||
	fail "runtime transform incomplete"
! grep -Fq '/usr/libexec/videoplayer-renderer' "$helper" ||
	fail "self-path transform incomplete"
! grep -Fq '/usr/libexec/videoplayer-ffmpeg/ffmpeg' "$helper" ||
	fail "private FFmpeg transform incomplete"
! grep -Fq '/usr/lib/videoplayer-ffmpeg' "$helper" ||
	fail "private FFmpeg library transform incomplete"

cat > "$bin/uci" <<'SH'
#!/bin/sh
[ "${1:-}" = "-q" ] && shift
[ "${1:-}" = "get" ] || exit 1

case "${2:-}" in
	videoplayer.main.enabled)
		printf '1\n'
		;;
	videoplayer.main.render_mode)
		printf 'router\n'
		;;
	videoplayer.main.media_path)
		printf '%s\n' "$VIDEOPLAYER_TEST_MEDIA_ROOT"
		;;
	videoplayer.main.router_fps)
		printf '8\n'
		;;
	*)
		exit 1
		;;
esac
SH

chmod 0755 "$bin/uci"

# An ELF stub preserves the same /proc/cmdline shape as real FFmpeg. Besides
# providing probe output, it verifies fd 3, closed lock fd 8, and the important
# resource/security arguments used by the production worker.
cc -std=c11 -D_DEFAULT_SOURCE -O2 -Wall -Wextra -Werror \
	-x c -o "$bin/ffmpeg" - <<'C'
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static volatile sig_atomic_t running = 1;

static void stop(int sig)
{
	(void)sig;
	running = 0;
}

static int has_arg(int argc, char **argv, const char *wanted)
{
	int i;

	for (i = 1; i < argc; ++i)
		if (strcmp(argv[i], wanted) == 0)
			return 1;

	return 0;
}

static int count_pair(
	int argc,
	char **argv,
	const char *left,
	const char *right)
{
	int count = 0;
	int i;

	for (i = 1; i + 1 < argc; ++i)
		if (strcmp(argv[i], left) == 0 &&
		    strcmp(argv[i + 1], right) == 0)
			++count;

	return count;
}

static int ends_with(const char *text, const char *suffix)
{
	size_t text_len = strlen(text);
	size_t suffix_len = strlen(suffix);

	return text_len >= suffix_len &&
	       strcmp(text + text_len - suffix_len, suffix) == 0;
}

static int output_is_safe(const char *output, const char *suffix)
{
	const char *root = getenv("VIDEOPLAYER_TEST_RUNTIME");
	size_t output_len;
	size_t root_len;

	if (root == NULL)
		return 0;

	output_len = strlen(output);
	root_len = strlen(root);

	if (output_len < root_len + 3)
		return 0;

	return strncmp(output, root, root_len) == 0 &&
	       strncmp(output + root_len, "/s-", 3) == 0 &&
	       ends_with(output, suffix);
}

static int publish(const char *output)
{
	static const unsigned char frame[] = {
		0xff, 0xd8, 0xff, 0xd9
	};
	char temporary[4096];
	int fd;

	if (snprintf(
		    temporary,
		    sizeof(temporary),
		    "%s.tmp",
		    output) >= (int)sizeof(temporary))
		return -1;

	fd = open(temporary, O_WRONLY | O_CREAT | O_TRUNC, 0600);
	if (fd < 0)
		return -1;

	if (write(fd, frame, sizeof(frame)) != (ssize_t)sizeof(frame)) {
		close(fd);
		unlink(temporary);
		return -1;
	}

	if (close(fd) != 0 || rename(temporary, output) != 0) {
		unlink(temporary);
		return -1;
	}

	return 0;
}

static int publish_audio(int fd, unsigned int sequence)
{
	unsigned char pcm[48000];
	size_t written = 0;
	ssize_t result;

	memset(pcm, (int)(sequence & 0xffU), sizeof(pcm));

	while (written < sizeof(pcm)) {
		result = write(fd, pcm + written, sizeof(pcm) - written);
		if (result > 0) {
			written += (size_t)result;
			continue;
		}
		if (result < 0 && errno == EINTR)
			continue;
		return -1;
	}
	return 0;
}

static int marker_is(
	const char *marker,
	ssize_t marker_size,
	const char *wanted)
{
	size_t wanted_size = strlen(wanted);

	return marker_size >= (ssize_t)wanted_size &&
	       memcmp(marker, wanted, wanted_size) == 0;
}

int main(int argc, char **argv)
{
	struct stat input;
	char marker[32] = {0};
	const char *output;
	int input_fd;
	int is_audio;
	int audio_fail;
	int audio_finite;
	int audio_output_fd;
	int fail_after_first_frame;
	int finite_video;
	int line;
	unsigned int audio_sequence = 0;
	unsigned int video_sequence = 0;
	ssize_t marker_size;
	const char *expected_private_lib;
	const char *library_path;

	expected_private_lib = getenv("VIDEOPLAYER_EXPECT_PRIVATE_LIB");
	library_path = getenv("LD_LIBRARY_PATH");
	if (expected_private_lib != NULL) {
		if (expected_private_lib[0] == '\0') {
			if (library_path != NULL && library_path[0] != '\0')
				return 79;
		} else if (library_path == NULL ||
			   strcmp(library_path, expected_private_lib) != 0) {
			return 79;
		}
	}

	if (has_arg(argc, argv, "-encoders")) {
		puts(" V..... mjpeg CI stub");
		puts(" A..... pcm_s16le CI stub");
		return 0;
	}

	if (has_arg(argc, argv, "-muxers")) {
		puts(" E image2 CI stub");
		puts(" E s16le CI stub");
		return 0;
	}

	if (has_arg(argc, argv, "-filters")) {
		puts(" ... fps V->V CI stub");
		puts(" ... scale V->V CI stub");
		puts(" ... format V->V CI stub");
		puts(" ... aresample A->A CI stub");
		puts(" ... aformat A->A CI stub");
		puts(" ... asetnsamples A->A CI stub");
		return 0;
	}

	output = argv[argc - 1];
	is_audio = ends_with(output, "/audio.pipe");
	input_fd = is_audio ? 4 : 3;
	errno = 0;
	if (argc < 2 || !has_arg(argc, argv, "-nostdin") ||
	    !has_arg(argc, argv, "-re") ||
	    count_pair(argc, argv, "-filter_threads", "1") != 1 ||
	    count_pair(argc, argv, "-protocol_whitelist", "file,pipe") != 1 ||
	    count_pair(argc, argv, "-fflags", "+genpts") != 1 ||
	    count_pair(argc, argv, "-err_detect", "ignore_err") != 1 ||
	    fstat(input_fd, &input) != 0 ||
	    !S_ISREG(input.st_mode) ||
	    input.st_size <= 0 ||
	    fcntl(8, F_GETFD) != -1 ||
	    errno != EBADF)
		return 64;

	if (is_audio) {
		errno = 0;
		if (count_pair(argc, argv, "-threads", "1") < 2 ||
		    count_pair(argc, argv, "-i", "/proc/self/fd/4") != 1 ||
		    count_pair(argc, argv, "-map", "0:a:0") != 1 ||
		    count_pair(
			    argc,
			    argv,
			    "-af",
			    "aresample=48000:async=1:first_pts=0,aformat=sample_fmts=s16:channel_layouts=stereo,asetnsamples=n=12000:p=1") != 1 ||
		    count_pair(argc, argv, "-c:a", "pcm_s16le") != 1 ||
		    count_pair(argc, argv, "-f", "s16le") != 1 ||
		    fcntl(3, F_GETFD) != -1 ||
		    errno != EBADF ||
		    !output_is_safe(output, "/audio.pipe"))
			return 80;
	} else if (
	    count_pair(argc, argv, "-threads", "2") != 1 ||
	    count_pair(argc, argv, "-threads", "1") != 1 ||
	    count_pair(argc, argv, "-filter_threads", "1") != 1 ||
	    count_pair(argc, argv, "-i", "/proc/self/fd/3") != 1 ||
	    count_pair(argc, argv, "-map", "0:V:0") != 1 ||
	    count_pair(
		    argc,
		    argv,
		    "-vf",
		    "fps=8,scale=640:360:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=fast_bilinear,format=yuvj420p") != 1 ||
	    count_pair(argc, argv, "-c:v", "mjpeg") != 1 ||
	    count_pair(argc, argv, "-f", "image2") != 1 ||
	    count_pair(argc, argv, "-update", "1") != 1 ||
	    count_pair(argc, argv, "-atomic_writing", "1") != 1 ||
	    !output_is_safe(output, "/frame.jpg"))
		return 64;

	marker_size = pread(input_fd, marker, sizeof(marker) - 1, 0);
	if (marker_size < 0)
		return 67;
	finite_video = marker_is(marker, marker_size, "finite-media");
	if (is_audio) {
		if (marker_is(marker, marker_size, "no-audio")) {
			fputs("Stream map '0:a:0' matches no streams\n", stderr);
			return 81;
		}
		audio_fail = marker_is(
			marker,
			marker_size,
			"audio-runtime-failure");
		audio_finite = marker_is(
			marker,
			marker_size,
			"audio-finite") || finite_video;
		signal(SIGTERM, stop);
		signal(SIGINT, stop);
		signal(SIGHUP, stop);
		audio_output_fd = open(output, O_WRONLY);
		if (audio_output_fd < 0)
			return 82;
		while (running) {
			if (publish_audio(audio_output_fd, audio_sequence++) != 0) {
				close(audio_output_fd);
				return 82;
			}
			if (audio_fail && audio_sequence >= 4) {
				close(audio_output_fd);
				return 83;
			}
			if (audio_finite && audio_sequence >= 4) {
				close(audio_output_fd);
				return 0;
			}
			usleep(100000);
		}
		close(audio_output_fd);
		return 0;
	}
	if (marker_is(marker, marker_size, "decoder-missing")) {
		fputs(
			"Decoder (codec h264) not found for input stream #0:0\n",
			stderr);
		return 68;
	}
	if (marker_is(marker, marker_size, "decoder-modern")) {
		fputs(
			"[vist#0:0/h264 @ 0x1234] Decoding requested, "
			"but no decoder found for: h264\n",
			stderr);
		return 70;
	}
	if (marker_is(marker, marker_size, "boundary-decoder")) {
		for (line = 0; line < 16380; line++)
			fputc('A', stderr);
		fputs(
			"Decoder (codec h264) not found for input stream #0:0\n",
			stderr);
		return 78;
	}
	if (marker_is(marker, marker_size, "v4l2-unusable")) {
		fputs(
			"[h264_v4l2m2m @ 0x1234] Could not find a valid device\n"
			"[h264_v4l2m2m @ 0x1234] can't configure decoder\n"
			"[vist#0:0/h264 @ 0x1234] Error while opening decoder: "
			"Invalid argument\n",
			stderr);
		return 71;
	}
	if (marker_is(marker, marker_size, "noisy-v4l2")) {
		for (line = 0; line < 4096; line++)
			fputs(
				"recoverable decoder diagnostic that precedes "
				"the decisive final error\n",
				stderr);
		fputs(
			"[h264_v4l2m2m @ 0x1234] Could not find a valid device\n"
			"[h264_v4l2m2m @ 0x1234] can't configure decoder\n",
			stderr);
		return 72;
	}
	if (marker_is(marker, marker_size, "unknown-failure")) {
		fputs("Demuxer exploded for test fixture\n", stderr);
		return 73;
	}
	if (marker_is(marker, marker_size, "empty-diagnostics"))
		return 74;
	if (marker_is(marker, marker_size, "unsupported-option")) {
		fputs(
			"Unrecognized option 'atomic_writing'.\n"
			"Error splitting the argument list: Option not found\n",
			stderr);
		return 75;
	}
	if (marker_is(marker, marker_size, "v4l2-permission")) {
		fputs(
			"[h264_v4l2m2m @ 0x1234] Error while opening decoder: "
			"Permission denied\n",
			stderr);
		return 76;
	}
	if (marker_is(marker, marker_size, "sanitized-failure")) {
		fputs(
			"\x1b[decoder @ 0xdeadbeef] detailed\tproblem: ",
			stderr);
		for (line = 0; line < 200; line++)
			fputc('X', stderr);
		fputs(
			"\n[out#0/image2 @ 0x5678] Error opening output file "
			"/tmp/private.\n"
			"Conversion failed!\n",
			stderr);
		return 77;
	}
	if (marker_is(marker, marker_size, "noisy-diagnostics")) {
		for (line = 0; line < 4096; line++)
			fputs(
				"recoverable decoder diagnostic that must not stop playback\n",
				stderr);
		fflush(stderr);
	}
	fail_after_first_frame =
		marker_is(marker, marker_size, "runtime-failure");

	signal(SIGTERM, stop);
	signal(SIGINT, stop);
	signal(SIGHUP, stop);

	while (running) {
		if (publish(output) != 0)
			return 66;
		video_sequence++;
		if (finite_video && video_sequence >= 4)
			return 0;
		if (fail_after_first_frame) {
			sleep(4);
			fputs("Cannot allocate memory while decoding frame\n", stderr);
			return 69;
		}

		usleep(100000);
	}

	return 0;
}
C

chmod 0755 "$bin/ffmpeg"
printf 'non-empty local media fixture\n' > "$work/media/bad apple.mp4"
printf 'decoder-missing fixture\n' > "$work/media/h264.mp4"
printf 'decoder-modern fixture\n' > "$work/media/h264-modern.mp4"
printf 'boundary-decoder fixture\n' > "$work/media/h264-boundary.mp4"
printf 'v4l2-unusable fixture\n' > "$work/media/h264-v4l2.mp4"
printf 'noisy-v4l2 fixture\n' > "$work/media/noisy-v4l2.mp4"
printf 'unknown-failure fixture\n' > "$work/media/unknown.mp4"
printf 'empty-diagnostics fixture\n' > "$work/media/empty.mp4"
printf 'unsupported-option fixture\n' > "$work/media/unsupported-option.mp4"
printf 'v4l2-permission fixture\n' > "$work/media/v4l2-permission.mp4"
printf 'sanitized-failure fixture\n' > "$work/media/sanitized.mp4"
printf 'noisy-diagnostics fixture\n' > "$work/media/noisy.mp4"
printf 'runtime-failure fixture\n' > "$work/media/runtime.mp4"
printf 'no-audio fixture\n' > "$work/media/no-audio.mp4"
printf 'audio-runtime-failure fixture\n' > "$work/media/audio-runtime.mp4"
printf 'audio-finite fixture\n' > "$work/media/audio-finite.mp4"
printf 'finite-media fixture\n' > "$work/media/finite-media.mp4"

check_response() {
	python3 - "$1" "$2" <<'PY'
from pathlib import Path
import sys

payload = Path(sys.argv[1]).read_bytes()
head, marker, body = payload.partition(b"\r\n\r\n")
assert marker, "CGI response has no CRLF header terminator"

lines = head.decode("ascii").split("\r\n")
assert lines[0] == "Status: 200 OK", lines[0]

headers = dict(line.split(": ", 1) for line in lines[1:])
assert headers["Content-Type"] == "image/jpeg"
assert headers["Cache-Control"].startswith("no-store")

length = int(headers["Content-Length"])

if sys.argv[2] == "GET":
	assert body == b"\xff\xd8\xff\xd9", body
	assert length == len(body)
else:
	assert body == b"", body
	assert length == 4
PY
}

check_audio_response() {
	python3 - "$1" "$2" <<'PY'
from pathlib import Path
import sys

payload = Path(sys.argv[1]).read_bytes()
head, marker, body = payload.partition(b"\r\n\r\n")
assert marker, "audio CGI response has no CRLF header terminator"
lines = head.decode("ascii").split("\r\n")
assert lines[0] == "Status: 200 OK", lines[0]
headers = dict(line.split(": ", 1) for line in lines[1:])
assert headers["Content-Type"] == "application/octet-stream"
assert headers["Content-Length"] == "48000"
assert headers["Accept-Ranges"] == "none"
assert headers["X-Videoplayer-Audio-Format"] == "s16le"
assert headers["X-Videoplayer-Audio-Sample-Rate"] == "48000"
assert headers["X-Videoplayer-Audio-Channels"] == "2"
assert headers["X-Videoplayer-Audio-Frames"] == "12000"
sequence = int(headers["X-Videoplayer-Audio-Sequence"])
if sys.argv[2] == "GET":
	assert len(body) == 48000, len(body)
	assert body == bytes([sequence & 0xff]) * 48000
else:
	assert body == b"", len(body)
print(sequence)
PY
}

check_status_line() {
	python3 - "$1" "$2" <<'PY'
from pathlib import Path
import sys

line = (
	Path(sys.argv[1])
	.read_bytes()
	.split(b"\r\n", 1)[0]
	.decode("ascii")
)
assert line == f"Status: {sys.argv[2]}", line
PY
}

wait_dead() {
	local pid="$1" state i

	for ((i = 0; i < 100; ++i)); do
		[[ -r "/proc/$pid/stat" ]] || return 0

		state="$(
			awk '{print $3}' "/proc/$pid/stat" 2>/dev/null || true
		)"

		[[ "$state" == Z || "$state" == X ]] && return 0
		sleep 0.05
	done

	fail "process $pid survived stop/cleanup"
}

session_pid() {
	[[ -f "$runtime/s-$1/$2" ]] ||
		fail "missing $2 identity for session $1"
	sed -n '3p' "$runtime/s-$1/$2"
}

inspect_audio_ring() {
	local token="$1" path size metadata

	AUDIO_FILE_COUNT=0
	AUDIO_STAGED_COUNT=0
	AUDIO_TOTAL_BYTES=0
	for path in "$runtime/s-$token"/audio-????????.pcm; do
		[[ -f "$path" && ! -L "$path" ]] || continue
		size="$(stat -c '%s' -- "$path" 2>/dev/null)" || continue
		[[ "$size" -eq 48000 ]] ||
			fail "audio ring contains a partial segment: $path ($size bytes)"
		AUDIO_FILE_COUNT=$((AUDIO_FILE_COUNT + 1))
		AUDIO_TOTAL_BYTES=$((AUDIO_TOTAL_BYTES + size))
	done
	for path in "$runtime/s-$token"/.audio-????????.*; do
		[[ -e "$path" || -L "$path" ]] || continue
		[[ -f "$path" && ! -L "$path" ]] ||
			fail "audio ring contains an unsafe staging file: $path"
		metadata="$(stat -c '%u:%a:%s' -- "$path" 2>/dev/null)" || continue
		size="${metadata##*:}"
		[[ "$size" -ge 0 && "$size" -le 48000 ]] ||
			fail "audio staging file exceeded one segment: $path ($size bytes)"
		[[ "${metadata%:*}" == 0:600 ]] ||
			fail "audio staging file has unsafe ownership or mode: $path"
		AUDIO_STAGED_COUNT=$((AUDIO_STAGED_COUNT + 1))
		AUDIO_TOTAL_BYTES=$((AUDIO_TOTAL_BYTES + size))
	done
	[[ "$AUDIO_STAGED_COUNT" -le 1 ]] ||
		fail "audio ring contains multiple staging files: $AUDIO_STAGED_COUNT"
	[[ "$AUDIO_FILE_COUNT" -le 32 ]] ||
		fail "audio ring exceeded its hard bound: $AUDIO_FILE_COUNT"
}

assert_audio_storage_bound() {
	[[ $((AUDIO_FILE_COUNT + AUDIO_STAGED_COUNT)) -le 32 ]] ||
		fail "audio staging exceeded the 32-slot hard bound"
	[[ "$AUDIO_TOTAL_BYTES" -le $((32 * 48000)) ]] ||
		fail "audio storage exceeded its byte bound: $AUDIO_TOTAL_BYTES"
}

run_cgi() {
	REQUEST_METHOD="$1" \
	QUERY_STRING="token=$2&frame=$3" \
		"$helper" cgi > "$4"
}

run_audio_cgi() {
	REQUEST_METHOD="$1" \
	QUERY_STRING="token=$2&chunk=$3" \
		"$helper" cgi-audio > "$4"
}

token1=0123456789abcdef0123456789abcdef
token2=fedcba9876543210fedcba9876543210
missing_decoder=11111111111111111111111111111111
modern_decoder=12121212121212121212121212121212
boundary_decoder=1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a
v4l2_decoder=13131313131313131313131313131313
noisy_v4l2=14141414141414141414141414141414
unknown_failure=15151515151515151515151515151515
empty_diagnostics=16161616161616161616161616161616
unsupported_option=17171717171717171717171717171717
v4l2_permission=18181818181818181818181818181818
sanitized_failure=19191919191919191919191919191919
noisy_diagnostics=22222222222222222222222222222222
runtime_failure=33333333333333333333333333333333
no_audio=34343434343434343434343434343434
audio_failure=35353535353535353535353535353535
finite_audio=36363636363636363636363636363636
chunker_failure=37373737373737373737373737373737
finite_media=38383838383838383838383838383838
stale=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
media="$work/media/bad apple.mp4"

assert_eq "$("$helper" probe)" available "system FFmpeg fallback probe"

mkdir -m 0755 -- "$work/private-libexec"
mkdir -m 0755 -- "$private_exec_dir"
cp -- "$bin/ffmpeg" "$private_ffmpeg"
chmod 0755 "$private_ffmpeg"

# A static or mostly static companion is usable without an artificial empty
# private library directory, and takes precedence over a broken system FFmpeg.
export VIDEOPLAYER_EXPECT_PRIVATE_LIB=""
mv -- "$bin/ffmpeg" "$bin/ffmpeg.good"
cat > "$bin/ffmpeg" <<'SH'
#!/bin/sh
: > "$VIDEOPLAYER_SYSTEM_FAIL_MARKER"
exit 81
SH
chmod 0755 "$bin/ffmpeg"
export VIDEOPLAYER_SYSTEM_FAIL_MARKER="$work/static-system-probe-used"
rm -f -- "$VIDEOPLAYER_SYSTEM_FAIL_MARKER"
assert_eq "$("$helper" probe)" available "static private FFmpeg preference"
[[ ! -e "$VIDEOPLAYER_SYSTEM_FAIL_MARKER" ]] ||
	fail "system FFmpeg was probed despite a usable static private runtime"
mv -f -- "$bin/ffmpeg.good" "$bin/ffmpeg"

mkdir -m 0755 -- "$work/private-lib"
mkdir -m 0755 -- "$private_lib_dir"
printf 'private library fixture\n' > "$private_lib_dir/libfixture.so"
chmod 0644 "$private_lib_dir/libfixture.so"

# A valid but unusable private runtime is tried first, then the system FFmpeg
# remains available as a capability-checked fallback.
mv -- "$private_ffmpeg" "$private_ffmpeg.good"
cat > "$private_ffmpeg" <<'SH'
#!/bin/sh
: > "$VIDEOPLAYER_PRIVATE_FAIL_MARKER"
exit 80
SH
chmod 0755 "$private_ffmpeg"
export VIDEOPLAYER_PRIVATE_FAIL_MARKER="$work/private-probe-failed"
export VIDEOPLAYER_EXPECT_PRIVATE_LIB=""
assert_eq "$("$helper" probe)" available "private FFmpeg probe fallback"
[[ -f "$VIDEOPLAYER_PRIVATE_FAIL_MARKER" ]] ||
	fail "private FFmpeg was not probed before system fallback"
mv -f -- "$private_ffmpeg.good" "$private_ffmpeg"

# Once the private runtime passes its probes, a broken system executable must
# not be touched.
mv -- "$bin/ffmpeg" "$bin/ffmpeg.good"
cat > "$bin/ffmpeg" <<'SH'
#!/bin/sh
: > "$VIDEOPLAYER_SYSTEM_FAIL_MARKER"
exit 81
SH
chmod 0755 "$bin/ffmpeg"
export VIDEOPLAYER_SYSTEM_FAIL_MARKER="$work/system-probe-used"
export VIDEOPLAYER_EXPECT_PRIVATE_LIB="$private_lib_dir"
rm -f -- "$VIDEOPLAYER_SYSTEM_FAIL_MARKER"
assert_eq "$("$helper" probe)" available "private FFmpeg preference"
[[ ! -e "$VIDEOPLAYER_SYSTEM_FAIL_MARKER" ]] ||
	fail "system FFmpeg was probed despite a usable private runtime"
mv -f -- "$bin/ffmpeg.good" "$bin/ffmpeg"

# An unsafe private library directory is ignored instead of being added to the
# root renderer's loader path.
mv -- "$private_ffmpeg" "$private_ffmpeg.good"
cat > "$private_ffmpeg" <<'SH'
#!/bin/sh
: > "$VIDEOPLAYER_UNSAFE_PRIVATE_MARKER"
exit 82
SH
chmod 0755 "$private_ffmpeg"
chmod 0777 "$private_lib_dir"
export VIDEOPLAYER_UNSAFE_PRIVATE_MARKER="$work/unsafe-private-used"
export VIDEOPLAYER_EXPECT_PRIVATE_LIB=""
rm -f -- "$VIDEOPLAYER_UNSAFE_PRIVATE_MARKER"
assert_eq "$("$helper" probe)" available "unsafe private FFmpeg fallback"
[[ ! -e "$VIDEOPLAYER_UNSAFE_PRIVATE_MARKER" ]] ||
	fail "unsafe private FFmpeg runtime was executed"
chmod 0755 "$private_lib_dir"
mv -f -- "$private_ffmpeg.good" "$private_ffmpeg"

export VIDEOPLAYER_EXPECT_PRIVATE_LIB="$private_lib_dir"
assert_eq "$("$helper" probe)" available "final private FFmpeg probe"

set +e
missing_output="$("$helper" start "$missing_decoder" "$work/media/h264.mp4" 2>&1)"
missing_rc=$?
set -e

assert_eq "$missing_rc" 1 "missing decoder exit code"
assert_eq \
	"$missing_output" \
	"Installed FFmpeg has no usable decoder for this video; use browser mode or install a decoder-enabled FFmpeg build" \
	"missing decoder classification"
assert_eq \
	"$("$helper" status "$missing_decoder")" \
	inactive \
	"missing decoder session cleanup"
[[ ! -e "$runtime/s-$missing_decoder/ffmpeg.log" &&
   ! -e "$runtime/s-$missing_decoder/ffmpeg-log.pipe" ]] ||
	fail "missing decoder diagnostics were not cleaned"

check_start_failure() {
	local token="$1" path="$2" expected="$3" label="$4"
	local output rc

	set +e
	output="$("$helper" start "$token" "$path" 2>&1)"
	rc=$?
	set -e

	assert_eq "$rc" 1 "$label exit code"
	assert_eq "$output" "$expected" "$label classification"
	assert_eq "$("$helper" status "$token")" inactive "$label cleanup"
	[[ ! -e "$runtime/s-$token/ffmpeg.log" &&
	   ! -e "$runtime/s-$token/ffmpeg-log.pipe" ]] ||
		fail "$label diagnostics were not cleaned"
}

check_start_failure \
	"$modern_decoder" \
	"$work/media/h264-modern.mp4" \
	"Installed FFmpeg has no usable decoder for this video; use browser mode or install a decoder-enabled FFmpeg build" \
	"modern missing decoder"
check_start_failure \
	"$boundary_decoder" \
	"$work/media/h264-boundary.mp4" \
	"Installed FFmpeg has no usable decoder for this video; use browser mode or install a decoder-enabled FFmpeg build" \
	"decoder diagnostic crossing the head-tail boundary"
check_start_failure \
	"$v4l2_decoder" \
	"$work/media/h264-v4l2.mp4" \
	"Installed FFmpeg has no usable decoder for this video; use browser mode or install a decoder-enabled FFmpeg build" \
	"unusable V4L2 decoder"
check_start_failure \
	"$noisy_v4l2" \
	"$work/media/noisy-v4l2.mp4" \
	"Installed FFmpeg has no usable decoder for this video; use browser mode or install a decoder-enabled FFmpeg build" \
	"V4L2 decoder after noisy diagnostics"
check_start_failure \
	"$unknown_failure" \
	"$work/media/unknown.mp4" \
	"FFmpeg reported: Demuxer exploded for test fixture" \
	"unknown FFmpeg diagnostic"
check_start_failure \
	"$empty_diagnostics" \
	"$work/media/empty.mp4" \
	"FFmpeg exited without diagnostic output" \
	"empty FFmpeg diagnostic"
check_start_failure \
	"$unsupported_option" \
	"$work/media/unsupported-option.mp4" \
	"Installed FFmpeg does not support an option required by the renderer" \
	"unsupported FFmpeg option"
check_start_failure \
	"$v4l2_permission" \
	"$work/media/v4l2-permission.mp4" \
	"FFmpeg was denied access to the decoder, source, or temporary output" \
	"V4L2 decoder permission failure"

set +e
sanitized_output="$(
	"$helper" start \
		"$sanitized_failure" \
		"$work/media/sanitized.mp4" 2>&1
)"
sanitized_rc=$?
set -e
assert_eq "$sanitized_rc" 1 "sanitized diagnostic exit code"
[[ "$sanitized_output" == \
   "FFmpeg reported: ?[decoder @ 0xADDR] detailed?problem: "* ]] ||
	fail "sanitized diagnostic lost its meaningful error: $sanitized_output"
[[ "$sanitized_output" == *... ]] ||
	fail "sanitized diagnostic was not truncated: $sanitized_output"
[[ "${#sanitized_output}" -le 160 ]] ||
	fail "sanitized diagnostic exceeded status limit: ${#sanitized_output}"
[[ "$sanitized_output" != *deadbeef* &&
   "$sanitized_output" != *private* &&
   "$sanitized_output" != *"Conversion failed"* ]] ||
	fail "sanitized diagnostic exposed an address, path, or FFmpeg epilogue"
assert_eq \
	"$("$helper" status "$sanitized_failure")" \
	inactive \
	"sanitized diagnostic cleanup"

assert_eq \
	"$("$helper" start "$noisy_diagnostics" "$work/media/noisy.mp4")" \
	started \
	"large diagnostic stream does not stop playback"
assert_eq \
	"$("$helper" status "$noisy_diagnostics")" \
	running \
	"status after large diagnostic stream"
diagnostic_size="$(stat -c '%s' "$runtime/s-$noisy_diagnostics/ffmpeg.log")"
[[ "$diagnostic_size" -gt 0 && "$diagnostic_size" -le 65536 ]] ||
	fail "diagnostic capture exceeded its 64 KiB limit: $diagnostic_size"
assert_eq \
	"$("$helper" stop "$noisy_diagnostics")" \
	stopped \
	"stop after large diagnostic stream"
[[ ! -e "$runtime/s-$noisy_diagnostics/ffmpeg.log" &&
   ! -e "$runtime/s-$noisy_diagnostics/ffmpeg-log.pipe" ]] ||
	fail "large diagnostic stream artifacts were not cleaned"

assert_eq \
	"$("$helper" start "$runtime_failure" "$work/media/runtime.mp4")" \
	started \
	"runtime failure starts after its first frame"
for _ in {1..160}; do
	[[ "$("$helper" status "$runtime_failure")" == error ]] && break
	sleep 0.05
done
assert_eq \
	"$("$helper" status "$runtime_failure")" \
	error \
	"runtime failure status"
assert_eq \
	"$("$helper" reason "$runtime_failure")" \
	"FFmpeg ran out of memory while decoding this video" \
	"runtime failure reason"
assert_eq \
	"$("$helper" stop "$runtime_failure")" \
	stopped \
	"stop after runtime failure"

# Missing or undecodable audio is nonfatal: video remains available and the
# dedicated audio endpoint reports the optional track as unavailable.
assert_eq \
	"$("$helper" start "$no_audio" "$work/media/no-audio.mp4")" \
	started \
	"video-only start"
assert_eq "$("$helper" has-audio "$no_audio")" 0 "video-only audio capability"
run_cgi GET "$no_audio" 1 "$work/response"
check_response "$work/response" GET
run_audio_cgi GET "$no_audio" live "$work/audio-response"
check_status_line "$work/audio-response" "409 Conflict"
assert_eq "$("$helper" status "$no_audio")" running "video-only status"
assert_eq "$("$helper" stop "$no_audio")" stopped "video-only stop"

# A finite audio track may close the FIFO just before its FFmpeg child exits.
# Both zero exit codes must publish the final complete chunks as ended audio.
assert_eq \
	"$("$helper" start "$finite_audio" "$work/media/audio-finite.mp4")" \
	started \
	"finite-audio start"
finite_worker="$(session_pid "$finite_audio" worker)"
finite_ffmpeg="$(session_pid "$finite_audio" ffmpeg)"
for _ in {1..100}; do
	[[ "$(sed -n '2p' "$runtime/s-$finite_audio/audio-state")" == ended ]] &&
		break
	sleep 0.05
done
assert_eq \
	"$(sed -n '2p' "$runtime/s-$finite_audio/audio-state")" \
	ended \
	"finite-audio final state"
assert_eq "$("$helper" has-audio "$finite_audio")" 1 "finite-audio capability"
run_audio_cgi GET "$finite_audio" live "$work/audio-response"
check_audio_response "$work/audio-response" GET >/dev/null
assert_eq "$("$helper" status "$finite_audio")" running "finite-audio video status"
assert_eq "$("$helper" stop "$finite_audio")" stopped "finite-audio stop"
wait_dead "$finite_worker"
wait_dead "$finite_ffmpeg"

# Once video reaches EOF, completed PCM chunks remain readable without a live
# worker. This gives the browser time to fetch and drain the synchronized tail.
assert_eq \
	"$("$helper" start "$finite_media" "$work/media/finite-media.mp4")" \
	started \
	"finite-media start"
finite_media_worker="$(session_pid "$finite_media" worker)"
finite_media_ffmpeg="$(session_pid "$finite_media" ffmpeg)"
for _ in {1..120}; do
	[[ "$("$helper" status "$finite_media")" == ended ]] && break
	sleep 0.05
done
assert_eq "$("$helper" status "$finite_media")" ended "finite-media status"
wait_dead "$finite_media_worker"
wait_dead "$finite_media_ffmpeg"
assert_eq \
	"$(sed -n '2p' "$runtime/s-$finite_media/audio-state")" \
	ended \
	"finite-media audio state"
run_audio_cgi GET "$finite_media" live "$work/audio-response"
finite_media_audio_sequence="$(
	check_audio_response "$work/audio-response" GET
)"
run_audio_cgi \
	GET "$finite_media" "$((finite_media_audio_sequence + 1))" \
	"$work/audio-response"
check_status_line "$work/audio-response" "204 No Content"
assert_eq "$("$helper" stop "$finite_media")" stopped "finite-media stop"

# A child that fails after publishing audio must not poison the independent
# video renderer or force browser fallback.
assert_eq \
	"$("$helper" start "$audio_failure" "$work/media/audio-runtime.mp4")" \
	started \
	"audio-failure start"
for _ in {1..60}; do
	[[ "$("$helper" has-audio "$audio_failure")" == 0 ]] && break
	sleep 0.05
done
assert_eq "$("$helper" has-audio "$audio_failure")" 0 "audio-failure state"
assert_eq "$("$helper" status "$audio_failure")" running "audio-failure video status"
run_cgi GET "$audio_failure" 1 "$work/response"
check_response "$work/response" GET
assert_eq "$("$helper" stop "$audio_failure")" stopped "audio-failure stop"

# Killing only the chunker must make the optional audio track fail closed,
# stop its FIFO writer, preserve video playback, and leave bounded storage.
assert_eq \
	"$("$helper" start "$chunker_failure" "$media")" \
	started \
	"chunker-failure start"
chunker_failure_worker="$(session_pid "$chunker_failure" worker)"
chunker_failure_ffmpeg="$(session_pid "$chunker_failure" ffmpeg)"
chunker_failure_audio="$(session_pid "$chunker_failure" audio)"
chunker_failure_chunker="$(session_pid "$chunker_failure" chunker)"
kill -KILL "$chunker_failure_chunker"
wait_dead "$chunker_failure_chunker"
for _ in {1..100}; do
	[[ "$("$helper" has-audio "$chunker_failure")" == 0 ]] && break
	sleep 0.05
done
assert_eq \
	"$("$helper" has-audio "$chunker_failure")" \
	0 \
	"chunker-failure audio state"
wait_dead "$chunker_failure_audio"
inspect_audio_ring "$chunker_failure"
assert_audio_storage_bound
chunker_failure_bytes="$AUDIO_TOTAL_BYTES"
sleep 0.5
inspect_audio_ring "$chunker_failure"
assert_audio_storage_bound
assert_eq \
	"$AUDIO_TOTAL_BYTES" \
	"$chunker_failure_bytes" \
	"audio growth after dead chunker"
assert_eq \
	"$("$helper" status "$chunker_failure")" \
	running \
	"chunker-failure video status"
run_cgi GET "$chunker_failure" 1 "$work/response"
check_response "$work/response" GET
assert_eq \
	"$("$helper" stop "$chunker_failure")" \
	stopped \
	"chunker-failure stop"
wait_dead "$chunker_failure_worker"
wait_dead "$chunker_failure_ffmpeg"

assert_eq "$("$helper" start "$token1" "$media")" started "start"
assert_eq "$("$helper" status "$token1")" running "status after start"

assert_eq \
	"$(stat -c '%u:%a' -- "$runtime")" \
	0:700 \
	"runtime permissions"

assert_eq \
	"$(stat -c '%u:%a' -- "$runtime/s-$token1/frame.jpg")" \
	0:600 \
	"frame permissions"

worker1="$(session_pid "$token1" worker)"
ffmpeg1="$(session_pid "$token1" ffmpeg)"
audio1="$(session_pid "$token1" audio)"
chunker1="$(session_pid "$token1" chunker)"
kill -0 "$worker1"
kill -0 "$ffmpeg1"
kill -0 "$audio1"
kill -0 "$chunker1"
assert_eq \
	"$(tr '\000' '\n' < "/proc/$ffmpeg1/cmdline" | sed -n '1p')" \
	"$private_ffmpeg" \
	"private FFmpeg process identity"
assert_eq \
	"$(tr '\000' '\n' < "/proc/$audio1/cmdline" | tail -n 1)" \
	"$runtime/s-$token1/audio.pipe" \
	"audio FFmpeg process identity"
assert_eq \
	"$(tr '\000' '\n' < "/proc/$chunker1/cmdline" | sed -n '3p')" \
	audio-chunker \
	"audio chunker process identity"
assert_eq "$("$helper" has-audio "$token1")" 1 "audio capability"

# The producer runs faster than the worker's one-second supervision loop.
# Repeatedly sample through saturation to prove the chunker, not the worker,
# enforces the 32-segment hard bound and only publishes complete chunks.
ring_saturated=0
for _ in {1..100}; do
	inspect_audio_ring "$token1"
	[[ "$AUDIO_FILE_COUNT" -eq 32 ]] && ring_saturated=1
	[[ "$ring_saturated" -eq 1 ]] && break
	sleep 0.05
done
[[ "$ring_saturated" -eq 1 ]] ||
	fail "audio ring did not reach the hard-bound test condition"
kill -STOP "$chunker1"
sleep 0.05
inspect_audio_ring "$token1"
hard_bound_count=$((AUDIO_FILE_COUNT + AUDIO_STAGED_COUNT))
hard_bound_bytes="$AUDIO_TOTAL_BYTES"
kill -CONT "$chunker1"
[[ "$hard_bound_count" -le 32 ]] ||
	fail "paused audio ring exceeded 32 storage slots: $hard_bound_count"
[[ "$hard_bound_bytes" -le $((32 * 48000)) ]] ||
	fail "paused audio ring exceeded its byte bound: $hard_bound_bytes"

heartbeat="$runtime/s-$token1/heartbeat"
before="$(< "$heartbeat")"

while [[ "$(date +%s)" -le "$before" ]]; do
	sleep 0.05
done

run_cgi GET "$token1" 1-1 "$work/response"
check_response "$work/response" GET

after="$(< "$heartbeat")"
[[ "$after" -gt "$before" ]] || fail "GET did not refresh heartbeat"

for _ in {1..30}; do
	run_audio_cgi GET "$token1" live "$work/audio-response"
	if head -c 15 "$work/audio-response" | grep -q 'Status: 200 OK'; then
		break
	fi
	sleep 0.1
done
audio_sequence="$(check_audio_response "$work/audio-response" GET)"
assert_eq \
	"$(stat -c '%u:%a' -- "$runtime/s-$token1/audio-$(printf '%08d' "$audio_sequence").pcm")" \
	0:600 \
	"audio segment permissions"

before="$(< "$heartbeat")"
run_audio_cgi HEAD "$token1" "$audio_sequence" "$work/audio-response"
assert_eq \
	"$(check_audio_response "$work/audio-response" HEAD)" \
	"$audio_sequence" \
	"audio HEAD sequence"
assert_eq "$(< "$heartbeat")" "$before" "audio HEAD heartbeat"

HTTP_RANGE='bytes=0-3' \
REQUEST_METHOD=GET \
QUERY_STRING="token=$token1&chunk=$audio_sequence" \
	"$helper" cgi-audio > "$work/audio-response"
check_status_line "$work/audio-response" "416 Range Not Satisfiable"
assert_eq "$(< "$heartbeat")" "$before" "audio Range heartbeat"

# Repeated requests exercise atomic frame replacements.
for sequence in 2 3 4 5 6; do
	run_cgi GET "$token1" "$sequence" "$work/response"
	check_response "$work/response" GET
done

before="$(< "$heartbeat")"
run_cgi HEAD "$token1" 7 "$work/response"
check_response "$work/response" HEAD
assert_eq "$(< "$heartbeat")" "$before" "HEAD heartbeat"

set +e
stale_output="$("$helper" stop "$stale" 2>&1)"
stale_rc=$?
set -e

assert_eq "$stale_rc" 2 "stale stop exit code"
assert_eq "$stale_output" stale "stale stop output"
assert_eq \
	"$("$helper" status "$token1")" \
	running \
	"stale stop isolation"

assert_eq "$("$helper" stop "$token1")" stopped "exact stop"
assert_eq "$("$helper" status "$token1")" inactive "status after stop"

wait_dead "$worker1"
wait_dead "$ffmpeg1"
wait_dead "$audio1"
wait_dead "$chunker1"

# Exercise recovery after the wrapper dies without running its signal trap.
assert_eq "$("$helper" start "$token2" "$media")" started "second start"

worker2="$(session_pid "$token2" worker)"
ffmpeg2="$(session_pid "$token2" ffmpeg)"
audio2="$(session_pid "$token2" audio)"
chunker2="$(session_pid "$token2" chunker)"

assert_eq \
	"$("$helper" status "$token2")" \
	running \
	"status before crash"

kill -KILL "$worker2"
wait_dead "$worker2"

# The chunker's worker-liveness watchdog closes the FIFO after an untrappable
# worker crash. That must terminate both audio processes without waiting for a
# later cleanup request, and the bounded ring must stop changing.
wait_dead "$chunker2"
wait_dead "$audio2"
inspect_audio_ring "$token2"
assert_audio_storage_bound
crash_audio_count="$AUDIO_FILE_COUNT"
crash_audio_bytes="$AUDIO_TOTAL_BYTES"
sleep 0.5
inspect_audio_ring "$token2"
assert_audio_storage_bound
assert_eq \
	"$AUDIO_FILE_COUNT:$AUDIO_TOTAL_BYTES" \
	"$crash_audio_count:$crash_audio_bytes" \
	"audio ring growth after dead worker"

assert_eq \
	"$("$helper" status "$token2")" \
	error \
	"dead-worker status"

before="$(< "$runtime/s-$token2/heartbeat")"
run_cgi GET "$token2" 8 "$work/response"
check_status_line "$work/response" "503 Service Unavailable"

assert_eq \
	"$(< "$runtime/s-$token2/heartbeat")" \
	"$before" \
	"failed CGI heartbeat"

# Video FFmpeg is independent and remains for identity-based cleanup.
kill -0 "$ffmpeg2"

"$helper" cleanup
wait_dead "$ffmpeg2"

[[ ! -e "$runtime" && ! -L "$runtime" ]] ||
	fail "cleanup left runtime state"

assert_eq \
	"$("$helper" status "$token2")" \
	inactive \
	"status after cleanup"

printf 'renderer lifecycle test: OK\n'
