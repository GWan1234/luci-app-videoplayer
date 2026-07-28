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
		"${worker1:-}" "${ffmpeg1:-}" \
		"${worker2:-}" "${ffmpeg2:-}"
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

sed \
	-e "s|export PATH=\"/usr/sbin:/usr/bin:/sbin:/bin\"|export PATH=\"$bin:/usr/sbin:/usr/bin:/sbin:/bin\"|" \
	-e "s|/tmp/videoplayer-render-v1|$runtime|g" \
	-e "s|/usr/libexec/videoplayer-renderer|$helper|g" \
	"$source_helper" > "$helper"

chmod 0755 "$helper"

! grep -Fq '/tmp/videoplayer-render-v1' "$helper" ||
	fail "runtime transform incomplete"
! grep -Fq '/usr/libexec/videoplayer-renderer' "$helper" ||
	fail "self-path transform incomplete"

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

static int output_is_safe(const char *output)
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
	       ends_with(output, "/frame.jpg");
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

int main(int argc, char **argv)
{
	struct stat input;
	char marker[32] = {0};
	const char *output;
	int fail_after_first_frame;
	int line;
	ssize_t marker_size;

	if (has_arg(argc, argv, "-encoders")) {
		puts(" V..... mjpeg CI stub");
		return 0;
	}

	if (has_arg(argc, argv, "-muxers")) {
		puts(" E image2 CI stub");
		return 0;
	}

	if (has_arg(argc, argv, "-filters")) {
		puts(" ... fps V->V CI stub");
		puts(" ... scale V->V CI stub");
		puts(" ... format V->V CI stub");
		return 0;
	}

	errno = 0;
	if (argc < 2 ||
	    count_pair(argc, argv, "-threads", "1") < 2 ||
	    count_pair(argc, argv, "-filter_threads", "1") != 1 ||
	    count_pair(argc, argv, "-protocol_whitelist", "file,pipe") != 1 ||
	    count_pair(argc, argv, "-fflags", "+genpts") != 1 ||
	    count_pair(argc, argv, "-err_detect", "ignore_err") != 1 ||
	    count_pair(argc, argv, "-i", "/proc/self/fd/3") != 1 ||
	    count_pair(argc, argv, "-map", "0:V:0") != 1 ||
	    count_pair(
		    argc,
		    argv,
		    "-vf",
		    "fps=3,scale=640:360:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=fast_bilinear,format=yuvj420p") != 1 ||
	    count_pair(argc, argv, "-c:v", "mjpeg") != 1 ||
	    count_pair(argc, argv, "-f", "image2") != 1 ||
	    count_pair(argc, argv, "-update", "1") != 1 ||
	    count_pair(argc, argv, "-atomic_writing", "1") != 1 ||
	    !has_arg(argc, argv, "-nostdin") ||
	    !has_arg(argc, argv, "-re") ||
	    fstat(3, &input) != 0 ||
	    !S_ISREG(input.st_mode) ||
	    input.st_size <= 0 ||
	    fcntl(8, F_GETFD) != -1 ||
	    errno != EBADF)
		return 64;

	output = argv[argc - 1];
	if (!output_is_safe(output))
		return 65;

	marker_size = pread(3, marker, sizeof(marker) - 1, 0);
	if (marker_size < 0)
		return 67;
	if (marker_size >= 15 && memcmp(marker, "decoder-missing", 15) == 0) {
		fputs(
			"Decoder (codec h264) not found for input stream #0:0\n",
			stderr);
		return 68;
	}
	if (marker_size >= 17 && memcmp(marker, "noisy-diagnostics", 17) == 0) {
		for (line = 0; line < 4096; line++)
			fputs(
				"recoverable decoder diagnostic that must not stop playback\n",
				stderr);
		fflush(stderr);
	}
	fail_after_first_frame =
		marker_size >= 15 && memcmp(marker, "runtime-failure", 15) == 0;

	signal(SIGTERM, stop);
	signal(SIGINT, stop);
	signal(SIGHUP, stop);

	while (running) {
		if (publish(output) != 0)
			return 66;
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
printf 'noisy-diagnostics fixture\n' > "$work/media/noisy.mp4"
printf 'runtime-failure fixture\n' > "$work/media/runtime.mp4"

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
	sed -n '3p' "$runtime/s-$1/$2"
}

run_cgi() {
	REQUEST_METHOD="$1" \
	QUERY_STRING="token=$2&frame=$3" \
		"$helper" cgi > "$4"
}

token1=0123456789abcdef0123456789abcdef
token2=fedcba9876543210fedcba9876543210
missing_decoder=11111111111111111111111111111111
noisy_diagnostics=22222222222222222222222222222222
runtime_failure=33333333333333333333333333333333
stale=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
media="$work/media/bad apple.mp4"

assert_eq "$("$helper" probe)" available "probe"

set +e
missing_output="$("$helper" start "$missing_decoder" "$work/media/h264.mp4" 2>&1)"
missing_rc=$?
set -e

assert_eq "$missing_rc" 1 "missing decoder exit code"
assert_eq \
	"$missing_output" \
	"Installed FFmpeg has no decoder for this video codec" \
	"missing decoder classification"
assert_eq \
	"$("$helper" status "$missing_decoder")" \
	inactive \
	"missing decoder session cleanup"
[[ ! -e "$runtime/s-$missing_decoder/ffmpeg.log" &&
   ! -e "$runtime/s-$missing_decoder/ffmpeg-log.pipe" ]] ||
	fail "missing decoder diagnostics were not cleaned"

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
kill -0 "$worker1"
kill -0 "$ffmpeg1"

heartbeat="$runtime/s-$token1/heartbeat"
before="$(< "$heartbeat")"

while [[ "$(date +%s)" -le "$before" ]]; do
	sleep 0.05
done

run_cgi GET "$token1" 1-1 "$work/response"
check_response "$work/response" GET

after="$(< "$heartbeat")"
[[ "$after" -gt "$before" ]] || fail "GET did not refresh heartbeat"

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

# Exercise recovery after the wrapper dies without running its signal trap.
assert_eq "$("$helper" start "$token2" "$media")" started "second start"

worker2="$(session_pid "$token2" worker)"
ffmpeg2="$(session_pid "$token2" ffmpeg)"

assert_eq \
	"$("$helper" status "$token2")" \
	running \
	"status before crash"

kill -KILL "$worker2"
wait_dead "$worker2"

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

# FFmpeg stays alive until cleanup finds it by its recorded identity.
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
