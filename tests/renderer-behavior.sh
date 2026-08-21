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
source_stream="$repo_root/luci-app-videoplayer/root/www/cgi-bin/videoplayer-stream"
source_rpc="$repo_root/luci-app-videoplayer/root/usr/libexec/rpcd/luci.videoplayer"
source_relay="$repo_root/codec-runtime/package/src/videoplayer-mjpeg-relay.c"
source_codec_makefile="$repo_root/codec-runtime/package/Makefile"
[[ -f "$source_helper" ]] || fail "renderer helper not found"
[[ -f "$source_stream" ]] || fail "stream CGI not found"
[[ -f "$source_rpc" ]] || fail "rpcd backend not found"
[[ -f "$source_relay" ]] || fail "MJPEG relay source not found"
[[ -f "$source_codec_makefile" ]] || fail "codec package Makefile not found"

for tool in cc flock python3 readelf readlink sed stat timeout; do
	command -v "$tool" >/dev/null || fail "$tool is required"
done

grep -Fq "\$(TARGET_LDFLAGS) -static-libgcc -Wl,-z,relro" \
	"$source_codec_makefile" ||
	fail "MJPEG relay does not statically link compiler support routines"

work="$(mktemp -d /tmp/videoplayer-renderer-ci.XXXXXX)"
bin="$work/bin"
runtime="$work/runtime"
maintenance_file="$runtime.maintenance"
helper="$bin/videoplayer-renderer"
stream_helper="$bin/videoplayer-stream"
stream_token_dir="$work/stream-tokens"
rpc_harness="$work/luci.videoplayer"
rpc_renderer="$work/rpc-renderer"
rpc_call_log="$work/rpc-renderer.calls"
private_exec_dir="$work/private-libexec/videoplayer-ffmpeg"
private_lib_dir="$work/private-lib/videoplayer-ffmpeg"
private_ffmpeg="$private_exec_dir/ffmpeg"
private_info_dir="$work/private-share/luci-videoplayer-codec-runtime"
private_build_info="$private_info_dir/build-info"
host_relay="$bin/videoplayer-mjpeg-relay"
audio_capacity_race_ready="$work/audio-capacity-race.ready"
audio_capacity_race_release="$work/audio-capacity-race.release"
audio_capacity_race_once="$work/audio-capacity-race.once"
audio_capacity_race_arm="$work/audio-capacity-race.arm"
maintenance_pause_ready="$work/maintenance-pause.ready"
maintenance_pause_release="$work/maintenance-pause.release"
blocked_probe_ready="$work/blocked-probe.ready"
blocked_probe_release="$work/blocked-probe.release"
producer_identity_ready="$work/producer-identity.ready"
producer_identity_release="$work/producer-identity.release"
identity_unlink_race_hit="$work/identity-unlink-race.hit"

mkdir -m 0755 -- "$bin" "$work/media"

export VIDEOPLAYER_TEST_MEDIA_ROOT="$work/media"
export VIDEOPLAYER_TEST_RUNTIME="$runtime"
export VIDEOPLAYER_TEST_ROUTER_FPS=60
export VIDEOPLAYER_TEST_ROUTER_PROFILE=fast
export VIDEOPLAYER_TEST_ROUTER_MAX_THREADS=0
export VIDEOPLAYER_EXPECT_PROFILE=fast
export VIDEOPLAYER_EXPECT_FPS=8
VIDEOPLAYER_EXPECT_DECODER_THREADS="$(
	awk '/^cpu[0-9]+[[:space:]]/ { count++ } END { print count + 0 }' \
		/proc/stat 2>/dev/null
)" || VIDEOPLAYER_EXPECT_DECODER_THREADS=""
if [[ ! "$VIDEOPLAYER_EXPECT_DECODER_THREADS" =~ ^[0-9]+$ ]] ||
   [[ "$VIDEOPLAYER_EXPECT_DECODER_THREADS" -lt 1 ]]; then
	VIDEOPLAYER_EXPECT_DECODER_THREADS=2
elif [[ "$VIDEOPLAYER_EXPECT_DECODER_THREADS" -gt 4 ]]; then
	VIDEOPLAYER_EXPECT_DECODER_THREADS=4
fi
export VIDEOPLAYER_EXPECT_DECODER_THREADS
VIDEOPLAYER_BOUNDED_DECODER_THREADS="$VIDEOPLAYER_EXPECT_DECODER_THREADS"
export VIDEOPLAYER_BOUNDED_DECODER_THREADS
export VIDEOPLAYER_TEST_REQUIRE_NATIVE_RELAY=1
export VIDEOPLAYER_TEST_DELAY_CGI_IDENTITY=1
export VIDEOPLAYER_TEST_AUDIO_CAPACITY_RACE_READY="$audio_capacity_race_ready"
export VIDEOPLAYER_TEST_AUDIO_CAPACITY_RACE_RELEASE="$audio_capacity_race_release"
export VIDEOPLAYER_TEST_AUDIO_CAPACITY_RACE_ONCE="$audio_capacity_race_once"
export VIDEOPLAYER_TEST_AUDIO_CAPACITY_RACE_ARM="$audio_capacity_race_arm"
export VIDEOPLAYER_TEST_MAINTENANCE_READY="$maintenance_pause_ready"
export VIDEOPLAYER_TEST_MAINTENANCE_RELEASE="$maintenance_pause_release"
export VIDEOPLAYER_TEST_BLOCKED_PROBE_READY="$blocked_probe_ready"
export VIDEOPLAYER_TEST_BLOCKED_PROBE_RELEASE="$blocked_probe_release"
export VIDEOPLAYER_TEST_PRODUCER_IDENTITY_READY="$producer_identity_ready"
export VIDEOPLAYER_TEST_PRODUCER_IDENTITY_RELEASE="$producer_identity_release"

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

	[[ -n "${audio_capacity_race_release:-}" ]] &&
		: > "$audio_capacity_race_release"
	[[ -n "${blocked_probe_release:-}" ]] &&
		: > "$blocked_probe_release"
	[[ -n "${producer_identity_release:-}" ]] &&
		: > "$producer_identity_release"
	if [[ -x "$helper" ]]; then
		"$helper" maintenance-enter >/dev/null 2>&1 || true
		"$helper" cleanup >/dev/null 2>&1 || true
	fi

	for pid in \
		"${ring_fill_pid:-}" \
		"${audio_drain_pid:-}" "${fast_av_drain_pid:-}" \
		"${worker1:-}" "${ffmpeg1:-}" "${chunker1:-}" \
		"${worker2:-}" "${ffmpeg2:-}" "${chunker2:-}" \
		"${finite_worker:-}" "${finite_ffmpeg:-}" \
		"${finite_media_worker:-}" "${finite_audio_cgi:-}" \
		"${missing_audio_state_worker:-}" \
		"${long_audio_worker:-}" "${long_audio_ffmpeg:-}" \
		"${long_audio_cgi:-}" \
		"${identity_worker:-}" "${identity_ffmpeg:-}" \
		"${terminal_gap_worker:-}" "${terminal_gap_cgi:-}" \
		"${relay_trailer_writer:-}" "${relay_marker_writer:-}" \
		"${relay_partial_writer:-}" "${relay_partial_marker_writer:-}" \
		"${status_touch_race_pid:-}" \
		"${instant_worker:-}" "${delayed_worker:-}" \
		"${fast_worker:-}" "${fast_av_worker:-}" "${quality_worker:-}" \
		"${chunker_failure_worker:-}" "${chunker_failure_ffmpeg:-}" \
		"${chunker_failure_chunker:-}" "${chunker_failure_cgi:-}" \
		"${chunker_failure_video_cgi:-}" \
		"${audio_clean_eof_worker:-}" "${audio_clean_eof_video_cgi:-}" \
		"${maintenance_enter_pid:-}" \
		"${blocked_probe_start_pid:-}" "${blocked_probe_worker:-}" \
		"${blocked_probe_ffmpeg:-}" \
		"${producer_race_start_pid:-}" "${producer_race_worker:-}" \
		"${producer_race_ffmpeg:-}" \
		"${lease_touch_worker:-}" "${lease_expire_worker:-}"
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
# The inserted post-spawn pauses deterministically simulate a heavily
# preempted shell whose very short FFmpeg or terminal relay child exits before
# /proc can expose its start time.
grep -Fq 'export PATH="/usr/sbin:/usr/bin:/sbin:/bin"' "$source_helper" ||
	fail "unexpected PATH declaration"
grep -Fq '/tmp/videoplayer-render-v1' "$source_helper" ||
	fail "unexpected runtime declaration"
grep -Fq '/tmp/videoplayer-render-v1.maintenance' "$source_helper" ||
	fail "unexpected maintenance marker declaration"
grep -Fq '/usr/libexec/videoplayer-renderer' "$source_helper" ||
	fail "unexpected self path"
grep -Fq '/usr/libexec/videoplayer-ffmpeg/ffmpeg' "$source_helper" ||
	fail "unexpected private FFmpeg path"
grep -Fq '/usr/lib/videoplayer-ffmpeg' "$source_helper" ||
	fail "unexpected private FFmpeg library path"
grep -Fq '/usr/share/luci-videoplayer-codec-runtime/build-info' "$source_helper" ||
	fail "unexpected private FFmpeg build-info path"
grep -Fq 'MJPEG_SEGMENT_SECONDS=45' "$source_helper" ||
	fail "unexpected MJPEG segment duration"
grep -Fq 'MJPEG_HEADER_WAIT_SECONDS=10' "$source_helper" ||
	fail "unexpected post-boundary MJPEG header deadline"
grep -Fq 'VIDEO_DRAIN_TIMEOUT=120' "$source_helper" ||
	fail "unexpected terminal MJPEG drain deadline"
grep -Fq 'HEARTBEAT_TIMEOUT=90' "$source_helper" ||
	fail "unexpected renderer heartbeat timeout"
grep -Fq 'AUDIO_FRAMES_PER_CHUNK=48000' "$source_helper" ||
	fail "unexpected PCM chunk duration"
grep -Fq 'MAX_AUDIO_BYTES=192000' "$source_helper" ||
	fail "unexpected PCM chunk byte size"
grep -Fq 'AUDIO_RING_SEGMENTS=8' "$source_helper" ||
	fail "unexpected PCM ring size"
grep -Fq 'AUDIO_BATCH_MAX_SEGMENTS=2' "$source_helper" ||
	fail "unexpected PCM batch size"
# This is an exact source-code literal; the test must not evaluate arithmetic.
# shellcheck disable=SC2016
grep -Fq 'STARTUP_BUDGET_SECONDS=$((STARTUP_TIMEOUT + 2 * MEDIA_PROBE_TIMEOUT + AUDIO_PROBE_TIMEOUT + 3))' \
	"$source_helper" ||
	fail "startup budget does not include both independent media probes"
grep -Fq "nice -n \"\$nice_level\"" "$source_helper" ||
	fail "renderer no longer yields CPU to LuCI under contention"
if grep -Eq '(^|[[:space:]"])-(re|readrate[^[:space:]"]*)($|[[:space:]"])' \
	"$source_helper"; then
	fail "renderer contains an input wall-clock pacing option"
fi

# Keep thread selection portable across single-core and multi-core targets.
# Normal mode retains its conservative fallback; maximum-resource mode uses
# the whole supported online pool and fails closed when that inventory is bad.
thread_functions="$work/thread-functions.sh"
awk '
	/^renderer_online_threads\(\) \{/ { copying = 1 }
	copying { print }
	copying && /^}/ { closed++ }
	copying && closed == 2 { exit }
' "$source_helper" > "$thread_functions"
bash -s -- "$thread_functions" <<'BASH'
set -Eeuo pipefail
functions=$1
valid_decimal() {
	[[ "$1" =~ ^[0-9]+$ && ${#1} -le $2 ]]
}
# shellcheck source=/dev/null
. "$functions"
awk() { printf '%s\n' "$FAKE_CPU_COUNT"; }
FAKE_CPU_COUNT=1
[[ "$(renderer_online_threads 0)" == 1 ]]
FAKE_CPU_COUNT=4
[[ "$(renderer_online_threads 0)" == 4 ]]
FAKE_CPU_COUNT=64
[[ "$(renderer_online_threads 0)" == 4 ]]
FAKE_CPU_COUNT=invalid
[[ "$(renderer_online_threads 0)" == 2 ]]
FAKE_CPU_COUNT=1
[[ "$(renderer_online_threads 1)" == 1 ]]
FAKE_CPU_COUNT=8
[[ "$(renderer_online_threads 1)" == 8 ]]
FAKE_CPU_COUNT=64
[[ "$(renderer_online_threads 1)" == 64 ]]
FAKE_CPU_COUNT=128
[[ "$(renderer_online_threads 1)" == 64 ]]
FAKE_CPU_COUNT=1000
[[ "$(renderer_online_threads 1)" == 64 ]]
FAKE_CPU_COUNT=invalid
! renderer_online_threads 1 >/dev/null
[[ "$(renderer_decoder_threads 8 1)" == 8 ]]
[[ "$(renderer_decoder_threads 64 1)" == 16 ]]
[[ "$(renderer_decoder_threads 4 0)" == 4 ]]
BASH

# The production helper runs in BusyBox ash, whose `read -t` keeps the bounded
# between-frame handoff safe. Ubuntu's /bin/sh is dash and lacks that option;
# run only this disposable lifecycle copy under direct /bin/bash and extend the
# copy's strict interpreter identity allowlist accordingly.
# shellcheck disable=SC2016
sed \
	-e '1s|^#!/bin/sh$|#!/bin/bash|' \
	-e 's#/bin/sh|/bin/ash|sh|ash)#/bin/sh|/bin/ash|/bin/bash|sh|ash|bash)#g' \
	-e "s|export PATH=\"/usr/sbin:/usr/bin:/sbin:/bin\"|export PATH=\"$bin:/usr/sbin:/usr/bin:/sbin:/bin\"|" \
	-e "s|/tmp/videoplayer-render-v1|$runtime|g" \
	-e "s|/usr/libexec/videoplayer-renderer|$helper|g" \
	-e "s|/usr/libexec/videoplayer-ffmpeg/ffmpeg|$private_ffmpeg|g" \
	-e "s|/usr/libexec/videoplayer-ffmpeg/videoplayer-mjpeg-relay|$host_relay|g" \
	-e "s|/usr/lib/videoplayer-ffmpeg|$private_lib_dir|g" \
	-e "s|/usr/share/luci-videoplayer-codec-runtime/build-info|$private_build_info|g" \
	-e 's|MJPEG_SEGMENT_SECONDS=45|MJPEG_SEGMENT_SECONDS=2|' \
	-e '/^mjpeg_copy_aligned() {$/a\
if [ "${VIDEOPLAYER_TEST_REQUIRE_NATIVE_RELAY:-0}" = "1" ]; then\
\treturn 91\
fi' \
	-e '/^[[:space:]]*ffmpeg_pid=\$!$/a\
if [ -n "${VIDEOPLAYER_TEST_PRODUCER_IDENTITY_READY:-}" ] &&\
   [ -n "${VIDEOPLAYER_TEST_PRODUCER_IDENTITY_RELEASE:-}" ] &&\
   [ -e "$VIDEOPLAYER_TEST_PRODUCER_IDENTITY_READY.arm" ]; then\
\tprintf "%s\\n" "$ffmpeg_pid" > "$VIDEOPLAYER_TEST_PRODUCER_IDENTITY_READY"\
\twhile [ ! -e "$VIDEOPLAYER_TEST_PRODUCER_IDENTITY_RELEASE" ]; do\
\t\tsleep 0.01\
\tdone\
else\
\tsleep 0.05\
fi' \
	-e '/^renderer_online_threads() {$/a\
if [ -n "${VIDEOPLAYER_TEST_DECODER_THREADS:-}" ]; then\
\tprintf "%s\\n" "$VIDEOPLAYER_TEST_DECODER_THREADS"\
\treturn 0\
fi' \
	-e '/^terminate_worker() {$/a\
if [ "${VIDEOPLAYER_TEST_STOP_FAILURE:-0}" = "1" ]; then\
\treturn 1\
fi' \
	-e '/^[[:space:]]*if load_worker_identity "\$token" ffmpeg; then$/i\
if [ "${VIDEOPLAYER_TEST_IDENTITY_UNLINK_RACE:-0}" = "1" ]; then\
\trm -f -- "$RUNTIME_DIR/s-$token/ffmpeg"\
\t: > "$VIDEOPLAYER_TEST_IDENTITY_UNLINK_RACE_HIT"\
fi' \
	-e '/^[[:space:]]*# The maintenance marker is now the durable start gate\.$/a\
if [ "${VIDEOPLAYER_TEST_MAINTENANCE_PAUSE:-0}" = "1" ]; then\
\t: > "$VIDEOPLAYER_TEST_MAINTENANCE_READY"\
\twhile [ ! -e "$VIDEOPLAYER_TEST_MAINTENANCE_RELEASE" ]; do\
\t\tsleep 0.05\
\tdone\
fi' \
	-e '/^[[:space:]]*CGI_COPY_PID=\$!$/a\
if [ "${VIDEOPLAYER_TEST_DELAY_CGI_IDENTITY:-0}" = "1" ]; then\
\tsleep 0.05\
fi' \
	-e '/^[[:space:]]*load_audio_ack "\$token" || capacity_failed=1$/a\
if [ -n "${VIDEOPLAYER_TEST_AUDIO_CAPACITY_RACE_READY:-}" ] &&\
   [ -n "${VIDEOPLAYER_TEST_AUDIO_CAPACITY_RACE_RELEASE:-}" ] &&\
   [ -n "${VIDEOPLAYER_TEST_AUDIO_CAPACITY_RACE_ONCE:-}" ] &&\
   [ -n "${VIDEOPLAYER_TEST_AUDIO_CAPACITY_RACE_ARM:-}" ] &&\
   [ -e "$VIDEOPLAYER_TEST_AUDIO_CAPACITY_RACE_ARM" ] &&\
   [ ! -e "$VIDEOPLAYER_TEST_AUDIO_CAPACITY_RACE_ONCE" ]; then\
\t: > "$VIDEOPLAYER_TEST_AUDIO_CAPACITY_RACE_ONCE"\
\t: > "$VIDEOPLAYER_TEST_AUDIO_CAPACITY_RACE_READY"\
\twhile [ ! -e "$VIDEOPLAYER_TEST_AUDIO_CAPACITY_RACE_RELEASE" ]; do\
\t\tsleep 0.05\
\tdone\
fi' \
	-e '/^[[:space:]]*if ! finalize_audio_state "\$rc" "\$chunker_rc"; then$/i\
if [ -n "${VIDEOPLAYER_TEST_REMOVE_AUDIO_STATE_TOKEN:-}" ] &&\
   [ "$VIDEOPLAYER_TEST_REMOVE_AUDIO_STATE_TOKEN" = "$token" ]; then\
\trm -f -- "$dir/audio-state"\
fi' \
	-e '/^[[:space:]]*state="\$(cmd_status "\$token")" || return 1$/a\
if [ -n "${VIDEOPLAYER_TEST_STATUS_TOUCH_READY:-}" ]; then\
\t: > "$VIDEOPLAYER_TEST_STATUS_TOUCH_READY"\
\twhile [ ! -e "${VIDEOPLAYER_TEST_STATUS_TOUCH_RELEASE:-}" ]; do\
\t\tsleep 0.05\
\tdone\
fi' \
	-e '/^[[:space:]]*# Never let a competing or stalled browser consume another uhttpd worker\.$/i\
if [ -n "${VIDEOPLAYER_TEST_AUDIO_RACE_READY:-}" ] &&\
   [ -n "${VIDEOPLAYER_TEST_AUDIO_RACE_RELEASE:-}" ] &&\
   [ -n "${VIDEOPLAYER_TEST_AUDIO_RACE_ONCE:-}" ] &&\
   [ ! -e "$VIDEOPLAYER_TEST_AUDIO_RACE_ONCE" ]; then\
\t: > "$VIDEOPLAYER_TEST_AUDIO_RACE_ONCE"\
\t: > "$VIDEOPLAYER_TEST_AUDIO_RACE_READY"\
\twhile [ ! -e "$VIDEOPLAYER_TEST_AUDIO_RACE_RELEASE" ]; do\
\t\tsleep 0.05\
\tdone\
fi' \
	"$source_helper" > "$helper"

chmod 0755 "$helper"
grep -Fq "MJPEG_RELAY_BIN=\"$host_relay\"" "$helper" ||
	fail "disposable renderer did not select the compiled MJPEG relay"
if grep -Fq '/usr/libexec/videoplayer-ffmpeg/videoplayer-mjpeg-relay' "$helper"; then
	fail "disposable renderer retained the production MJPEG relay path"
fi
# The disposable shell fallback deliberately returns an error. Every later
# lifecycle CGI must therefore exercise the root-owned compiled relay and its
# production argv contract; an unsafe path, mode, owner, or stale arity fails.
grep -Fq 'VIDEOPLAYER_TEST_REQUIRE_NATIVE_RELAY' "$helper" ||
	fail "disposable renderer did not arm native-relay enforcement"
grep -Fq 'VIDEOPLAYER_TEST_IDENTITY_UNLINK_RACE' "$helper" ||
	fail "disposable renderer did not arm identity-unlink race"

# FFmpeg terminates mpjpeg with a bare opening-boundary line. The FIFO writer
# anchor deliberately remains open until an authenticated terminal marker is
# published, so the relay must recognize that marker while waiting for the
# absent next part headers and synthesize one standards-compliant close marker.
cc -std=c99 -Wall -Wextra -Werror -O2 -static-libgcc \
	-o "$host_relay" "$source_relay"
if readelf -d "$host_relay" |
	grep -Eq 'Shared library: \[libgcc(_s)?\.so'; then
	fail "native MJPEG relay unexpectedly depends on shared libgcc"
fi
relay_boundary=videoplayer-0123456789abcdef0123456789abcdef
relay_nonce=1-9
relay_marker="$work/relay-terminal.marker"
relay_fifo="$work/relay-terminal.fifo"
relay_output="$work/relay-terminal.out"
relay_expected="$work/relay-terminal.expected"
mkfifo -m 0600 "$relay_fifo"
(
	exec 9> "$relay_fifo"
	printf -- '--%s\r\nContent-type: image/jpeg\r\nContent-length: 4\r\n\r\nJPEG\r\n--%s\r\n' \
		"$relay_boundary" "$relay_boundary" >&9
	sleep 3
) &
relay_trailer_writer=$!
(
	# The marker deliberately arrives after the ordinary one-second segment
	# deadline. Because the opening boundary is already consumed, the relay must
	# use its fresh ten-second header/terminal window rather than truncate output.
	sleep 2
	printf 'snapshot-v1\n%s\n%s\nready\n' \
		"${relay_boundary#videoplayer-}" "$relay_nonce" \
		> "$relay_marker.new"
	chmod 0600 "$relay_marker.new"
	mv -f -- "$relay_marker.new" "$relay_marker"
) &
relay_marker_writer=$!
"$host_relay" "$relay_boundary" 0 1 \
	"$relay_marker" "$relay_nonce" 25 \
	< "$relay_fifo" > "$relay_output"
kill "$relay_trailer_writer" 2>/dev/null || :
wait "$relay_trailer_writer" 2>/dev/null || :
wait "$relay_marker_writer"
relay_trailer_writer=""
relay_marker_writer=""
printf -- '--%s\r\nContent-Type: image/jpeg\r\nContent-Length: 4\r\n\r\nJPEG\r\n--%s--\r\n' \
	"$relay_boundary" "$relay_boundary" > "$relay_expected"
cmp "$relay_expected" "$relay_output" ||
	fail "native relay did not seal a bare authenticated FFmpeg trailer"

# Once even part of a header has been consumed, a later marker cannot prove a
# frame-aligned handoff. The relay must fail without publishing that part.
relay_partial_marker="$work/relay-partial.marker"
relay_partial_fifo="$work/relay-partial.fifo"
relay_partial_output="$work/relay-partial.out"
mkfifo -m 0600 "$relay_partial_fifo"
(
	exec 9> "$relay_partial_fifo"
	printf -- '--%s\r\nContent-Type: image/' "$relay_boundary" >&9
	sleep 1
) &
relay_partial_writer=$!
(
	sleep 0.2
	printf 'snapshot-v1\n%s\n%s\nready\n' \
		"${relay_boundary#videoplayer-}" 1-10 \
		> "$relay_partial_marker.new"
	chmod 0600 "$relay_partial_marker.new"
	mv -f -- "$relay_partial_marker.new" "$relay_partial_marker"
) &
relay_partial_marker_writer=$!
set +e
"$host_relay" "$relay_boundary" 0 5 \
	"$relay_partial_marker" 1-10 25 \
	< "$relay_partial_fifo" > "$relay_partial_output"
relay_partial_rc=$?
set -e
wait "$relay_partial_writer"
wait "$relay_partial_marker_writer"
relay_partial_writer=""
relay_partial_marker_writer=""
[[ $relay_partial_rc -eq 1 ]] ||
	fail "native relay accepted a partial terminal part header"
[[ ! -s "$relay_partial_output" ]] ||
	fail "native relay published a partial terminal part"

# Exercise the production BusyBox-ash `read -t` branch under bash (which has
# the same timeout and partial-line semantics). A zero-byte wait may synthesize
# a clean close; consuming even part of the next boundary must fail closed.
timed_functions="$work/mjpeg-timeout-functions.sh"
awk '
	/^mjpeg_read_boundary\(\) \{/ { copying = 1 }
	copying && /^process_read_chars\(\) \{/ { exit }
	copying { print }
' "$source_helper" > "$timed_functions"
bash -s -- "$timed_functions" "$work" <<'BASH'
set -Eeuo pipefail
functions=$1
work=$2
# shellcheck source=/dev/null
. "$functions"
valid_decimal() { return 0; }
load_video_drain_marker() {
	[[ -f "$work/mjpeg-terminal-ready" ]]
}
monotonic_centiseconds() {
	printf '%s\n' "$(( $(date +%s%N) / 10000000 ))"
}
MJPEG_SEGMENT_SECONDS=1
MJPEG_HEADER_WAIT_SECONDS=10
boundary=videoplayer-0123456789abcdef0123456789abcdef

mkfifo "$work/mjpeg-zero-byte-timeout.fifo"
(sleep 3) > "$work/mjpeg-zero-byte-timeout.fifo" &
writer=$!
set +e
(mjpeg_copy_aligned 0123456789abcdef0123456789abcdef \
	"$boundary" 0 1-1 25) \
	< "$work/mjpeg-zero-byte-timeout.fifo" \
	> "$work/mjpeg-zero-byte-timeout.out"
rc=$?
set -e
kill "$writer" 2>/dev/null || :
wait "$writer" 2>/dev/null || :
[[ $rc -eq 2 ]]
printf -- '--%s--\r\n' "$boundary" > "$work/mjpeg-timeout.expected"
cmp "$work/mjpeg-timeout.expected" "$work/mjpeg-zero-byte-timeout.out"

mkfifo "$work/mjpeg-partial-boundary.fifo"
(
	printf -- '--%s' "$boundary"
	sleep 3
) > "$work/mjpeg-partial-boundary.fifo" &
writer=$!
set +e
(mjpeg_copy_aligned 0123456789abcdef0123456789abcdef \
	"$boundary" 0 1-2 25) \
	< "$work/mjpeg-partial-boundary.fifo" \
	> "$work/mjpeg-partial-boundary.out"
rc=$?
set -e
kill "$writer" 2>/dev/null || :
wait "$writer" 2>/dev/null || :
[[ $rc -eq 1 ]]
[[ ! -s "$work/mjpeg-partial-boundary.out" ]]

mkfifo "$work/mjpeg-bare-trailer.fifo"
(
	exec 3> "$work/mjpeg-bare-trailer.fifo"
	printf -- '--%s\r\nContent-type: image/jpeg\r\nContent-length: 4\r\n\r\nJPEG\r\n--%s\r\n' \
		"$boundary" "$boundary" >&3
	sleep 3
) &
writer=$!
# Publish readiness after the ordinary segment deadline. Once the bare opening
# boundary has been consumed, only the fresh ten-second header/terminal window
# can complete this response without losing the exact FIFO position.
(sleep 2; : > "$work/mjpeg-terminal-ready") &
marker_writer=$!
(mjpeg_copy_aligned 0123456789abcdef0123456789abcdef \
	"$boundary" 0 1-3 25) \
	< "$work/mjpeg-bare-trailer.fifo" \
	> "$work/mjpeg-bare-trailer.out"
kill "$writer" 2>/dev/null || :
wait "$writer" 2>/dev/null || :
wait "$marker_writer"
printf -- '--%s\r\nContent-Type: image/jpeg\r\nContent-Length: 4\r\n\r\nJPEG\r\n--%s--\r\n' \
	"$boundary" "$boundary" > "$work/mjpeg-bare-trailer.expected"
cmp "$work/mjpeg-bare-trailer.expected" "$work/mjpeg-bare-trailer.out"

rm -f -- "$work/mjpeg-terminal-ready"
mkfifo "$work/mjpeg-partial-header.fifo"
(
	exec 3> "$work/mjpeg-partial-header.fifo"
	printf -- '--%s\r\nContent-Type: image/' "$boundary" >&3
	sleep 2
) &
writer=$!
(sleep 0.3; : > "$work/mjpeg-terminal-ready") &
marker_writer=$!
set +e
(mjpeg_copy_aligned 0123456789abcdef0123456789abcdef \
	"$boundary" 0 1-4 25) \
	< "$work/mjpeg-partial-header.fifo" \
	> "$work/mjpeg-partial-header.out"
rc=$?
set -e
wait "$writer"
wait "$marker_writer"
[[ $rc -eq 1 ]]
[[ ! -s "$work/mjpeg-partial-header.out" ]]
BASH

if [[ ${VIDEOPLAYER_TEST_RELAY_ONLY:-0} == 1 ]]; then
	printf '%s\n' 'renderer-test: targeted relay checks passed'
	exit 0
fi

grep -Fq 'export PATH="/usr/sbin:/usr/bin:/sbin:/bin"' "$source_stream" ||
	fail "unexpected stream PATH declaration"
sed \
	-e "s|export PATH=\"/usr/sbin:/usr/bin:/sbin:/bin\"|export PATH=\"$bin:/usr/sbin:/usr/bin:/sbin:/bin\"|" \
	-e "s|TOKEN_DIR=\"/tmp/videoplayer-tokens\"|TOKEN_DIR=\"$stream_token_dir\"|" \
	"$source_stream" > "$stream_helper"
chmod 0755 "$stream_helper"

grep -Fxq '. /usr/share/libubox/jshn.sh' "$source_rpc" ||
	fail "unexpected rpcd jshn import"
grep -Fxq '# --- rpcd entry point ---' "$source_rpc" ||
	fail "rpcd entry-point marker not found"
awk '
	$0 == ". /usr/share/libubox/jshn.sh" { print ":"; next }
	$0 == "# --- rpcd entry point ---" { exit }
	{ print }
' "$source_rpc" |
	sed "s|RENDERER_HELPER=\"/usr/libexec/videoplayer-renderer\"|RENDERER_HELPER=\"$rpc_renderer\"|" \
		> "$rpc_harness"

cat > "$rpc_renderer" <<'SH'
#!/bin/sh
printf '%s\t%s\t%s\n' "${1:-}" "${2:-}" "${3:-}" >> "$RPC_RENDERER_CALL_LOG"
case "${1:-}" in
	start) printf 'started\n' ;;
	attest) printf 'private-software-cpu\tsoftware-cpu-v1\tnone\n' ;;
	media-info) printf '125500\t1004\t8\tfast\tprivate-software-cpu\tsoftware-cpu-v1\tnone\t0\n' ;;
	has-audio) printf '1\n' ;;
	audio-state) printf 'ready\n' ;;
	status-touch) printf 'running\n' ;;
	reason) : ;;
	stop) printf 'stopped\n' ;;
	*) exit 1 ;;
esac
SH
chmod 0755 "$rpc_renderer"
export RPC_RENDERER_CALL_LOG="$rpc_call_log"

! grep -Fq '/tmp/videoplayer-render-v1' "$helper" ||
	fail "runtime transform incomplete"
! grep -Fq '/usr/libexec/videoplayer-renderer' "$helper" ||
	fail "self-path transform incomplete"
! grep -Fq '/usr/libexec/videoplayer-ffmpeg/ffmpeg' "$helper" ||
	fail "private FFmpeg transform incomplete"
! grep -Fq '/usr/lib/videoplayer-ffmpeg' "$helper" ||
	fail "private FFmpeg library transform incomplete"
! grep -Fq '/usr/share/luci-videoplayer-codec-runtime/build-info' "$helper" ||
	fail "private FFmpeg build-info transform incomplete"

cat > "$bin/uci" <<'SH'
#!/bin/sh
[ "${1:-}" = "-q" ] && shift
[ "${1:-}" = "get" ] || exit 1

case "${2:-}" in
	videoplayer.main.enabled)
		printf '1\n'
		;;
	videoplayer.main.render_mode)
		printf '%s\n' "${VIDEOPLAYER_TEST_RENDER_MODE:-router}"
		;;
	videoplayer.main.media_path)
		printf '%s\n' "$VIDEOPLAYER_TEST_MEDIA_ROOT"
		;;
	videoplayer.main.router_fps)
		printf '%s\n' "${VIDEOPLAYER_TEST_ROUTER_FPS:-8}"
		;;
	videoplayer.main.router_profile)
		printf '%s\n' "${VIDEOPLAYER_TEST_ROUTER_PROFILE:-fast}"
		;;
	videoplayer.main.router_max_threads)
		printf '%s\n' "${VIDEOPLAYER_TEST_ROUTER_MAX_THREADS:-0}"
		;;
	*)
		exit 1
		;;
esac
SH

chmod 0755 "$bin/uci"

# An ELF stub preserves the same /proc/cmdline shape as real FFmpeg. Besides
# providing probe output, it verifies fd 3, the private FFmpeg worker-lock
# lifecycle barrier, and the important resource/security
# arguments used by the production worker.
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

static int valid_thread_count(const char *value, unsigned long maximum)
{
	char *end = NULL;
	unsigned long parsed;

	if (value == NULL || value[0] == '\0')
		return 0;
	errno = 0;
	parsed = strtoul(value, &end, 10);
	return errno == 0 && end != value && *end == '\0' && parsed >= 1 &&
	       parsed <= maximum;
}

static int has_arg_prefix(int argc, char **argv, const char *prefix)
{
	size_t prefix_len = strlen(prefix);
	int i;

	for (i = 1; i < argc; ++i)
		if (strncmp(argv[i], prefix, prefix_len) == 0)
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

static const char *pair_value(int argc, char **argv, const char *left)
{
	int i;

	for (i = 1; i + 1 < argc; ++i)
		if (strcmp(argv[i], left) == 0)
			return argv[i + 1];

	return NULL;
}

static int count_input_group(int argc, char **argv, const char *threads)
{
	int count = 0;
	int i;

	for (i = 1; i + 9 < argc; ++i) {
		int input_offset = 8;

		if (strcmp(argv[i], "-protocol_whitelist") == 0 &&
		    strcmp(argv[i + 1], "file,pipe") == 0 &&
		    strcmp(argv[i + 2], "-threads") == 0 &&
		    strcmp(argv[i + 3], threads) == 0 &&
		    strcmp(argv[i + 4], "-fflags") == 0 &&
		    strcmp(argv[i + 5], "+genpts") == 0 &&
		    strcmp(argv[i + 6], "-err_detect") == 0 &&
		    strcmp(argv[i + 7], "ignore_err") == 0) {
			if (i + 13 < argc &&
			    strcmp(argv[i + 8], "-skip_loop_filter:v") == 0 &&
			    strcmp(argv[i + 9], "noref") == 0 &&
			    strcmp(argv[i + 10], "-flags2:v") == 0 &&
			    strcmp(argv[i + 11], "+fast") == 0)
				input_offset = 12;
			if (i + input_offset + 3 < argc &&
			    strcmp(argv[i + input_offset], "-hwaccel") == 0 &&
			    strcmp(argv[i + input_offset + 1], "none") == 0 &&
			    strcmp(argv[i + input_offset + 2], "-i") == 0 &&
			    strcmp(argv[i + input_offset + 3], "/proc/self/fd/3") == 0)
				++count;
		}
	}

	return count;
}

static int every_input_is_software_only(int argc, char **argv)
{
	int inputs = 0;
	int i;

	for (i = 1; i + 1 < argc; ++i) {
		if (strcmp(argv[i], "-i") != 0)
			continue;
		++inputs;
		if (i < 3 || strcmp(argv[i - 2], "-hwaccel") != 0 ||
		    strcmp(argv[i - 1], "none") != 0)
			return 0;
	}
	return inputs > 0;
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

static int boundary_matches_output(const char *boundary, const char *output)
{
	const char *root = getenv("VIDEOPLAYER_TEST_RUNTIME");
	const char *token;
	size_t root_len;

	if (root == NULL || boundary == NULL)
		return 0;
	root_len = strlen(root);
	if (strncmp(output, root, root_len) != 0 ||
	    strncmp(output + root_len, "/s-", 3) != 0)
		return 0;
	token = output + root_len + 3;
	return strlen(boundary) == 44 &&
	       strncmp(boundary, "videoplayer-", 12) == 0 &&
	       strncmp(boundary + 12, token, 32) == 0 &&
	       token[32] == '/';
}

static int write_all(int fd, const void *buffer, size_t size)
{
	const unsigned char *bytes = buffer;
	size_t written = 0;
	ssize_t result;

	while (written < size) {
		result = write(fd, bytes + written, size - written);
		if (result > 0) {
			written += (size_t)result;
			continue;
		}
		if (result < 0 && errno == EINTR) {
			if (!running)
				return -1;
			continue;
		}
		return -1;
	}
	return 0;
}

static int publish_mjpeg(
	int fd,
	const char *boundary,
	unsigned int sequence)
{
	unsigned char frame[4096];
	char header[256];
	int header_size;

	memset(frame, 0x5a, sizeof(frame));
	frame[0] = 0xff;
	frame[1] = 0xd8;
	frame[2] = 'V';
	frame[3] = 'P';
	frame[4] = (unsigned char)((sequence >> 24) & 0xffU);
	frame[5] = (unsigned char)((sequence >> 16) & 0xffU);
	frame[6] = (unsigned char)((sequence >> 8) & 0xffU);
	frame[7] = (unsigned char)(sequence & 0xffU);
	frame[sizeof(frame) - 2] = 0xff;
	frame[sizeof(frame) - 1] = 0xd9;

	header_size = snprintf(
		header,
		sizeof(header),
		"--%s\r\n"
		"Content-type: image/jpeg\r\n"
		"Content-length: %zu\r\n"
		"\r\n",
		boundary,
		sizeof(frame));
	if (header_size < 0 || header_size >= (int)sizeof(header))
		return -1;

	if (write_all(fd, header, (size_t)header_size) != 0 ||
	    write_all(fd, frame, sizeof(frame)) != 0 ||
	    write_all(fd, "\r\n", 2) != 0)
		return -1;

	return 0;
}

static int publish_mjpeg_trailer(int fd, const char *boundary)
{
	char trailer[96];
	int trailer_size;

	trailer_size = snprintf(
		trailer,
		sizeof(trailer),
		"--%s\r\n",
		boundary);
	if (trailer_size < 0 || trailer_size >= (int)sizeof(trailer))
		return -1;
	return write_all(fd, trailer, (size_t)trailer_size);
}

static int publish_audio(int fd, unsigned int sequence)
{
	unsigned char pcm[192000];
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

static int publish_partial_audio(int fd, unsigned int sequence)
{
	unsigned char pcm[96000];

	memset(pcm, (int)(sequence & 0xffU), sizeof(pcm));
	return write_all(fd, pcm, sizeof(pcm));
}

static const char *find_output(
	int argc,
	char **argv,
	const char *suffix)
{
	int i;

	for (i = 1; i < argc; ++i)
		if (ends_with(argv[i], suffix))
			return argv[i];

	return NULL;
}

static int extract_tee_path(
	const char *target,
	const char *suffix,
	char *output,
	size_t output_size)
{
	const char *segment = target;
	const char *options_end;
	const char *path;
	const char *segment_end;
	size_t length;
	size_t suffix_length = strlen(suffix);

	while (segment != NULL && *segment != '\0') {
		options_end = strchr(segment, ']');
		if (options_end == NULL)
			return 0;
		path = options_end + 1;
		segment_end = strchr(path, '|');
		if (segment_end == NULL)
			segment_end = path + strlen(path);
		length = (size_t)(segment_end - path);
		if (length >= suffix_length &&
		    memcmp(path + length - suffix_length, suffix, suffix_length) == 0) {
			if (length + 1 > output_size)
				return 0;
			memcpy(output, path, length);
			output[length] = '\0';
			return 1;
		}
		segment = *segment_end == '|' ? segment_end + 1 : NULL;
	}
	return 0;
}

static int extract_tee_boundary(
	const char *target,
	char *boundary,
	size_t boundary_size)
{
	static const char prefix[] = "[select=v:f=mpjpeg:boundary_tag=";
	const char *value;
	const char *end;
	size_t length;

	if (strncmp(target, prefix, sizeof(prefix) - 1) != 0)
		return 0;
	value = target + sizeof(prefix) - 1;
	end = strchr(value, ']');
	if (end == NULL)
		return 0;
	length = (size_t)(end - value);
	if (length + 1 > boundary_size)
		return 0;
	memcpy(boundary, value, length);
	boundary[length] = '\0';
	return 1;
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

static int wait_for_blocked_probe_release(void)
{
	const char *ready_path = getenv("VIDEOPLAYER_TEST_BLOCKED_PROBE_READY");
	const char *release_path = getenv("VIDEOPLAYER_TEST_BLOCKED_PROBE_RELEASE");
	FILE *ready;

	if (ready_path == NULL || ready_path[0] == '\0' ||
	    release_path == NULL || release_path[0] == '\0')
		return -1;
	ready = fopen(ready_path, "w");
	if (ready == NULL)
		return -1;
	if (fprintf(ready, "%ld\n", (long)getpid()) < 0) {
		fclose(ready);
		return -1;
	}
	if (fclose(ready) != 0)
		return -1;
	while (access(release_path, F_OK) != 0) {
		if (errno != ENOENT)
			return -1;
		usleep(10000);
	}
	return 0;
}

int main(int argc, char **argv)
{
	struct stat input;
	char marker[32] = {0};
	char expected_video_filter[256];
	char expected_audio_filter[256];
	char expected_tee_target[8192];
	char tee_video_output[4096];
	char tee_audio_output[4096];
	char tee_boundary[96];
	char *fps_end = NULL;
	const char *boundary;
	const char *audio_output;
	const char *video_output;
	int audio_finite;
	int audio_fast_fixture;
	int audio_clean_eof;
	int audio_runtime_failure;
	int audio_output_fd = -1;
	int video_output_fd;
	int delayed_video;
	int fail_after_first_frame;
	int fast_producer;
	int finite_video;
	int instant_video;
	int line;
	int tee_mode;
	unsigned int frame_delay_us;
	unsigned int audio_frame_interval;
	unsigned int audio_sequence = 0;
	unsigned int video_sequence = 0;
	unsigned long parsed_fps;
	ssize_t marker_size;
	const char *expected_private_lib;
	const char *expected_decoder_threads;
	const char *expected_pipeline_threads;
	const char *expected_fps;
	const char *expected_profile;
	const char *expected_huffman;
	const char *expected_quality;
	const char *expected_width;
	const char *expected_height;
	const char *library_path;
	const char *producer_release;

	expected_private_lib = getenv("VIDEOPLAYER_EXPECT_PRIVATE_LIB");
	expected_decoder_threads = getenv("VIDEOPLAYER_EXPECT_DECODER_THREADS");
	expected_pipeline_threads = getenv("VIDEOPLAYER_EXPECT_PIPELINE_THREADS");
	expected_fps = getenv("VIDEOPLAYER_EXPECT_FPS");
	expected_profile = getenv("VIDEOPLAYER_EXPECT_PROFILE");
	if (!valid_thread_count(expected_decoder_threads, 16))
		return 78;
	if (expected_profile == NULL || expected_profile[0] == '\0')
		expected_profile = "fast";
	if (strcmp(expected_profile, "fast") == 0) {
		if (expected_pipeline_threads == NULL)
			expected_pipeline_threads = expected_decoder_threads;
		expected_huffman = "default";
		expected_quality = "12";
		expected_width = "480";
		expected_height = "270";
	} else if (strcmp(expected_profile, "quality") == 0) {
		if (expected_pipeline_threads == NULL)
			expected_pipeline_threads =
				strcmp(expected_decoder_threads, "1") == 0 ? "1" : "2";
		expected_huffman = "optimal";
		expected_quality = "8";
		expected_width = "640";
		expected_height = "360";
	} else {
		return 78;
	}
	if (!valid_thread_count(expected_pipeline_threads, 64))
		return 78;
	library_path = getenv("LD_LIBRARY_PATH");
	if (expected_fps == NULL || expected_fps[0] == '\0')
		expected_fps = "8";
	errno = 0;
	parsed_fps = strtoul(expected_fps, &fps_end, 10);
	if (errno != 0 || fps_end == expected_fps || *fps_end != '\0' ||
	    parsed_fps == 0 || parsed_fps > 1000)
		return 78;
	frame_delay_us = (unsigned int)(1000000UL / parsed_fps);
	audio_frame_interval = (unsigned int)parsed_fps;
	if (snprintf(
		    expected_video_filter,
		    sizeof(expected_video_filter),
		    "fps=fps=%s:start_time=0,scale=%s:%s:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=fast_bilinear,format=yuvj420p",
		    expected_fps, expected_width, expected_height) >=
	    (int)sizeof(expected_video_filter))
		return 78;
	if (snprintf(
		    expected_audio_filter,
		    sizeof(expected_audio_filter),
		    "aresample=48000:async=1:first_pts=0,aformat=sample_fmts=s16:channel_layouts=stereo,apad,asetnsamples=n=48000:p=1") >=
	    (int)sizeof(expected_audio_filter))
		return 78;
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
		puts(" V..... = Video");
		puts(" A..... = Audio");
		puts(" V..... mjpeg CI stub");
		puts(" A..... pcm_s16le CI stub");
		return 0;
	}
	if (has_arg(argc, argv, "-hwaccels")) {
		puts("Hardware acceleration methods:");
		return 0;
	}
	if (has_arg(argc, argv, "-buildconf")) {
		puts("configuration:");
		puts("    --disable-autodetect");
		puts("    --disable-hwaccels");
		puts("    --disable-vaapi");
		puts("    --disable-vdpau");
		puts("    --disable-vulkan");
		puts("    --disable-avdevice");
		puts("    --disable-decoders");
		puts("    --disable-encoders");
		return 0;
	}
	if (has_arg(argc, argv, "-decoders")) {
		puts(" V..... = Video"); puts(" A..... = Audio");
		puts(" S..... = Subtitle");
		puts(" V..... h263 CI stub"); puts(" V..... h264 CI stub");
		puts(" V..... hevc CI stub");
		puts(" V..... vc1 CI stub"); puts(" V..... mpeg4 CI stub");
		puts(" V..... vp8 CI stub"); puts(" V..... vp9 CI stub");
		puts(" V..... av1 CI stub"); puts(" V..... mjpeg CI stub");
		puts(" A..... aac CI stub"); puts(" A..... ac3 CI stub");
		puts(" A..... eac3 CI stub"); puts(" A..... alac CI stub");
		puts(" A..... dca CI stub"); puts(" A..... flac CI stub");
		puts(" A..... mp3 CI stub"); puts(" A..... opus CI stub");
		puts(" A..... pcm_s16le CI stub"); puts(" A..... truehd CI stub");
		puts(" A..... vorbis CI stub");
		return 0;
	}

	if (has_arg(argc, argv, "-muxers")) {
		puts(" E mpjpeg CI stub");
		puts(" E s16le CI stub");
		puts(" E tee CI stub");
		return 0;
	}

	if (count_pair(argc, argv, "-h", "muxer=mpjpeg") == 1) {
		puts("mpjpeg_muxer AVOptions:");
		puts("  -boundary_tag <string> E.......... Boundary tag");
		return 0;
	}
	if (count_pair(argc, argv, "-h", "encoder=mjpeg") == 1) {
		puts("mjpeg encoder AVOptions:");
		puts("  -huffman <int> E.......... Huffman strategy");
		puts("     default 0 E.......... Default tables");
		puts("     optimal 1 E.......... Optimal tables");
		return 0;
	}

	if (has_arg(argc, argv, "-filters")) {
		puts(" ... fps V->V CI stub");
		puts(" ... scale V->V CI stub");
		puts(" ... format V->V CI stub");
		puts(" ... aresample A->A CI stub");
		puts(" ... aformat A->A CI stub");
		puts(" ... apad A->A CI stub");
		puts(" ... asetnsamples A->A CI stub");
		return 0;
	}

	if (has_arg(argc, argv, "-frames:a")) {
		errno = 0;
		if (count_pair(argc, argv, "-i", "/proc/self/fd/3") != 1 ||
		    !every_input_is_software_only(argc, argv) ||
		    count_pair(argc, argv, "-map", "0:a:0") != 1 ||
		    count_pair(argc, argv, "-frames:a", "1") != 1 ||
		    count_pair(argc, argv, "-f", "s16le") != 1 ||
		    strcmp(argv[argc - 1], "-") != 0 ||
		    fstat(3, &input) != 0 || !S_ISREG(input.st_mode) ||
		    fcntl(8, F_GETFD) == -1)
			return 84;
		marker_size = pread(3, marker, sizeof(marker) - 1, 0);
		if (marker_size < 0)
			return 85;
		if (marker_is(marker, marker_size, "no-audio") ||
		    marker_is(marker, marker_size, "delayed-start") ||
		    marker_is(marker, marker_size, "instant-media") ||
		    marker_is(marker, marker_size, "fast-producer")) {
			fputs(
				"Stream map '0:a:0' matches no streams.\n"
				"To ignore this, add a trailing '?' to the map.\n"
				"Failed to set value '0:a:0' for option 'map': Invalid argument\n"
				"Error parsing options for output file -.\n"
				"Error opening output files: Invalid argument\n",
				stderr);
			return 81;
		}
		if (marker_is(marker, marker_size, "audio-probe-failure")) {
			fputs(
				"Stream map '0:a:0' matches no streams.\n"
				"To ignore this, add a trailing '?' to the map.\n"
				"Failed to set value '0:a:0' for option 'map': Invalid argument\n"
				"Error parsing options for output file -.\n"
				"Error opening output files: Invalid argument\n"
				"Error while decoding advertised audio stream\n",
				stderr);
			return 83;
		}
		return publish_audio(STDOUT_FILENO, 0) == 0 ? 0 : 86;
	}
	if (has_arg(argc, argv, "-frames:v")) {
		errno = 0;
		if (count_pair(argc, argv, "-i", "/proc/self/fd/3") != 1 ||
		    !every_input_is_software_only(argc, argv) ||
		    count_pair(argc, argv, "-map", "0:V:0") != 1 ||
		    count_pair(argc, argv, "-frames:v", "1") != 1 ||
		    count_pair(
			    argc,
			    argv,
			    "-vf",
			    "scale=16:16:flags=fast_bilinear,format=yuvj420p") != 1 ||
		    count_pair(argc, argv, "-c:v", "mjpeg") != 1 ||
		    count_pair(argc, argv, "-f", "mpjpeg") != 1 ||
		    count_pair(argc, argv, "-boundary_tag", "videoplayer-probe-boundary") != 1 ||
		    strcmp(argv[argc - 1], "-") != 0 ||
		    fstat(3, &input) != 0 || !S_ISREG(input.st_mode) ||
		    fcntl(8, F_GETFD) == -1)
			return 90;
		marker_size = pread(3, marker, sizeof(marker) - 1, 0);
		if (marker_size < 0)
			return 91;
		if (marker_is(marker, marker_size, "blocked-probe") &&
		    wait_for_blocked_probe_release() != 0)
			return 92;
		return publish_mjpeg(
			       STDOUT_FILENO, "videoplayer-probe-boundary", 0) == 0
			? 0 : 93;
	}

	tee_mode = count_pair(argc, argv, "-f", "tee") == 1;
	video_output = find_output(argc, argv, "/video.pipe");
	audio_output = find_output(argc, argv, "/audio.pipe");
	boundary = pair_value(argc, argv, "-boundary_tag");
	if (tee_mode) {
		if (!extract_tee_path(
			    argv[argc - 1], "/video.pipe", tee_video_output,
			    sizeof(tee_video_output)) ||
		    !extract_tee_path(
			    argv[argc - 1], "/audio.pipe", tee_audio_output,
			    sizeof(tee_audio_output)) ||
		    !extract_tee_boundary(
			    argv[argc - 1], tee_boundary, sizeof(tee_boundary)))
			return 80;
		video_output = tee_video_output;
		audio_output = tee_audio_output;
		boundary = tee_boundary;
	}
	if (video_output == NULL && audio_output == NULL &&
	    count_pair(argc, argv, "-i", "/proc/self/fd/3") == 1) {
		errno = 0;
		if (count_pair(argc, argv, "-loglevel", "info") != 1 ||
		    count_pair(argc, argv, "-protocol_whitelist", "file,pipe") != 1 ||
		    !every_input_is_software_only(argc, argv) ||
		    fstat(3, &input) != 0 || !S_ISREG(input.st_mode) ||
		    fcntl(8, F_GETFD) == -1)
			return 87;
		marker_size = pread(3, marker, sizeof(marker) - 1, 0);
		if (marker_size < 0)
			return 88;
		if (marker_is(marker, marker_size, "blocked-probe") &&
		    wait_for_blocked_probe_release() != 0)
			return 89;
		fputs("Input #0, mov, from '/proc/self/fd/3':\n", stderr);
		if (marker_is(marker, marker_size, "long-probe-audio")) {
			for (line = 0; line < 1400; line++)
				fprintf(
					stderr,
					"  Stream #0:%d: Subtitle: subrip, adversarial inventory padding\n",
					line + 2);
		}
		fputs("  Stream #0:0: Video: h264, yuv420p\n", stderr);
		if (!marker_is(marker, marker_size, "no-audio") &&
		    !marker_is(marker, marker_size, "duration-unknown") &&
		    !marker_is(marker, marker_size, "instant-media") &&
		    !marker_is(marker, marker_size, "fast-producer") &&
		    !marker_is(marker, marker_size, "delayed-start"))
			fputs("  Stream #0:1: Audio: aac, 48000 Hz, stereo\n", stderr);
		if (marker_is(marker, marker_size, "duration-unknown"))
			fputs("  Duration: N/A, start: 0.000000, bitrate: N/A\n", stderr);
		else {
			fputs("    Duration: 09:09:09.99, metadata spoof\n", stderr);
			fputs("  Duration: 00:02:05.50, start: 0.000000, bitrate: 1 kb/s\n", stderr);
		}
		return 1;
	}
	errno = 0;
	if (argc < 2 || !has_arg(argc, argv, "-nostdin") ||
	    !every_input_is_software_only(argc, argv) ||
	    has_arg(argc, argv, "-re") ||
	    has_arg_prefix(argc, argv, "-readrate") ||
	    count_pair(argc, argv, "-filter_threads", expected_pipeline_threads) != 1 ||
	    count_pair(argc, argv, "-protocol_whitelist", "file,pipe") !=
		    (audio_output != NULL ? 2 : 1) ||
	    count_pair(argc, argv, "-fflags", "+genpts") !=
		    (audio_output != NULL ? 2 : 1) ||
	    count_pair(argc, argv, "-err_detect", "ignore_err") !=
		    (audio_output != NULL ? 2 : 1) ||
	    count_input_group(argc, argv, expected_decoder_threads) !=
		    (audio_output != NULL &&
		     strcmp(expected_decoder_threads, "1") == 0 ? 2 : 1) ||
	    (strcmp(expected_decoder_threads, "1") != 0 &&
	     count_input_group(argc, argv, "1") !=
		     (audio_output != NULL ? 1 : 0)) ||
	    fstat(3, &input) != 0 ||
	    !S_ISREG(input.st_mode) ||
	    input.st_size <= 0 ||
	    fcntl(8, F_GETFD) == -1)
		return 64;

	errno = 0;
	if (audio_output != NULL &&
	    (!tee_mode ||
		    count_pair(argc, argv, "-threads:v", expected_pipeline_threads) != 1 ||
		    count_pair(argc, argv, "-threads:a", "1") != 1 ||
		    count_pair(argc, argv, "-map", "1:a:0") != 1 ||
		    count_pair(
			    argc,
			    argv,
			    "-af",
			    expected_audio_filter) != 1 ||
		    count_pair(argc, argv, "-c:a", "pcm_s16le") != 1 ||
		    count_pair(argc, argv, "-f", "tee") != 1 ||
		    !has_arg(argc, argv, "-shortest") ||
		    !output_is_safe(audio_output, "/audio.pipe")))
		return 80;
	if (audio_output != NULL) {
		if (snprintf(
			    expected_tee_target,
			    sizeof(expected_tee_target),
			    "[select=v:f=mpjpeg:boundary_tag=%s]%s|[select=a:f=s16le:onfail=ignore]%s",
			    boundary, video_output, audio_output) >=
		    (int)sizeof(expected_tee_target) ||
		    strcmp(argv[argc - 1], expected_tee_target) != 0)
			return 80;
	}
	if (fcntl(4, F_GETFD) != -1 || errno != EBADF)
		return 80;
	if (
	    count_pair(argc, argv, "-filter_threads", expected_pipeline_threads) != 1 ||
	    count_pair(argc, argv, "-threads:v", expected_pipeline_threads) != 1 ||
	    count_pair(argc, argv, "-q:v", expected_quality) != 1 ||
	    count_pair(argc, argv, "-huffman", expected_huffman) != 1 ||
	    count_pair(argc, argv, "-i", "/proc/self/fd/3") !=
		    (audio_output != NULL ? 2 : 1) ||
	    count_pair(argc, argv, "-map", "0:V:0") != 1 ||
	    count_pair(
		    argc,
		    argv,
		    "-vf",
		    expected_video_filter) != 1 ||
	    count_pair(argc, argv, "-c:v", "mjpeg") != 1 ||
	    (audio_output == NULL && count_pair(argc, argv, "-f", "mpjpeg") != 1) ||
	    boundary == NULL ||
	    (audio_output == NULL &&
	     count_pair(argc, argv, "-boundary_tag", boundary) != 1) ||
	    has_arg(argc, argv, "-update") ||
	    has_arg(argc, argv, "-atomic_writing") ||
	    video_output == NULL ||
	    !output_is_safe(video_output, "/video.pipe") ||
	    !boundary_matches_output(boundary, video_output))
		return 64;
	if (strcmp(expected_profile, "fast") == 0) {
		if (count_pair(argc, argv, "-skip_loop_filter:v", "noref") != 1 ||
		    count_pair(argc, argv, "-flags2:v", "+fast") != 1)
			return 64;
	} else if (has_arg(argc, argv, "-skip_loop_filter:v") ||
		   has_arg(argc, argv, "-flags2:v")) {
		return 64;
	}
	if (audio_output == NULL && tee_mode)
		return 64;

	marker_size = pread(3, marker, sizeof(marker) - 1, 0);
	if (marker_size < 0)
		return 67;
	if (marker_is(marker, marker_size, "producer-race")) {
		producer_release = getenv(
			"VIDEOPLAYER_TEST_PRODUCER_IDENTITY_RELEASE");
		if (producer_release == NULL || producer_release[0] == '\0')
			return 94;
		while (access(producer_release, F_OK) != 0) {
			if (errno != ENOENT)
				return 94;
			usleep(10000);
		}
	}
	delayed_video = marker_is(marker, marker_size, "delayed-start");
	finite_video = marker_is(marker, marker_size, "finite-media") ||
		marker_is(marker, marker_size, "audio-finite") ||
		marker_is(marker, marker_size, "video-short-audio-long");
	instant_video = marker_is(marker, marker_size, "instant-media");
	fast_producer = marker_is(marker, marker_size, "fast-producer") ||
		marker_is(marker, marker_size, "fast-av-producer");
	audio_finite = marker_is(marker, marker_size, "audio-finite");
	audio_runtime_failure =
		marker_is(marker, marker_size, "audio-runtime-failure");
	audio_clean_eof =
		marker_is(marker, marker_size, "audio-clean-eof");
	audio_fast_fixture =
		marker_is(marker, marker_size, "finite-media") ||
		audio_runtime_failure;
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
			"Unrecognized option 'boundary_tag'.\n"
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
			"\n[out#0/mpjpeg @ 0x5678] Error opening output file "
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

	if (delayed_video)
		sleep(4);
	if (audio_output != NULL) {
		audio_output_fd = open(audio_output, O_WRONLY);
		if (audio_output_fd < 0)
			return 82;
	}
	video_output_fd = open(video_output, O_WRONLY);
	if (video_output_fd < 0)
		return 66;
	while (running) {
		if (audio_output_fd >= 0 &&
		    (audio_fast_fixture ||
		     video_sequence % audio_frame_interval == 0)) {
			if (publish_audio(audio_output_fd, audio_sequence++) != 0) {
				close(audio_output_fd);
				close(video_output_fd);
				return 82;
			} else if (audio_runtime_failure && audio_sequence >= 4) {
				if (publish_partial_audio(audio_output_fd, audio_sequence) != 0) {
					close(audio_output_fd);
					close(video_output_fd);
					return 82;
				}
				close(audio_output_fd);
				audio_output_fd = -1;
			} else if (audio_clean_eof && audio_sequence >= 4) {
				close(audio_output_fd);
				audio_output_fd = -1;
			}
		}
		if (publish_mjpeg(video_output_fd, boundary, video_sequence) != 0) {
			if (audio_output_fd >= 0)
				close(audio_output_fd);
			close(video_output_fd);
			return 66;
		}
		video_sequence++;
		if (instant_video) {
			if (publish_mjpeg_trailer(video_output_fd, boundary) != 0) {
				if (audio_output_fd >= 0)
					close(audio_output_fd);
				close(video_output_fd);
				return 66;
			}
			if (audio_output_fd >= 0)
				close(audio_output_fd);
			close(video_output_fd);
			return 0;
		}
		if (finite_video &&
		    video_sequence >=
			    (audio_finite ||
				     marker_is(
					     marker,
					     marker_size,
					     "video-short-audio-long")
				     ? (unsigned int)((parsed_fps * 113UL + 99UL) / 100UL)
				     : 4U)) {
			if (publish_mjpeg_trailer(video_output_fd, boundary) != 0) {
				if (audio_output_fd >= 0)
					close(audio_output_fd);
				close(video_output_fd);
				return 66;
			}
			if (audio_output_fd >= 0)
				close(audio_output_fd);
			close(video_output_fd);
			return 0;
		}
		if (fail_after_first_frame) {
			sleep(4);
			fputs("Cannot allocate memory while decoding frame\n", stderr);
			if (audio_output_fd >= 0)
				close(audio_output_fd);
			close(video_output_fd);
			return 69;
		}

		if (!fast_producer)
			usleep(frame_delay_us);
	}

	if (audio_output_fd >= 0)
		close(audio_output_fd);
	close(video_output_fd);
	return 0;
}
C

chmod 0755 "$bin/ffmpeg"

# Keep `nice` as the worker's direct child for long enough to exercise the
# bounded exec-identity transition. The production helper must observe the
# same PID/start-time become the attested private FFmpeg executable; accepting
# the wrapper itself or checking only once would respectively be unsafe or
# spuriously fail this deterministic launch.
cat > "$bin/nice" <<'SH'
#!/bin/sh
if [ -n "${VIDEOPLAYER_TEST_EXPECT_NICE:-}" ]; then
	[ "${1:-}" = "-n" ] &&
		[ "${2:-}" = "$VIDEOPLAYER_TEST_EXPECT_NICE" ] || exit 96
fi
case " $* " in
	*"videoplayer-${VIDEOPLAYER_TEST_NICE_DELAY_TOKEN:-not-a-token}"*)
		: > "$VIDEOPLAYER_TEST_NICE_DELAY_MARKER"
		sleep "${VIDEOPLAYER_TEST_NICE_DELAY:-0}"
		;;
esac
exec /usr/bin/nice "$@"
SH
chmod 0755 "$bin/nice"
export VIDEOPLAYER_TEST_NICE_DELAY=0.15
export VIDEOPLAYER_TEST_NICE_DELAY_MARKER="$work/nice-delay-observed"

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
printf 'audio-probe-failure fixture\n' > "$work/media/audio-probe-failure.mp4"
printf 'no-audio fixture\n' > "$work/media/no-audio.mp4"
printf 'no-audio extensionless fixture\n' > "$work/media/no-audio-extensionless"
printf 'audio-runtime-failure fixture\n' > "$work/media/audio-runtime.mp4"
printf 'audio-clean-eof fixture\n' > "$work/media/audio-clean-eof.mp4"
printf 'long-probe-audio fixture\n' > "$work/media/long-probe-audio.mp4"
printf 'blocked-probe fixture\n' > "$work/media/blocked-probe.mp4"
printf 'producer-race fixture\n' > "$work/media/producer-race.mp4"
printf 'audio-finite fixture\n' > "$work/media/audio-finite.mp4"
printf 'finite-media fixture\n' > "$work/media/finite-media.mp4"
printf 'fast-producer fixture\n' > "$work/media/fast-producer.mp4"
printf 'fast-av-producer fixture\n' > "$work/media/fast-av-producer.mp4"
printf 'video-short-audio-long fixture\n' \
	> "$work/media/video-short-audio-long.mp4"
printf 'instant-media fixture\n' > "$work/media/instant-media.mp4"
printf 'instant-media fixture\n' > "$work/media/terminal-gap.mp4"
printf 'delayed-start fixture\n' > "$work/media/delayed-start.mp4"
printf 'duration-unknown fixture\n' > "$work/media/duration-unknown.mp4"

# Exercise the RPC methods themselves with a deterministic renderer shim. The
# capture functions record typed JSON fields, so this verifies both the public
# start/status contract and that authenticated status uses the lease-renewing
# helper command rather than the read-only status path.
rpc_token=57575757575757575757575757575757
rpc_start_fields="$(
	# These harness overrides are invoked indirectly by sourced RPC handlers.
	# shellcheck disable=SC2030,SC2034,SC2317,SC2329
	(
		# shellcheck disable=SC1090
		source "$rpc_harness"
		PATH="$bin:$PATH"
		parse_request() {
			REQ_PATH='bad apple.mp4'
			REQ_TOKEN="$rpc_token"
			return 0
		}
		generate_random_token() { printf '%s\n' "$rpc_token"; }
		json_init() { :; }
		json_add_string() { printf 'string\t%s\t%s\n' "$1" "$2"; }
		json_add_int() { printf 'int\t%s\t%s\n' "$1" "$2"; }
		json_add_boolean() { printf 'boolean\t%s\t%s\n' "$1" "$2"; }
		json_dump() { :; }
		json_error() { printf 'error\t%s\n' "$1"; }
		# The worker already froze Fast/8 in media-info. A concurrent UCI
		# change must not relabel the active session as Quality/60.
		export VIDEOPLAYER_TEST_ROUTER_PROFILE=quality
		cmd_resolve '{}' router
	)
)"
printf '%s\n' "$rpc_start_fields" | grep -Fxq $'int\tduration_ms\t125500' ||
	fail "start_renderer omitted validated duration_ms"
printf '%s\n' "$rpc_start_fields" | grep -Fxq $'int\ttotal_frames\t1004' ||
	fail "start_renderer omitted validated total_frames"
printf '%s\n' "$rpc_start_fields" |
	grep -Fxq $'int\taudio_frames_per_chunk\t48000' ||
	fail "start_renderer omitted PCM chunk duration"
printf '%s\n' "$rpc_start_fields" |
	grep -Fxq $'int\taudio_batch_max_chunks\t2' ||
	fail "start_renderer omitted PCM batch limit"
printf '%s\n' "$rpc_start_fields" |
	grep -Fxq $'int\taudio_ring_chunks\t8' ||
	fail "start_renderer omitted PCM ring size"
printf '%s\n' "$rpc_start_fields" | grep -Fxq $'string\trouter_profile\tfast' ||
	fail "start_renderer omitted effective renderer profile"
printf '%s\n' "$rpc_start_fields" | grep -Fxq $'int\trouter_fps\t8' ||
	fail "fast profile did not cap configured 60 FPS to 8 FPS"
printf '%s\n' "$rpc_start_fields" |
	grep -Fxq $'boolean\trouter_max_threads\t0' ||
	fail "start_renderer omitted frozen maximum-resource mode"

rpc_quality_status_fields="$(
	# These overrides are deliberately isolated from the main lifecycle fixture.
	# shellcheck disable=SC2030,SC2031,SC2317,SC2329
	(
		export VIDEOPLAYER_TEST_ROUTER_PROFILE=quality
		export VIDEOPLAYER_TEST_ROUTER_MAX_THREADS=1
		# shellcheck disable=SC1090
		source "$rpc_harness"
		PATH="$bin:$PATH"
		json_init() { :; }
		json_add_string() { printf 'string\t%s\t%s\n' "$1" "$2"; }
		json_add_int() { printf 'int\t%s\t%s\n' "$1" "$2"; }
		json_add_boolean() { printf 'boolean\t%s\t%s\n' "$1" "$2"; }
		json_dump() { :; }
		cmd_get_status
	)
)"
printf '%s\n' "$rpc_quality_status_fields" |
	grep -Fxq $'string\trouter_profile\tquality' ||
	fail "get_status omitted the quality renderer profile"
printf '%s\n' "$rpc_quality_status_fields" | grep -Fxq $'int\trouter_fps\t60' ||
	fail "quality profile did not preserve configured 60 FPS"
printf '%s\n' "$rpc_quality_status_fields" |
	grep -Fxq $'boolean\trouter_max_threads\t1' ||
	fail "get_status omitted enabled maximum-resource mode"

rpc_status_fields="$(
	# These harness overrides are invoked indirectly by the sourced status handler.
	# shellcheck disable=SC2030,SC2031,SC2034,SC2317,SC2329
	(
		# shellcheck disable=SC1090
		source "$rpc_harness"
		parse_request() { REQ_TOKEN="$rpc_token"; return 0; }
		json_init() { :; }
		json_add_string() { printf 'string\t%s\t%s\n' "$1" "$2"; }
		json_add_int() { printf 'int\t%s\t%s\n' "$1" "$2"; }
		json_add_boolean() { printf 'boolean\t%s\t%s\n' "$1" "$2"; }
		json_dump() { :; }
		json_error() { printf 'error\t%s\n' "$1"; }
		export VIDEOPLAYER_TEST_ROUTER_PROFILE=quality
		export VIDEOPLAYER_TEST_ROUTER_MAX_THREADS=1
		cmd_renderer_status '{}'
	)
)"
printf '%s\n' "$rpc_status_fields" | grep -Fxq $'string\tstate\trunning' ||
	fail "renderer_status did not return running state"
printf '%s\n' "$rpc_status_fields" | grep -Fxq $'int\tduration_ms\t125500' ||
	fail "renderer_status omitted validated duration_ms"
printf '%s\n' "$rpc_status_fields" | grep -Fxq $'int\ttotal_frames\t1004' ||
	fail "renderer_status omitted validated total_frames"
printf '%s\n' "$rpc_status_fields" | grep -Fxq $'int\trouter_fps\t8' ||
	fail "renderer_status omitted frozen renderer FPS"
printf '%s\n' "$rpc_status_fields" |
	grep -Fxq $'string\trouter_profile\tfast' ||
	fail "renderer_status omitted frozen renderer profile"
printf '%s\n' "$rpc_status_fields" |
	grep -Fxq $'boolean\trouter_max_threads\t0' ||
	fail "renderer_status relabelled the frozen maximum-resource mode"
grep -Fq $'status-touch\t57575757575757575757575757575757\t' \
	"$rpc_call_log" || fail "renderer_status did not renew the renderer lease"

mkdir -m 0700 -- "$stream_token_dir"
printf 'bucket-v1\n' > "$stream_token_dir/.bucket-v1"
chmod 0600 "$stream_token_dir/.bucket-v1"
normal_stream_token=abababababababababababababababab
extensionless_stream_token=cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd
stream_expiry=$(( $(date +%s) + 300 ))
printf '%s\n%s\n%s\n' \
	"$normal_stream_token" "$stream_expiry" "$work/media/bad apple.mp4" \
	> "$stream_token_dir/t-aba"
printf '%s\n%s\n%s\n' \
	"$extensionless_stream_token" "$stream_expiry" \
	"$work/media/no-audio-extensionless" \
	> "$stream_token_dir/t-cdc"
chmod 0600 "$stream_token_dir/t-aba" "$stream_token_dir/t-cdc"

check_mjpeg_response() {
	python3 - "$1" "$2" "$3" "$4" <<'PY'
from pathlib import Path
import sys

payload = Path(sys.argv[1]).read_bytes()
token = sys.argv[2]
minimum_parts = int(sys.argv[3])
mode = sys.argv[4]
assert mode in {"initial", "reconnect", "finite"}, mode
head, marker, body = payload.partition(b"\r\n\r\n")
assert marker, "MJPEG CGI response has no CRLF header terminator"

lines = head.decode("ascii").split("\r\n")
assert lines[0] == "Status: 200 OK", f"{sys.argv[1]}: {lines[0]}"
headers = dict(line.split(": ", 1) for line in lines[1:])
boundary = f"videoplayer-{token}".encode("ascii")
assert headers["Content-Type"] == (
	"multipart/x-mixed-replace; boundary=" + boundary.decode("ascii")
), headers["Content-Type"]
assert "Content-Length" not in headers
assert headers["Cache-Control"].startswith("no-store")
assert headers["Cross-Origin-Resource-Policy"] == "same-origin"

delimiter = b"--" + boundary
first_boundary = body.find(delimiter)
assert first_boundary >= 0, (
	f"MJPEG body has no complete boundary: file={sys.argv[1]!r}, "
	f"bytes={len(body)}, preview={body[:160]!r}"
)
if mode in {"initial", "finite"}:
	assert first_boundary == 0, first_boundary
else:
	assert first_boundary <= 8192, first_boundary

offset = first_boundary
sequences = []
trailer = False
partial_tail = False
while True:
	assert body.startswith(delimiter, offset), (offset, body[offset : offset + 80])
	offset += len(delimiter)
	if body.startswith(b"--\r\n", offset):
		offset += 4
		trailer = True
		break
	if not body.startswith(b"\r\n", offset):
		if body[offset:] in {b"", b"\r"}:
			partial_tail = True
			offset = len(body)
			break
		raise AssertionError((offset, body[offset : offset + 80]))
	offset += 2

	# FFmpeg's mpjpeg muxer ends a clean stream with a bare boundary followed
	# by CRLF. It deliberately does not append RFC 2046's optional "--".
	if offset == len(body):
		trailer = True
		break

	part_head_end = body.find(b"\r\n\r\n", offset)
	if part_head_end < 0:
		partial_tail = True
		offset = len(body)
		break
	raw_part_headers = body[offset:part_head_end]
	assert raw_part_headers == (
		b"Content-Type: image/jpeg\r\nContent-Length: 4096"
	), raw_part_headers
	length = 4096
	offset = part_head_end + 4
	if offset + length + 2 > len(body):
		partial_tail = True
		offset = len(body)
		break
	frame = body[offset : offset + length]
	assert frame[:4] == b"\xff\xd8VP", frame[:8]
	assert frame[-2:] == b"\xff\xd9", frame[-8:]
	sequence = int.from_bytes(frame[4:8], "big")
	if sequences:
		assert sequence == sequences[-1] + 1, (sequences[-1], sequence)
	sequences.append(sequence)
	offset += length
	assert body.startswith(b"\r\n", offset)
	offset += 2
	if offset == len(body):
		break
	if not body.startswith(delimiter, offset):
		assert delimiter.startswith(body[offset:]), body[offset : offset + 80]
		partial_tail = True
		offset = len(body)
		break

assert offset == len(body), (offset, len(body))
assert len(sequences) >= minimum_parts, (len(sequences), minimum_parts)
if mode == "finite":
	assert trailer, (
		"finite FFmpeg stream has no bare-boundary trailer: "
		f"file={sys.argv[1]!r}, bytes={len(body)}, tail={body[-160:]!r}"
	)
	assert not partial_tail, "finite FFmpeg stream ended mid-part"
print(f"{len(sequences)}:{sequences[0]}:{sequences[-1]}:{first_boundary}")
PY
}

check_mjpeg_head() {
	python3 - "$1" "$2" <<'PY'
from pathlib import Path
import sys

payload = Path(sys.argv[1]).read_bytes()
head, marker, body = payload.partition(b"\r\n\r\n")
assert marker, "MJPEG HEAD response has no CRLF header terminator"
lines = head.decode("ascii").split("\r\n")
assert lines[0] == "Status: 200 OK", f"{sys.argv[1]}: {lines[0]}"
headers = dict(line.split(": ", 1) for line in lines[1:])
assert headers["Content-Type"] == (
	f"multipart/x-mixed-replace; boundary=videoplayer-{sys.argv[2]}"
)
assert "Content-Length" not in headers
assert body == b"", body
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
assert lines[0] == "Status: 200 OK", f"{sys.argv[1]}: {lines[0]}"
headers = dict(line.split(": ", 1) for line in lines[1:])
assert headers["Content-Type"] == "application/octet-stream"
assert headers["Content-Length"] == "192000"
assert headers["Accept-Ranges"] == "none"
assert headers["X-Videoplayer-Audio-Format"] == "s16le"
assert headers["X-Videoplayer-Audio-Chunk-Count"] == "1"
assert headers["X-Videoplayer-Audio-Sample-Rate"] == "48000"
assert headers["X-Videoplayer-Audio-Channels"] == "2"
assert headers["X-Videoplayer-Audio-Frames"] == "48000"
assert headers["X-Videoplayer-Audio-Frames-Per-Chunk"] == "48000"
assert headers["X-Videoplayer-Audio-Total-Frames"] == "48000"
sequence = int(headers["X-Videoplayer-Audio-Sequence"])
if sys.argv[2] == "GET":
	assert len(body) == 192000, len(body)
	assert body == bytes([sequence & 0xff]) * 192000
else:
	assert body == b"", len(body)
print(sequence)
PY
}

check_audio_batch_response() {
	python3 - "$1" "$2" "$3" "$4" <<'PY'
from pathlib import Path
import sys

payload = Path(sys.argv[1]).read_bytes()
head, marker, body = payload.partition(b"\r\n\r\n")
assert marker, "audio batch response has no CRLF header terminator"
lines = head.decode("ascii").split("\r\n")
assert lines[0] == "Status: 200 OK", f"{sys.argv[1]}: {lines[0]}"
headers = dict(line.split(": ", 1) for line in lines[1:])
start = int(sys.argv[3])
count = int(sys.argv[4])
assert headers["Content-Type"] == "application/octet-stream"
assert headers["Content-Length"] == str(count * 192000)
assert headers["X-Videoplayer-Audio-Sequence"] == str(start)
assert headers["X-Videoplayer-Audio-Chunk-Count"] == str(count)
assert headers["X-Videoplayer-Audio-Frames"] == "48000"
assert headers["X-Videoplayer-Audio-Frames-Per-Chunk"] == "48000"
assert headers["X-Videoplayer-Audio-Total-Frames"] == str(count * 48000)
if sys.argv[2] == "GET":
	assert len(body) == count * 192000, len(body)
	for offset in range(count):
		chunk = body[offset * 192000 : (offset + 1) * 192000]
		assert chunk == bytes([(start + offset) & 0xff]) * 192000
else:
	assert body == b"", len(body)
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
assert line == f"Status: {sys.argv[2]}", (
	f"{sys.argv[1]}: expected Status: {sys.argv[2]}, got {line}"
)
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
		[[ "$size" -eq 192000 ]] ||
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
		[[ "$size" -ge 0 && "$size" -le 192000 ]] ||
			fail "audio staging file exceeded one segment: $path ($size bytes)"
		[[ "${metadata%:*}" == 0:600 ]] ||
			fail "audio staging file has unsafe ownership or mode: $path"
		AUDIO_STAGED_COUNT=$((AUDIO_STAGED_COUNT + 1))
		AUDIO_TOTAL_BYTES=$((AUDIO_TOTAL_BYTES + size))
	done
	[[ "$AUDIO_STAGED_COUNT" -le 1 ]] ||
		fail "audio ring contains multiple staging files: $AUDIO_STAGED_COUNT"
	[[ "$AUDIO_FILE_COUNT" -le 8 ]] ||
		fail "audio ring exceeded its hard bound: $AUDIO_FILE_COUNT"
}

assert_audio_storage_bound() {
	[[ $((AUDIO_FILE_COUNT + AUDIO_STAGED_COUNT)) -le 8 ]] ||
		fail "audio staging exceeded the eight-slot hard bound"
	[[ "$AUDIO_TOTAL_BYTES" -le $((8 * 192000)) ]] ||
		fail "audio storage exceeded its byte bound: $AUDIO_TOTAL_BYTES"
}

run_mjpeg_cgi() {
	REQUEST_METHOD=GET \
	QUERY_STRING="token=$1&stream=$2" \
		"$helper" cgi > "$3"
}

run_mjpeg_drain_cgi() {
	REQUEST_METHOD=GET \
	QUERY_STRING="token=$1&stream=$2&drain=$3" \
		"$helper" cgi > "$4"
}

check_video_drain_complete() {
	python3 - "$1" "$2" <<'PY'
from pathlib import Path
import sys

payload = Path(sys.argv[1]).read_bytes()
head, marker, body = payload.partition(b"\r\n\r\n")
assert marker, "terminal drain response has no CRLF header terminator"
lines = head.decode("ascii").split("\r\n")
assert lines[0] == "Status: 204 No Content", f"{sys.argv[1]}: {lines[0]}"
headers = dict(line.split(": ", 1) for line in lines[1:])
assert headers["Content-Length"] == "0"
assert headers["X-Videoplayer-Video-Drain"] == "complete"
assert headers["X-Videoplayer-Video-Drain-ID"] == sys.argv[2]
assert not body, len(body)
PY
}

run_mjpeg_disconnect() {
	local -a statuses

	set +e
	REQUEST_METHOD=GET \
	QUERY_STRING="token=$1&stream=$2" \
		timeout 5 "$helper" cgi |
		head -c 10000 > "$3"
	statuses=("${PIPESTATUS[@]}")
	set -e

	[[ "${statuses[1]}" -eq 0 ]] ||
		fail "MJPEG disconnect sink failed: ${statuses[*]}"
	case "${statuses[0]}" in
		0|141)
			;;
		*)
			fail "MJPEG producer ignored disconnect: ${statuses[*]}"
			;;
	esac
}

run_mjpeg_head() {
	REQUEST_METHOD=HEAD \
	QUERY_STRING="token=$1" \
		"$helper" cgi > "$2"
}

run_audio_cgi() {
	REQUEST_METHOD="$1" \
	QUERY_STRING="token=$2&chunk=$3" \
		"$helper" cgi-audio > "$4"
}

run_audio_batch_cgi() {
	REQUEST_METHOD="$1" \
	QUERY_STRING="token=$2&chunk=$3&count=$4" \
		"$helper" cgi-audio > "$5"
}

run_uncontended_audio_cgi() {
	local method="$1" token="$2" chunk="$3" output="$4"
	local range="${5:-}" status

	for _ in {1..80}; do
		if [[ -n "$range" ]]; then
			HTTP_RANGE="$range" \
			REQUEST_METHOD="$method" \
			QUERY_STRING="token=$token&chunk=$chunk" \
				"$helper" cgi-audio > "$output"
		else
			run_audio_cgi "$method" "$token" "$chunk" "$output"
		fi
		status="$(head -n 1 "$output" | tr -d '\r')"
		if [[ "$status" != 'Status: 409 Conflict' ]] ||
		   ! grep -Fq $'X-Videoplayer-Audio-State: busy\r' "$output"; then
			return 0
		fi
		sleep 0.05
	done
}

# The production client retries a generic 409 while a previous PCM response or
# a terminal audio-state transition briefly owns audio.lock. Mirror that
# bounded behaviour here for requests which are expected to be ready. Only the
# explicit busy state is retryable; absence/error must not be hidden as a lock
# overlap, and a persistent busy lock still hits the bounded deadline.
run_ready_audio_batch_cgi() {
	local method="$1" token="$2" chunk="$3" count="$4" output="$5"
	local status

	for _ in {1..80}; do
		run_audio_batch_cgi "$method" "$token" "$chunk" "$count" "$output"
		status="$(head -n 1 "$output" | tr -d '\r')"
		case "$status" in
			'Status: 200 OK')
				return 0
				;;
			'Status: 409 Conflict')
				if ! grep -Fq $'X-Videoplayer-Audio-State: busy\r' \
					"$output"; then
					return 0
				fi
				;;
			*)
				return 0
				;;
		esac
		sleep 0.05
	done
}

run_stream_cgi() {
	REQUEST_METHOD="$1" \
	QUERY_STRING="renderer=$2&audio=$3" \
	HTTP_RANGE="${5:-}" \
		"$stream_helper" > "$4"
}

run_token_stream_cgi() {
	REQUEST_METHOD="$1" \
	QUERY_STRING="token=$2" \
	HTTP_RANGE="${4:-}" \
		"$stream_helper" > "$3"
}

check_stream_body_file() {
	python3 - "$1" "$2" <<'PY'
from pathlib import Path
import sys

response = Path(sys.argv[1]).read_bytes()
expected = Path(sys.argv[2]).read_bytes()
parts = response.split(b"\r\n\r\n", 1)
assert len(parts) == 2, "missing CGI header delimiter"
assert parts[1] == expected, (parts[1], expected)
PY
}

check_stream_body_slice() {
	python3 - "$1" "$2" "$3" "$4" <<'PY'
from pathlib import Path
import sys

response = Path(sys.argv[1]).read_bytes()
source = Path(sys.argv[2]).read_bytes()
start = int(sys.argv[3])
end = int(sys.argv[4])
parts = response.split(b"\r\n\r\n", 1)
assert len(parts) == 2, "missing CGI header delimiter"
assert parts[1] == source[start : end + 1], (parts[1], source[start : end + 1])
PY
}

token1=0123456789abcdef0123456789abcdef
token2=fedcba9876543210fedcba9876543210
export VIDEOPLAYER_TEST_NICE_DELAY_TOKEN="$token1"
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
audio_probe_failure=53535353535353535353535353535353
no_audio=34343434343434343434343434343434
no_audio_capability=45454545454545454545454545454545
audio_failure=35353535353535353535353535353535
audio_clean_eof=54545454545454545454545454545454
long_probe_audio=55555555555555555555555555555555
blocked_probe=56565656565656565656565656565656
producer_race=57575757575757575757575757575757
identity_fail_closed=58585858585858585858585858585858
finite_audio=36363636363636363636363636363636
chunker_failure=37373737373737373737373737373737
finite_media=38383838383838383838383838383838
missing_audio_state=60606060606060606060606060606060
fast_producer=50505050505050505050505050505050
quality_producer=51515151515151515151515151515151
max_threads_producer=61616161616161616161616161616161
fast_av_producer=52525252525252525252525252525252
instant_media=39393939393939393939393939393939
lease_touch=42424242424242424242424242424242
lease_expire=43434343434343434343434343434343
long_audio=44444444444444444444444444444444
duration_unknown=46464646464646464646464646464646
terminal_gap=47474747474747474747474747474747
stale=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
media="$work/media/bad apple.mp4"

export VIDEOPLAYER_TEST_RENDER_MODE=browser
run_token_stream_cgi GET "$normal_stream_token" "$work/token-stream"
check_status_line "$work/token-stream" "200 OK"
grep -Fq $'Content-Type: video/mp4\r' "$work/token-stream" ||
	fail "normal browser stream used an unexpected MIME type"
check_stream_body_file "$work/token-stream" "$work/media/bad apple.mp4"
run_token_stream_cgi GET "$extensionless_stream_token" \
	"$work/token-extensionless"
check_status_line "$work/token-extensionless" "415 Unsupported Media Type"
REQUEST_METHOD=GET \
	QUERY_STRING="token=$normal_stream_token&renderer=$no_audio&audio=$no_audio_capability" \
"$stream_helper" > "$work/token-mixed-query"
check_status_line "$work/token-mixed-query" "400 Bad Request"
unset VIDEOPLAYER_TEST_RENDER_MODE

mv -- "$bin/ffmpeg" "$bin/ffmpeg.good"
cat > "$bin/ffmpeg" <<'SH'
#!/bin/sh
: > "$VIDEOPLAYER_SYSTEM_FAIL_MARKER"
exit 0
SH
chmod 0755 "$bin/ffmpeg"
export VIDEOPLAYER_SYSTEM_FAIL_MARKER="$work/system-ffmpeg-used"
set +e
missing_private_output="$("$helper" probe 2>&1)"
missing_private_rc=$?
set -e
assert_eq "$missing_private_rc" 1 "missing private runtime probe"
[[ "$missing_private_output" == *"metadata failed attestation"* ]] ||
	fail "missing private runtime diagnostic was not strict"
[[ ! -e "$VIDEOPLAYER_SYSTEM_FAIL_MARKER" ]] ||
	fail "system FFmpeg was invoked without an attested private runtime"
mv -f -- "$bin/ffmpeg.good" "$bin/ffmpeg"

mkdir -m 0755 -- "$work/private-libexec" "$work/private-share"
mkdir -m 0755 -- "$private_exec_dir" "$private_info_dir"
cp -- "$bin/ffmpeg" "$private_ffmpeg"
chmod 0755 "$private_ffmpeg"
cat > "$private_build_info" <<EOF
format=4
renderer_profile=software-cpu-v1
execution_backend=software-cpu-v1
software_cpu_only=1
private_binary=$private_ffmpeg
EOF
chmod 0644 "$private_build_info"

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
assert_eq \
	"$("$helper" attest)" \
	$'private-software-cpu\tsoftware-cpu-v1\tnone' \
	"strict runtime attestation contract"
[[ ! -e "$VIDEOPLAYER_SYSTEM_FAIL_MARKER" ]] ||
	fail "system FFmpeg was probed despite a usable static private runtime"
mv -f -- "$bin/ffmpeg.good" "$bin/ffmpeg"

mkdir -m 0755 -- "$work/private-lib"
mkdir -m 0755 -- "$private_lib_dir"
printf 'private library fixture\n' > "$private_lib_dir/libfixture.so"
chmod 0644 "$private_lib_dir/libfixture.so"

# A valid but unusable private runtime fails closed; no system fallback exists.
mv -- "$private_ffmpeg" "$private_ffmpeg.good"
cat > "$private_ffmpeg" <<'SH'
#!/bin/sh
: > "$VIDEOPLAYER_PRIVATE_FAIL_MARKER"
exit 80
SH
chmod 0755 "$private_ffmpeg"
export VIDEOPLAYER_PRIVATE_FAIL_MARKER="$work/private-probe-failed"
export VIDEOPLAYER_EXPECT_PRIVATE_LIB=""
set +e
"$helper" probe >/dev/null 2>&1
broken_private_rc=$?
set -e
assert_eq "$broken_private_rc" 1 "broken private FFmpeg fail-closed probe"
[[ -f "$VIDEOPLAYER_PRIVATE_FAIL_MARKER" ]] ||
	fail "broken private FFmpeg was not capability-probed"
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
set +e
"$helper" probe >/dev/null 2>&1
unsafe_private_rc=$?
set -e
assert_eq "$unsafe_private_rc" 1 "unsafe private FFmpeg fail-closed probe"
[[ ! -e "$VIDEOPLAYER_UNSAFE_PRIVATE_MARKER" ]] ||
	fail "unsafe private FFmpeg runtime was executed"
chmod 0755 "$private_lib_dir"
mv -f -- "$private_ffmpeg.good" "$private_ffmpeg"

export VIDEOPLAYER_EXPECT_PRIVATE_LIB="$private_lib_dir"
# The package marker is part of the runtime trust boundary. Duplicate security
# fields are rejected instead of relying on first/last-value parsing.
cp -- "$private_build_info" "$private_build_info.good"
printf 'execution_backend=browser\n' >> "$private_build_info"
set +e
"$helper" attest >/dev/null 2>&1
bad_build_info_rc=$?
set -e
assert_eq "$bad_build_info_rc" 1 "malformed build-info attestation"
mv -f -- "$private_build_info.good" "$private_build_info"
chmod 0644 "$private_build_info"

# The real FFmpeg legend uses the same six-character flag shape as codec rows
# (`V..... = Video`) and must be ignored, while any actual decoder outside the
# native software allowlist remains fatal to attestation.
mv -- "$private_ffmpeg" "$private_ffmpeg.good"
export VIDEOPLAYER_PRIVATE_GOOD="$private_ffmpeg.good"
cat > "$private_ffmpeg" <<'SH'
#!/bin/sh
"$VIDEOPLAYER_PRIVATE_GOOD" "$@"
rc=$?
[ "$rc" -eq 0 ] || exit "$rc"
case " $* " in
	*' -decoders '*)
		printf '%s\n' ' V..... h264_v4l2m2m forbidden wrapper'
		;;
esac
exit 0
SH
chmod 0755 "$private_ffmpeg"
set +e
unexpected_decoder_output="$("$helper" attest 2>&1)"
unexpected_decoder_rc=$?
set -e
assert_eq "$unexpected_decoder_rc" 1 "unexpected decoder attestation"
[[ "$unexpected_decoder_output" == *"decoder set differs"* ]] ||
	fail "unexpected decoder did not fail the exact software allowlist"
mv -f -- "$private_ffmpeg.good" "$private_ffmpeg"
unset VIDEOPLAYER_PRIVATE_GOOD

# A configure option merely containing the required spelling is not an exact
# `--disable-encoders` attestation token.
mv -- "$private_ffmpeg" "$private_ffmpeg.good"
export VIDEOPLAYER_PRIVATE_GOOD="$private_ffmpeg.good"
cat > "$private_ffmpeg" <<'SH'
#!/bin/sh
case " $* " in
	*' -buildconf '*)
		"$VIDEOPLAYER_PRIVATE_GOOD" "$@" |
			sed 's/--disable-encoders/--disable-encoders-extra/'
		exit 0
		;;
esac
exec "$VIDEOPLAYER_PRIVATE_GOOD" "$@"
SH
chmod 0755 "$private_ffmpeg"
set +e
inexact_encoder_flag_output="$("$helper" attest 2>&1)"
inexact_encoder_flag_rc=$?
set -e
assert_eq "$inexact_encoder_flag_rc" 1 \
	"inexact disable-encoders build flag attestation"
[[ "$inexact_encoder_flag_output" == *"not a software-only build"* ]] ||
	fail "inexact disable-encoders token passed build attestation"
mv -f -- "$private_ffmpeg.good" "$private_ffmpeg"
unset VIDEOPLAYER_PRIVATE_GOOD

# Encoder attestation is equally exact: the strict runtime may publish only
# native MJPEG video and PCM s16le audio. A hardware wrapper or any other extra
# encoder invalidates the software-cpu-v1 claim even when both required
# encoders are still present.
mv -- "$private_ffmpeg" "$private_ffmpeg.good"
export VIDEOPLAYER_PRIVATE_GOOD="$private_ffmpeg.good"
cat > "$private_ffmpeg" <<'SH'
#!/bin/sh
"$VIDEOPLAYER_PRIVATE_GOOD" "$@"
rc=$?
[ "$rc" -eq 0 ] || exit "$rc"
case " $* " in
	*' -encoders '*)
		printf '%s\n' ' V..... h264_v4l2m2m forbidden wrapper'
		;;
esac
exit 0
SH
chmod 0755 "$private_ffmpeg"
set +e
unexpected_encoder_output="$("$helper" attest 2>&1)"
unexpected_encoder_rc=$?
set -e
assert_eq "$unexpected_encoder_rc" 1 "unexpected encoder attestation"
[[ "$unexpected_encoder_output" == *"encoder set differs"* ]] ||
	fail "unexpected encoder did not fail the exact software allowlist"
mv -f -- "$private_ffmpeg.good" "$private_ffmpeg"
unset VIDEOPLAYER_PRIVATE_GOOD

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
noisy_worker="$(session_pid "$noisy_diagnostics" worker)"
diagnostic_size="$(stat -c '%s' "$runtime/s-$noisy_diagnostics/ffmpeg.log")"
[[ "$diagnostic_size" -gt 0 && "$diagnostic_size" -le 65536 ]] ||
	fail "diagnostic capture exceeded its 64 KiB limit: $diagnostic_size"
assert_eq \
	"$("$helper" stop "$noisy_diagnostics")" \
	stopped \
	"stop after large diagnostic stream"
if [[ -e "$runtime/s-$noisy_diagnostics/ffmpeg.log" ||
      -e "$runtime/s-$noisy_diagnostics/ffmpeg-log.pipe" ]]; then
	noisy_artifacts="$(
		stat -c '%n:%F:%u:%a:%s' -- \
			"$runtime/s-$noisy_diagnostics/ffmpeg.log" \
			"$runtime/s-$noisy_diagnostics/ffmpeg-log.pipe" \
			2>/dev/null || true
	)"
	noisy_status="$("$helper" status "$noisy_diagnostics" 2>&1 || true)"
	noisy_worker_alive=no
	kill -0 "$noisy_worker" 2>/dev/null && noisy_worker_alive=yes
	fail "large diagnostic stream artifacts were not cleaned: $noisy_artifacts; status=$noisy_status; worker_alive=$noisy_worker_alive"
fi

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

# An advertised audio stream is part of the strict CPU contract. A private
# runtime which can inventory but cannot decode its first PCM frame must abort
# startup instead of silently relabelling the source as video-only.
set +e
audio_probe_failure_output="$(
	"$helper" start \
		"$audio_probe_failure" "$work/media/audio-probe-failure.mp4" 2>&1
)"
audio_probe_failure_rc=$?
set -e
assert_eq "$audio_probe_failure_rc" 1 \
	"advertised audio decode failure exit code"
assert_eq \
	"$audio_probe_failure_output" \
	"Source audio cannot be decoded by the private CPU runtime" \
	"advertised audio decode failure reason"
assert_eq \
	"$("$helper" status "$audio_probe_failure")" \
	inactive \
	"advertised audio decode failure cleanup"
if "$helper" has-audio "$audio_probe_failure" \
	> "$work/startup-failed-has-audio"; then
	fail "failed audio startup was relabelled as a source without audio"
fi
[[ ! -s "$work/startup-failed-has-audio" ]] ||
	fail "failed audio startup emitted a false no-audio value"

# The general info probe is deliberately truncated at 64 KiB. This fixture
# prints more than that much subtitle inventory before its real audio
# declaration, so only the separate bounded mandatory-map/PCM probe can detect
# it. The session must be audio-ready (or fail closed), never silently absent.
assert_eq \
	"$("$helper" start "$long_probe_audio" "$work/media/long-probe-audio.mp4")" \
	started \
	"audio declaration beyond bounded info log"
assert_eq "$("$helper" has-audio "$long_probe_audio")" 1 \
	"late audio declaration source classification"
assert_eq "$("$helper" audio-state "$long_probe_audio")" ready \
	"late audio declaration strict audio state"
assert_eq "$("$helper" stop "$long_probe_audio")" stopped \
	"late audio declaration stop"

# Probe FFmpeg children inherit the worker-lock descriptor until they exit.
# Kill both the control-side start invocation and the untrapped worker while a
# real private executable is blocked in the source probe: maintenance must
# publish its durable gate but cannot quiesce or authorize package mutation
# until that exact executable releases the lifecycle barrier.
rm -f -- "$blocked_probe_ready" "$blocked_probe_release"
"$helper" start "$blocked_probe" "$work/media/blocked-probe.mp4" \
	> "$work/blocked-probe-start" 2>&1 &
blocked_probe_start_pid=$!
for _ in {1..100}; do
	[[ -s "$blocked_probe_ready" &&
	   -f "$runtime/s-$blocked_probe/worker" ]] && break
	sleep 0.02
done
[[ -s "$blocked_probe_ready" ]] ||
	fail "private FFmpeg did not enter the blocked source probe"
blocked_probe_ffmpeg="$(< "$blocked_probe_ready")"
[[ "$blocked_probe_ffmpeg" =~ ^[0-9]+$ ]] ||
	fail "blocked probe did not publish a valid private FFmpeg PID"
blocked_probe_worker="$(session_pid "$blocked_probe" worker)"
assert_eq \
	"$(readlink -f -- "/proc/$blocked_probe_ffmpeg/exe")" \
	"$private_ffmpeg" \
	"blocked probe private executable identity"
assert_eq \
	"$(readlink -f -- "/proc/$blocked_probe_ffmpeg/fd/8")" \
	"$runtime.worker.lock" \
	"blocked probe worker-lock inheritance"
kill -KILL "$blocked_probe_start_pid"
wait "$blocked_probe_start_pid" 2>/dev/null || :
blocked_probe_start_pid=""
kill -TERM "$blocked_probe_worker"
wait_dead "$blocked_probe_worker"
kill -0 "$blocked_probe_ffmpeg" 2>/dev/null ||
	fail "source probe did not survive the pre-trap worker termination"
"$helper" maintenance-enter > "$work/blocked-probe-maintenance" 2>&1 &
maintenance_enter_pid=$!
for _ in {1..100}; do
	[[ -f "$maintenance_file" ]] && break
	sleep 0.02
done
[[ -f "$maintenance_file" ]] ||
	fail "maintenance did not publish its gate during blocked probe teardown"
sleep 0.1
kill -0 "$maintenance_enter_pid" 2>/dev/null ||
	fail "maintenance bypassed the live private source-probe executable"
assert_eq \
	"$(readlink -f -- "/proc/$blocked_probe_ffmpeg/exe")" \
	"$private_ffmpeg" \
	"private source probe remains attested while maintenance waits"
touch "$blocked_probe_release"
set +e
wait "$maintenance_enter_pid"
blocked_probe_maintenance_rc=$?
set -e
maintenance_enter_pid=""
assert_eq "$blocked_probe_maintenance_rc" 0 \
	"maintenance after blocked probe release"
assert_eq "$(< "$work/blocked-probe-maintenance")" maintenance \
	"blocked probe maintenance result"
wait_dead "$blocked_probe_ffmpeg"
blocked_probe_ffmpeg=""
blocked_probe_worker=""
for probe_exe in /proc/[0-9]*/exe; do
	[[ "$(readlink -f -- "$probe_exe" 2>/dev/null || true)" != \
	   "$private_ffmpeg" ]] ||
		fail "private FFmpeg survived successful maintenance quiescence"
done
assert_eq "$("$helper" maintenance-exit)" resumed \
	"resume after blocked source-probe quiescence"

# The long-lived producer keeps the same barrier through its pre-identity
# launch window. Pause immediately after fork, kill both controlling shells,
# and prove maintenance still waits for the unrecorded private executable.
rm -f -- "$producer_identity_ready" "$producer_identity_release"
: > "$producer_identity_ready.arm"
"$helper" start "$producer_race" "$work/media/producer-race.mp4" \
	> "$work/producer-race-start" 2>&1 &
producer_race_start_pid=$!
for _ in {1..200}; do
	[[ -s "$producer_identity_ready" &&
	   -f "$runtime/s-$producer_race/worker" ]] && break
	sleep 0.02
done
[[ -s "$producer_identity_ready" ]] ||
	fail "producer did not enter its pre-identity launch window"
producer_race_ffmpeg="$(< "$producer_identity_ready")"
producer_race_worker="$(session_pid "$producer_race" worker)"
[[ ! -e "$runtime/s-$producer_race/ffmpeg" ]] ||
	fail "producer identity was published before the deterministic pause"
assert_eq \
	"$(readlink -f -- "/proc/$producer_race_ffmpeg/exe")" \
	"$private_ffmpeg" \
	"pre-identity producer private executable"
assert_eq \
	"$(readlink -f -- "/proc/$producer_race_ffmpeg/fd/8")" \
	"$runtime.worker.lock" \
	"pre-identity producer worker-lock inheritance"
kill -KILL "$producer_race_start_pid"
wait "$producer_race_start_pid" 2>/dev/null || :
producer_race_start_pid=""
kill -KILL "$producer_race_worker"
wait_dead "$producer_race_worker"
"$helper" maintenance-enter > "$work/producer-race-maintenance" 2>&1 &
maintenance_enter_pid=$!
for _ in {1..100}; do
	[[ -f "$maintenance_file" ]] && break
	sleep 0.02
done
[[ -f "$maintenance_file" ]] ||
	fail "producer-race maintenance did not publish its gate"
sleep 0.1
kill -0 "$maintenance_enter_pid" 2>/dev/null ||
	fail "maintenance bypassed the unrecorded private producer"
kill -0 "$producer_race_ffmpeg" 2>/dev/null ||
	fail "unrecorded private producer exited before barrier assertion"
touch "$producer_identity_release"
# The worker died before publishing an identity, so the controller cannot
# safely address this PID. Simulate the private process's eventual exit only
# after maintenance has demonstrably blocked; the lifecycle barrier, not PID
# guessing, must be what releases package mutation.
kill -KILL "$producer_race_ffmpeg" 2>/dev/null || :
wait_dead "$producer_race_ffmpeg"
set +e
wait "$maintenance_enter_pid"
producer_race_maintenance_rc=$?
set -e
maintenance_enter_pid=""
if [[ "$producer_race_maintenance_rc" -ne 0 ]]; then
	producer_race_worker_state="$($helper status "$producer_race" 2>&1 || true)"
	producer_race_current="$(sed -n '1,8p' "$runtime/current" 2>/dev/null || true)"
	producer_race_lock_holders="$(
		for fd in /proc/[0-9]*/fd/8; do
			[[ "$(readlink -f -- "$fd" 2>/dev/null || true)" == \
			   "$runtime.worker.lock" ]] && printf '%s\n' "$fd"
		done
		:
	)"
	fail "maintenance after pre-identity producer release: rc=$producer_race_maintenance_rc; output=$(< "$work/producer-race-maintenance"); status=$producer_race_worker_state; current=$producer_race_current; lock_holders=$producer_race_lock_holders"
fi
assert_eq "$(< "$work/producer-race-maintenance")" maintenance \
	"pre-identity producer maintenance result"
producer_race_ffmpeg=""
producer_race_worker=""
rm -f -- "$producer_identity_ready.arm"
assert_eq "$("$helper" maintenance-exit)" resumed \
	"resume after pre-identity producer quiescence"

# A source which genuinely advertises no audio remains a valid silent CPU
# session. It must not expose any original-source browser-audio capability.
assert_eq \
	"$(
		VIDEOPLAYER_TEST_DECODER_THREADS=1 \
		VIDEOPLAYER_EXPECT_DECODER_THREADS=1 \
			"$helper" start "$no_audio" "$work/media/no-audio-extensionless"
	)" \
	started \
	"video-only start"
assert_eq \
	"$("$helper" media-info "$no_audio")" \
	$'125500\t1004\t8\tfast\tprivate-software-cpu\tsoftware-cpu-v1\tnone\t0' \
	"video-only duration metadata"
assert_eq "$("$helper" has-audio "$no_audio")" 0 "video-only audio capability"
assert_eq "$("$helper" audio-state "$no_audio")" absent \
	"strict video-only audio state"
for removed_command in source authorize-browser-audio source-info position-ms; do
	if "$helper" "$removed_command" "$no_audio" "$no_audio_capability" \
		>/dev/null 2>&1; then
		fail "removed browser-audio helper command remained callable: $removed_command"
	fi
done
run_mjpeg_cgi "$no_audio" 1-1 "$work/no-audio-mjpeg"
check_mjpeg_response \
	"$work/no-audio-mjpeg" "$no_audio" 1 initial >/dev/null
run_audio_cgi GET "$no_audio" live "$work/audio-response"
check_status_line "$work/audio-response" "409 Conflict"
grep -Fq 'Source has no audio stream' "$work/audio-response" ||
	fail "silent CPU source did not report strict source absence"
assert_eq "$("$helper" status "$no_audio")" running "video-only status"
assert_eq "$("$helper" stop "$no_audio")" stopped "video-only stop"

# FFmpeg must be allowed to fill the browser prebuffer faster than wall time.
# This clock-free fake produces an audio-less stream as quickly as FIFO
# backpressure permits. Two native-relay responses contain forty media seconds
# at the fast profile's effective 8 FPS and must finish in substantially less
# wall time; the argv validator
# above separately rejects both -re and every -readrate* pacing option.
assert_eq \
	"$("$helper" start "$fast_producer" "$work/media/fast-producer.mp4")" \
	started \
	"fast producer start"
fast_worker="$(session_pid "$fast_producer" worker)"
# Mutating UCI after start must not change this session's 8 FPS timeline or
# its 160-frame (20 media second) response cap.
# shellcheck disable=SC2031
export VIDEOPLAYER_TEST_ROUTER_PROFILE=quality
fast_started_ns="$(python3 -c 'import time; print(time.monotonic_ns())')"
run_mjpeg_cgi "$fast_producer" 1-1 "$work/fast-producer-1"
IFS=: read -r fast_parts_1 fast_first_1 fast_last_1 fast_preamble_1 <<< "$(
	check_mjpeg_response \
		"$work/fast-producer-1" "$fast_producer" 100 initial
)"
run_mjpeg_cgi "$fast_producer" 1-2 "$work/fast-producer-2"
IFS=: read -r fast_parts_2 fast_first_2 fast_last_2 fast_preamble_2 <<< "$(
	check_mjpeg_response \
		"$work/fast-producer-2" "$fast_producer" 100 reconnect
)"
fast_finished_ns="$(python3 -c 'import time; print(time.monotonic_ns())')"
fast_elapsed_ms=$(( (fast_finished_ns - fast_started_ns) / 1000000 ))
fast_media_ms=$(( (fast_parts_1 + fast_parts_2) * 1000 / 8 ))
[[ "$fast_preamble_1" -eq 0 && "$fast_preamble_2" -le 8192 &&
	"$fast_parts_1" -le 160 && "$fast_parts_2" -le 160 &&
   "$fast_first_1" -le "$fast_last_1" &&
   "$fast_first_2" -le "$fast_last_2" &&
   "$fast_first_2" -gt "$fast_last_1" ]] ||
	fail "fast producer responses did not preserve monotonic MJPEG handoff"
[[ "$fast_media_ms" -gt $((fast_elapsed_ms * 2)) ]] ||
	fail "renderer transport remained wall-clock paced: media=${fast_media_ms}ms, wall=${fast_elapsed_ms}ms"
assert_eq "$($helper stop "$fast_producer")" stopped "fast producer stop"
wait_dead "$fast_worker"
fast_worker=""
export VIDEOPLAYER_TEST_ROUTER_PROFILE=fast

# The unified A/V tee must also outrun wall time. Drain two one-second PCM
# chunks per request while the native relay consumes two 160-frame segments;
# this catches accidental pacing in either side of the shared producer.
assert_eq \
	"$("$helper" start "$fast_av_producer" "$work/media/fast-av-producer.mp4")" \
	started \
	"fast A/V producer start"
fast_av_worker="$(session_pid "$fast_av_producer" worker)"
fast_av_drain_error="$work/fast-av-drain.error"
fast_av_drain_stop="$work/fast-av-drain.stop"
rm -f -- "$fast_av_drain_error" "$fast_av_drain_stop"
(
	sequence=0
	attempts=0
	IFS='. ' read -r uptime_seconds _ < /proc/uptime
	deadline=$((uptime_seconds + 20))
	while [[ ! -e "$fast_av_drain_stop" ]]; do
		attempts=$((attempts + 1))
		IFS='. ' read -r uptime_seconds _ < /proc/uptime
		if [[ "$attempts" -gt 1000 || "$uptime_seconds" -gt "$deadline" ]]; then
			printf 'fast A/V audio drain exceeded its bounded deadline at %s\n' \
				"$sequence" > "$fast_av_drain_error"
			exit 1
		fi
		run_audio_batch_cgi \
			GET "$fast_av_producer" "$sequence" 2 \
			"$work/fast-av-audio-response"
		case "$(head -n 1 "$work/fast-av-audio-response" | tr -d '\r')" in
			'Status: 200 OK')
				check_audio_batch_response \
					"$work/fast-av-audio-response" GET "$sequence" 2
				sequence=$((sequence + 2))
				;;
			'Status: 202 Accepted')
				sleep 0.01
				;;
			'Status: 409 Conflict')
				if grep -Fq $'X-Videoplayer-Audio-State: busy\r' \
					"$work/fast-av-audio-response"; then
					sleep 0.01
				else
					printf 'fast A/V audio lost strict readiness at %s\n' \
						"$sequence" > "$fast_av_drain_error"
					exit 1
				fi
				;;
			*)
				printf 'unexpected fast A/V audio response at %s\n' "$sequence" \
					> "$fast_av_drain_error"
				exit 1
				;;
		esac
	done
) &
fast_av_drain_pid=$!
fast_av_started_ns="$(python3 -c 'import time; print(time.monotonic_ns())')"
run_mjpeg_cgi "$fast_av_producer" 52-1 "$work/fast-av-video-1"
IFS=: read -r fast_av_parts_1 _ _ _ <<< "$(
	check_mjpeg_response \
		"$work/fast-av-video-1" "$fast_av_producer" 32 initial
)"
run_mjpeg_cgi "$fast_av_producer" 52-2 "$work/fast-av-video-2"
IFS=: read -r fast_av_parts_2 _ _ _ <<< "$(
	check_mjpeg_response \
		"$work/fast-av-video-2" "$fast_av_producer" 32 reconnect
)"
: > "$fast_av_drain_stop"
wait "$fast_av_drain_pid"
fast_av_drain_pid=""
[[ ! -e "$fast_av_drain_error" ]] ||
	fail "$(< "$fast_av_drain_error")"
fast_av_finished_ns="$(python3 -c 'import time; print(time.monotonic_ns())')"
fast_av_elapsed_ms=$(( (fast_av_finished_ns - fast_av_started_ns) / 1000000 ))
fast_av_media_ms=$(( (fast_av_parts_1 + fast_av_parts_2) * 1000 / 8 ))
[[ "$fast_av_parts_1" -le 160 && "$fast_av_parts_2" -le 160 ]] ||
	fail "fast A/V session ignored its frozen segment frame cap"
[[ "$fast_av_media_ms" -gt $((fast_av_elapsed_ms * 2)) ]] ||
	fail "unified A/V pipeline remained wall-clock paced: media=${fast_av_media_ms}ms, wall=${fast_av_elapsed_ms}ms"
assert_eq \
	"$("$helper" stop "$fast_av_producer")" \
	stopped \
	"fast A/V producer stop"
wait_dead "$fast_av_worker"
fast_av_worker=""

# The opt-in quality profile preserves the configured 60 FPS timeline and the
# legacy 640x360/q8/optimal-Huffman pipeline. The FFmpeg stub rejects any
# cross-profile option leakage.
export VIDEOPLAYER_TEST_ROUTER_PROFILE=quality
export VIDEOPLAYER_EXPECT_PROFILE=quality
export VIDEOPLAYER_EXPECT_FPS=60
assert_eq \
	"$("$helper" start "$quality_producer" "$work/media/fast-producer.mp4")" \
	started \
	"quality producer start"
quality_worker="$(session_pid "$quality_producer" worker)"
assert_eq \
	"$("$helper" media-info "$quality_producer")" \
	$'125500\t7530\t60\tquality\tprivate-software-cpu\tsoftware-cpu-v1\tnone\t0' \
	"quality profile preserved configured FPS"
run_mjpeg_cgi "$quality_producer" 51-1 "$work/quality-producer"
IFS=: read -r quality_parts quality_first quality_last quality_preamble <<< "$(
	check_mjpeg_response \
		"$work/quality-producer" "$quality_producer" 100 initial
)"
[[ "$quality_parts" -le 300 && "$quality_preamble" -eq 0 &&
   "$quality_first" -le "$quality_last" ]] ||
	fail "quality producer did not use its frozen 300-frame response cap"
assert_eq \
	"$("$helper" stop "$quality_producer")" \
	stopped \
	"quality producer stop"
wait_dead "$quality_worker"
quality_worker=""

# Maximum-resource multithreading deliberately removes the default Quality
# pipeline cap and reduced scheduler priority. Simulate a 32-thread router:
# filters and MJPEG receive all 32 threads, while decoder safety stays capped
# at FFmpeg 6.1.4's 16-thread limit. The frozen media-info flag must survive
# any later UCI change.
# shellcheck disable=SC2031
export VIDEOPLAYER_TEST_ROUTER_MAX_THREADS=1
export VIDEOPLAYER_TEST_DECODER_THREADS=32
export VIDEOPLAYER_EXPECT_DECODER_THREADS=16
export VIDEOPLAYER_EXPECT_PIPELINE_THREADS=32
export VIDEOPLAYER_TEST_EXPECT_NICE=0
assert_eq \
	"$("$helper" start "$max_threads_producer" "$work/media/fast-producer.mp4")" \
	started \
	"maximum-resource producer start"
max_threads_worker="$(session_pid "$max_threads_producer" worker)"
assert_eq \
	"$("$helper" media-info "$max_threads_producer")" \
	$'125500\t7530\t60\tquality\tprivate-software-cpu\tsoftware-cpu-v1\tnone\t1' \
	"maximum-resource mode was not frozen in media info"
export VIDEOPLAYER_TEST_ROUTER_MAX_THREADS=0
assert_eq \
	"$("$helper" media-info "$max_threads_producer")" \
	$'125500\t7530\t60\tquality\tprivate-software-cpu\tsoftware-cpu-v1\tnone\t1' \
	"active maximum-resource session followed a later UCI change"
assert_eq \
	"$("$helper" stop "$max_threads_producer")" \
	stopped \
	"maximum-resource producer stop"
wait_dead "$max_threads_worker"
max_threads_worker=""
unset VIDEOPLAYER_TEST_DECODER_THREADS
unset VIDEOPLAYER_EXPECT_PIPELINE_THREADS
unset VIDEOPLAYER_TEST_EXPECT_NICE
export VIDEOPLAYER_EXPECT_DECODER_THREADS="$VIDEOPLAYER_BOUNDED_DECODER_THREADS"
export VIDEOPLAYER_TEST_ROUTER_PROFILE=fast
export VIDEOPLAYER_EXPECT_PROFILE=fast
export VIDEOPLAYER_EXPECT_FPS=8

# Unknown container duration is valid but must stay unpublished rather than
# accepting a metadata key that merely contains a spoofed Duration substring.
assert_eq \
	"$("$helper" start \
		"$duration_unknown" "$work/media/duration-unknown.mp4")" \
	started \
	"unknown-duration start"
assert_eq \
	"$("$helper" media-info "$duration_unknown")" \
	$'0\t0\t8\tfast\tprivate-software-cpu\tsoftware-cpu-v1\tnone\t0' \
	"unknown-duration metadata"
assert_eq \
	"$("$helper" stop "$duration_unknown")" \
	stopped \
	"unknown-duration stop"

# A one-frame input may exit before the worker's first monitoring pass. Its
# complete mpjpeg stream must still make start succeed and remain fetchable
# long enough for the web UI to observe the session.
assert_eq \
	"$("$helper" start "$instant_media" "$work/media/instant-media.mp4")" \
	started \
	"instant-media start"
instant_worker="$(session_pid "$instant_media" worker)"
assert_eq \
	"$("$helper" status "$instant_media")" \
	running \
	"instant-media startup grace"
run_mjpeg_cgi "$instant_media" 1-1 "$work/instant-mjpeg"
check_mjpeg_response \
	"$work/instant-mjpeg" "$instant_media" 1 finite >/dev/null
status_touch_ready="$work/status-touch-ready"
status_touch_release="$work/status-touch-release"
rm -f -- "$status_touch_ready" "$status_touch_release"
VIDEOPLAYER_TEST_STATUS_TOUCH_READY="$status_touch_ready" \
	VIDEOPLAYER_TEST_STATUS_TOUCH_RELEASE="$status_touch_release" \
	"$helper" status-touch "$instant_media" \
	> "$work/status-touch-race" &
status_touch_race_pid=$!
for _ in {1..100}; do
	[[ -f "$status_touch_ready" ]] && break
	sleep 0.05
done
[[ -f "$status_touch_ready" ]] ||
	fail "status-touch race did not reach its deterministic gate"
for _ in {1..200}; do
	[[ "$("$helper" status "$instant_media")" == ended ]] && break
	sleep 0.05
done
now="$(date +%s)"
heartbeat_tmp="$runtime/s-$instant_media/.heartbeat-status-race"
(umask 077; printf '%s\n' "$((now - 80))" > "$heartbeat_tmp")
chmod 0600 "$heartbeat_tmp"
mv -f -- "$heartbeat_tmp" "$runtime/s-$instant_media/heartbeat"
touch "$status_touch_release"
wait "$status_touch_race_pid"
status_touch_race_pid=""
assert_eq \
	"$(< "$work/status-touch-race")" \
	ended \
	"status-touch running-to-ended transition"
assert_eq \
	"$("$helper" status "$instant_media")" \
	ended \
	"instant-media final status"
wait_dead "$instant_worker"
assert_eq \
	"$("$helper" stop "$instant_media")" \
	stopped \
	"instant-media stop"
wait_dead "$instant_worker"

# If no bounded response remains open at renderer EOF, the browser must claim
# the retained FIFO writer explicitly. A read-only check cannot consume data;
# drain=1 receives the tail and creates a nonce-bound completion marker; only a
# second check with the same nonce receives the authenticated 204 response.
assert_eq \
	"$("$helper" start "$terminal_gap" "$work/media/terminal-gap.mp4")" \
	started \
	"terminal-gap start"
terminal_gap_worker="$(session_pid "$terminal_gap" worker)"
for _ in {1..200}; do
	[[ "$("$helper" status "$terminal_gap")" == ended ]] && break
	sleep 0.05
done
assert_eq \
	"$("$helper" status "$terminal_gap")" \
	ended \
	"terminal-gap ended before drain claim"
run_mjpeg_cgi "$terminal_gap" 47-0 "$work/terminal-no-drain"
check_status_line "$work/terminal-no-drain" "410 Gone"
run_mjpeg_drain_cgi \
	"$terminal_gap" 47-1 check "$work/terminal-check-pending"
check_status_line "$work/terminal-check-pending" "202 Accepted"
run_mjpeg_drain_cgi \
	"$terminal_gap" 47-1 1 "$work/terminal-drain-body"
check_mjpeg_response \
	"$work/terminal-drain-body" "$terminal_gap" 1 finite >/dev/null
run_mjpeg_drain_cgi \
	"$terminal_gap" 47-2 check "$work/terminal-check-wrong-nonce"
check_status_line "$work/terminal-check-wrong-nonce" "202 Accepted"
run_mjpeg_drain_cgi \
	"$terminal_gap" 47-1 check "$work/terminal-check-complete"
check_video_drain_complete "$work/terminal-check-complete" 47-1
assert_eq \
	"$(stat -c '%u:%a' -- "$runtime/s-$terminal_gap/video-drained")" \
	0:600 \
	"terminal drain marker permissions"
assert_eq \
	"$(< "$runtime/s-$terminal_gap/video-drained")" \
	$'snapshot-v1\n47474747474747474747474747474747\n47-1\ncomplete' \
	"terminal drain marker binding"
wait_dead "$terminal_gap_worker"
assert_eq \
	"$("$helper" status-touch "$terminal_gap")" \
	ended \
	"terminal status remains observable without source retention"
assert_eq \
	"$("$helper" status "$terminal_gap")" \
	ended \
	"terminal-gap final status"
assert_eq \
	"$("$helper" stop "$terminal_gap")" \
	stopped \
	"terminal-gap stop"
wait_dead "$terminal_gap_worker"
terminal_gap_worker=""

# A short source audio track is padded until the longer video ends. Use a
# A 1.13-second video ends between one-second PCM boundaries; asetnsamples
# after apad must still publish only complete 192,000-byte chunks.
assert_eq \
	"$("$helper" start "$finite_audio" "$work/media/audio-finite.mp4")" \
	started \
	"finite-audio start"
finite_worker="$(session_pid "$finite_audio" worker)"
finite_ffmpeg="$(session_pid "$finite_audio" ffmpeg)"
run_mjpeg_cgi "$finite_audio" 1-1 "$work/finite-audio-mjpeg" &
finite_audio_cgi=$!
for _ in {1..100}; do
	[[ "$(sed -n '2p' "$runtime/s-$finite_audio/audio-state")" == ended ]] &&
		break
	sleep 0.05
done
wait "$finite_audio_cgi"
finite_audio_cgi=""
check_mjpeg_response \
	"$work/finite-audio-mjpeg" "$finite_audio" 10 finite >/dev/null
assert_eq \
	"$(sed -n '2p' "$runtime/s-$finite_audio/audio-state")" \
	ended \
	"finite-audio final state"
inspect_audio_ring "$finite_audio"
assert_eq "$AUDIO_FILE_COUNT" 2 "finite-audio padded chunk count"
assert_audio_storage_bound
assert_eq "$("$helper" has-audio "$finite_audio")" 1 "finite-audio capability"
run_audio_batch_cgi GET "$finite_audio" 0 2 "$work/audio-batch-response"
check_audio_batch_response "$work/audio-batch-response" GET 0 2
run_audio_batch_cgi HEAD "$finite_audio" 0 2 "$work/audio-batch-response"
check_audio_batch_response "$work/audio-batch-response" HEAD 0 2
run_audio_batch_cgi GET "$finite_audio" 0 3 "$work/audio-batch-response"
check_status_line "$work/audio-batch-response" "400 Bad Request"
run_audio_cgi GET "$finite_audio" live "$work/audio-response"
check_audio_response "$work/audio-response" GET >/dev/null
case "$("$helper" status "$finite_audio")" in
	running|ended) ;;
	*) fail "finite-audio video did not finish cleanly" ;;
esac
assert_eq "$("$helper" stop "$finite_audio")" stopped "finite-audio stop"
wait_dead "$finite_worker"
wait_dead "$finite_ffmpeg"

# A much longer source audio track must not keep the shared FFmpeg producer,
# status, or MJPEG FIFO alive after the authoritative video reaches EOF. This
# is the short-video/long-audio deadlock that tee + apad + -shortest prevents.
assert_eq \
	"$("$helper" start \
		"$long_audio" "$work/media/video-short-audio-long.mp4")" \
	started \
	"long-audio start"
long_audio_worker="$(session_pid "$long_audio" worker)"
long_audio_ffmpeg="$(session_pid "$long_audio" ffmpeg)"
run_mjpeg_cgi "$long_audio" 1-1 "$work/long-audio-mjpeg" &
long_audio_cgi=$!
for _ in {1..160}; do
	[[ "$(sed -n '2p' "$runtime/s-$long_audio/audio-state")" == ended ]] &&
		break
	sleep 0.05
done
wait "$long_audio_cgi"
long_audio_cgi=""
check_mjpeg_response \
	"$work/long-audio-mjpeg" "$long_audio" 10 finite >/dev/null
assert_eq \
	"$(sed -n '2p' "$runtime/s-$long_audio/audio-state")" \
	ended \
	"long-audio video-authoritative state"
wait_dead "$long_audio_ffmpeg"
inspect_audio_ring "$long_audio"
assert_eq "$AUDIO_FILE_COUNT" 2 "long-audio truncated chunk count"
assert_audio_storage_bound
case "$("$helper" status "$long_audio")" in
	running|ended) ;;
	*) fail "long-audio video did not finish cleanly" ;;
esac
assert_eq \
	"$("$helper" stop "$long_audio")" \
	stopped \
	"long-audio stop"
wait_dead "$long_audio_worker"

# A still-present malformed or symlinked process identity is never the benign
# unlink race covered above. Stop must fail before signalling any child, leave
# the suspicious entry untouched for diagnosis, and succeed only after the
# original root-owned identity has been restored.
assert_eq \
	"$("$helper" start "$identity_fail_closed" "$media")" \
	started \
	"identity fail-closed start"
identity_dir="$runtime/s-$identity_fail_closed"
identity_worker="$(session_pid "$identity_fail_closed" worker)"
identity_ffmpeg="$(session_pid "$identity_fail_closed" ffmpeg)"
mv -- "$identity_dir/ffmpeg" "$identity_dir/.ffmpeg.identity.good"
ln -s -- "$work" "$identity_dir/ffmpeg"
set +e
identity_symlink_output="$(
	"$helper" stop "$identity_fail_closed" 2>&1
)"
identity_symlink_rc=$?
set -e
assert_eq "$identity_symlink_rc" 3 "symlinked identity stop rc"
assert_eq "$identity_symlink_output" inactive "symlinked identity stop"
[[ -L "$identity_dir/ffmpeg" ]] ||
	fail "stop replaced or removed a symlinked process identity"
kill -0 "$identity_worker" "$identity_ffmpeg" 2>/dev/null ||
	fail "stop signalled a child before rejecting a symlinked identity"
rm -f -- "$identity_dir/ffmpeg"
mv -- "$identity_dir/.ffmpeg.identity.good" "$identity_dir/ffmpeg"

mv -- "$identity_dir/worker" "$identity_dir/.worker.identity.good"
printf 'malformed identity\n' > "$identity_dir/worker"
chmod 0600 "$identity_dir/worker"
set +e
identity_malformed_output="$(
	"$helper" stop "$identity_fail_closed" 2>&1
)"
identity_malformed_rc=$?
set -e
assert_eq "$identity_malformed_rc" 3 "malformed identity stop rc"
assert_eq "$identity_malformed_output" inactive "malformed identity stop"
[[ -f "$identity_dir/worker" && ! -L "$identity_dir/worker" ]] ||
	fail "stop replaced or removed a malformed process identity"
assert_eq \
	"$(< "$identity_dir/worker")" \
	"malformed identity" \
	"malformed identity preservation"
kill -0 "$identity_worker" "$identity_ffmpeg" 2>/dev/null ||
	fail "stop signalled a child before rejecting a malformed identity"
rm -f -- "$identity_dir/worker"
mv -- "$identity_dir/.worker.identity.good" "$identity_dir/worker"
rm -f -- "$identity_unlink_race_hit"
assert_eq \
	"$(
		VIDEOPLAYER_TEST_IDENTITY_UNLINK_RACE=1 \
		VIDEOPLAYER_TEST_IDENTITY_UNLINK_RACE_HIT="$identity_unlink_race_hit" \
			"$helper" stop "$identity_fail_closed"
	)" \
	stopped \
	"identity unlink-race stop"
[[ -f "$identity_unlink_race_hit" ]] ||
	fail "identity unlink-race hook was not exercised"
wait_dead "$identity_worker"
wait_dead "$identity_ffmpeg"
identity_worker=""
identity_ffmpeg=""

# Once video reaches EOF, completed PCM chunks remain readable without keeping
# the original source descriptor or worker alive after terminal drain.
assert_eq \
	"$(
		VIDEOPLAYER_TEST_DECODER_THREADS=1 \
		VIDEOPLAYER_EXPECT_DECODER_THREADS=1 \
			"$helper" start "$finite_media" "$work/media/finite-media.mp4"
	)" \
	started \
	"finite-media start"
finite_media_worker="$(session_pid "$finite_media" worker)"
# A very short child may finish before /proc exposes a trustworthy start time.
# The saved, validated prefetch still makes the finite session observable; do
# not require a live-process identity for a producer that has already exited.
run_mjpeg_cgi "$finite_media" 1-1 "$work/finite-media-mjpeg"
check_mjpeg_response \
	"$work/finite-media-mjpeg" "$finite_media" 4 finite >/dev/null
for _ in {1..200}; do
	[[ "$("$helper" status "$finite_media")" == ended ]] && break
	sleep 0.05
done
assert_eq "$("$helper" status "$finite_media")" ended "finite-media status"
wait_dead "$finite_media_worker"
assert_eq \
	"$(sed -n '2p' "$runtime/s-$finite_media/audio-state")" \
	ended \
	"finite-media audio state"
assert_eq "$("$helper" has-audio "$finite_media")" 1 \
	"finite-media ended source audio capability"
run_audio_cgi GET "$finite_media" live "$work/audio-response"
finite_media_audio_sequence="$(
	check_audio_response "$work/audio-response" GET
)"
run_audio_cgi \
	GET "$finite_media" "$((finite_media_audio_sequence + 1))" \
	"$work/audio-response"
check_status_line "$work/audio-response" "204 No Content"
assert_eq "$("$helper" stop "$finite_media")" stopped "finite-media stop"

# Missing or malformed persisted state is not evidence that a strict audio
# pipeline completed successfully. Finalization must fail closed even when
# FFmpeg and the chunker both exit 0 and leave a valid final PCM chunk.
assert_eq \
	"$(
		VIDEOPLAYER_TEST_REMOVE_AUDIO_STATE_TOKEN="$missing_audio_state" \
			"$helper" start \
				"$missing_audio_state" "$work/media/finite-media.mp4"
	)" \
	started \
	"missing final audio state start"
missing_audio_state_worker="$(session_pid "$missing_audio_state" worker)"
run_mjpeg_cgi \
	"$missing_audio_state" 1-1 "$work/missing-audio-state-mjpeg"
for _ in {1..200}; do
	[[ "$("$helper" status "$missing_audio_state")" == error ]] && break
	sleep 0.05
done
assert_eq "$("$helper" status "$missing_audio_state")" error \
	"missing final audio state session status"
wait_dead "$missing_audio_state_worker"
missing_audio_state_worker=""
assert_eq \
	"$(sed -n '2p' "$runtime/s-$missing_audio_state/audio-state")" \
	error \
	"missing final audio state persisted error"
if "$helper" has-audio "$missing_audio_state" \
	> "$work/missing-state-has-audio"; then
	fail "missing final audio state was relabelled as a source capability"
fi
[[ ! -s "$work/missing-state-has-audio" ]] ||
	fail "missing final audio state emitted a false no-audio value"
assert_eq "$("$helper" stop "$missing_audio_state")" stopped \
	"missing final audio state stop"

# A PCM failure after successful startup is fatal to the whole strict CPU
# session. It must never preserve video as a partial CPU-rendering session.
assert_eq \
	"$("$helper" start "$audio_failure" "$work/media/audio-runtime.mp4")" \
	started \
	"audio-failure start"
for _ in {1..200}; do
	[[ "$("$helper" status "$audio_failure")" == error ]] && break
	sleep 0.05
done
assert_eq "$("$helper" status "$audio_failure")" error \
	"audio-failure strict session status"
assert_eq "$("$helper" audio-state "$audio_failure")" error \
	"audio-failure strict audio state"
run_audio_cgi GET "$audio_failure" live "$work/audio-response"
check_status_line "$work/audio-response" "503 Service Unavailable"
assert_eq "$("$helper" stop "$audio_failure")" stopped "audio-failure stop"

# Even an exit-0 PCM EOF is fatal while video is still being produced. With
# apad enabled, a valid short audio source cannot end this output early; doing
# so means the strict CPU audio branch disappeared mid-session.
assert_eq \
	"$("$helper" start "$audio_clean_eof" "$work/media/audio-clean-eof.mp4")" \
	started \
	"clean early PCM EOF start"
audio_clean_eof_worker="$(session_pid "$audio_clean_eof" worker)"
# Keep the video tee slave flowing until the fake closes only its PCM slave;
# otherwise a small host FIFO could backpressure video before the fourth chunk.
run_mjpeg_cgi \
	"$audio_clean_eof" 54-0 "$work/audio-clean-eof-mjpeg" &
audio_clean_eof_video_cgi=$!
for _ in {1..240}; do
	[[ "$("$helper" status "$audio_clean_eof")" == error ]] && break
	sleep 0.05
done
assert_eq "$("$helper" status "$audio_clean_eof")" error \
	"clean early PCM EOF strict session status"
assert_eq "$("$helper" audio-state "$audio_clean_eof")" error \
	"clean early PCM EOF strict audio state"
wait_dead "$audio_clean_eof_worker"
audio_clean_eof_worker=""
assert_eq \
	"$(sed -n '2p' "$runtime/s-$audio_clean_eof/audio-state")" \
	error \
	"clean early PCM EOF persisted audio state"
if "$helper" has-audio "$audio_clean_eof" > "$work/failed-has-audio"; then
	fail "failed advertised audio was relabelled as a source capability"
fi
[[ ! -s "$work/failed-has-audio" ]] ||
	fail "failed advertised audio emitted a false no-audio value"
wait "$audio_clean_eof_video_cgi"
audio_clean_eof_video_cgi=""
assert_eq "$("$helper" stop "$audio_clean_eof")" stopped \
	"clean early PCM EOF stop"

# Killing the CPU PCM chunker also terminates video; partial strict CPU sessions
# are forbidden even when the MJPEG side could technically continue.
assert_eq \
	"$("$helper" start "$chunker_failure" "$media")" \
	started \
	"chunker-failure start"
chunker_failure_worker="$(session_pid "$chunker_failure" worker)"
chunker_failure_ffmpeg="$(session_pid "$chunker_failure" ffmpeg)"
chunker_failure_chunker="$(session_pid "$chunker_failure" chunker)"
# Drain video concurrently so the tee can publish the initial PCM chunks.
run_mjpeg_cgi \
	"$chunker_failure" 1-0 "$work/chunker-failure-prime-mjpeg" &
chunker_failure_video_cgi=$!
chunker_failure_initial_state=""
for _ in {1..100}; do
	if [[ -f "$runtime/s-$chunker_failure/audio-state" ]]; then
		chunker_failure_initial_state="$(sed -n '2p' \
			"$runtime/s-$chunker_failure/audio-state")"
	fi
	[[ "$("$helper" has-audio "$chunker_failure")" == 1 &&
	   "$chunker_failure_initial_state" == running ]] && break
	sleep 0.05
done
assert_eq \
	"$("$helper" has-audio "$chunker_failure")" \
	1 \
	"chunker-failure initial audio state"
assert_eq \
	"$chunker_failure_initial_state" \
	running \
	"chunker-failure published running audio state"
kill -KILL "$chunker_failure_chunker"
wait_dead "$chunker_failure_chunker"
for _ in {1..200}; do
	[[ "$("$helper" status "$chunker_failure")" == error ]] && break
	sleep 0.05
done
assert_eq \
	"$("$helper" status "$chunker_failure")" \
	error \
	"chunker failure terminates strict CPU session"
wait "$chunker_failure_video_cgi"
chunker_failure_video_cgi=""
assert_eq \
	"$("$helper" audio-state "$chunker_failure")" \
	error \
	"chunker-failure strict audio state"
inspect_audio_ring "$chunker_failure"
assert_audio_storage_bound
assert_eq \
	"$("$helper" stop "$chunker_failure")" \
	stopped \
	"chunker-failure stop"
wait_dead "$chunker_failure_worker"
wait_dead "$chunker_failure_ffmpeg"

assert_eq "$("$helper" start "$token1" "$media")" started "start"
assert_eq "$("$helper" status "$token1")" running "status after start"
assert_eq \
	"$("$helper" media-info "$token1")" \
	$'125500\t1004\t8\tfast\tprivate-software-cpu\tsoftware-cpu-v1\tnone\t0' \
	"validated renderer media metadata"
assert_eq \
	"$(stat -c '%u:%a' -- "$runtime/s-$token1/media-info")" \
	0:600 \
	"renderer media metadata permissions"

assert_eq \
	"$(stat -c '%u:%a' -- "$runtime")" \
	0:700 \
	"runtime permissions"

assert_eq \
	"$(stat -c '%u:%a:%F' -- "$runtime/s-$token1/video.pipe")" \
	0:600:fifo \
	"video FIFO permissions"
[[ ! -e "$runtime/s-$token1/frame.jpg" ]] ||
	fail "legacy frame snapshot unexpectedly exists"

worker1="$(session_pid "$token1" worker)"
ffmpeg1="$(session_pid "$token1" ffmpeg)"
chunker1="$(session_pid "$token1" chunker)"
kill -0 "$worker1"
kill -0 "$ffmpeg1"
kill -0 "$chunker1"
source_descriptor_identity="$(stat -Lc '%d:%i' -- "$media")"
for worker_fd in "/proc/$worker1/fd"/*; do
	[[ "$(stat -Lc '%d:%i' -- "$worker_fd" 2>/dev/null || true)" != \
	   "$source_descriptor_identity" ]] ||
		fail "renderer worker retained the protected original source descriptor as ${worker_fd##*/}"
done
assert_eq \
	"$(tr '\000' '\n' < "/proc/$ffmpeg1/cmdline" | sed -n '1p')" \
	"$private_ffmpeg" \
	"private FFmpeg process identity"
assert_eq \
	"$(readlink -f -- "/proc/$ffmpeg1/exe")" \
	"$private_ffmpeg" \
	"private FFmpeg executable identity"
assert_eq \
	"$(tr '\000' '\n' < "/proc/$ffmpeg1/cmdline" | tail -n 1)" \
	"[select=v:f=mpjpeg:boundary_tag=videoplayer-$token1]$runtime/s-$token1/video.pipe|[select=a:f=s16le:onfail=ignore]$runtime/s-$token1/audio.pipe" \
	"unified tee FFmpeg process identity"
if tr '\000' '\n' < "/proc/$ffmpeg1/cmdline" |
	grep -Fqx -e "$runtime/s-$token1/video.pipe" \
		-e "$runtime/s-$token1/audio.pipe"; then
	fail "shared FFmpeg unexpectedly exposes a standalone output argument"
fi
if tr '\000' '\n' < "/proc/$ffmpeg1/cmdline" | grep -Fqx -- -re; then
	fail "shared FFmpeg process is still throttled by -re"
fi
[[ ! -e "$runtime/s-$token1/audio" ]] ||
	fail "legacy separate audio FFmpeg identity unexpectedly exists"
assert_eq \
	"$(tr '\000' '\n' < "/proc/$chunker1/cmdline" | sed -n '3p')" \
	audio-chunker \
	"audio chunker process identity"
assert_eq "$("$helper" has-audio "$token1")" 1 "audio capability"
[[ -e "$VIDEOPLAYER_TEST_NICE_DELAY_MARKER" ]] ||
	fail "private FFmpeg exec-identity race was not exercised"

# A competing PCM request must fail fast with the explicit retryable busy
# state. Holding this descriptor also proves the CGI uses a nonblocking lock
# instead of consuming a second uhttpd worker until the first response finishes.
exec 7< "$runtime/s-$token1/audio.lock"
flock -x 7
run_audio_cgi GET "$token1" live "$work/audio-busy-response"
exec 7<&-
check_status_line "$work/audio-busy-response" "409 Conflict"
grep -Fq $'X-Videoplayer-Audio-State: busy\r' \
	"$work/audio-busy-response" ||
	fail "busy PCM response omitted its bounded-retry state"

# Drain video while forcing audio-ring saturation. With no PCM acknowledgement,
# the chunker must preserve the first eight unacknowledged chunks and
# backpressure the shared producer before reading another PCM block.
# A PCM chunk represents one second, so the clock-faithful fake needs roughly
# eight seconds to fill eight slots. Reconnect bounded MJPEG segments throughout
# that interval so the video FIFO cannot become the source of backpressure.
(
	for segment in {0..4}; do
		run_mjpeg_cgi \
			"$token1" "10-$segment" \
			"$work/mjpeg-ring-fill-$segment"
	done
) &
ring_fill_pid=$!
ring_saturated=0
for _ in {1..240}; do
	inspect_audio_ring "$token1"
	[[ "$AUDIO_FILE_COUNT" -eq 8 ]] && ring_saturated=1
	[[ "$ring_saturated" -eq 1 ]] && break
	sleep 0.05
done
[[ "$ring_saturated" -eq 1 ]] ||
	fail "audio ring did not reach the hard-bound test condition"
wait "$ring_fill_pid"
ring_fill_pid=""
: > "$audio_capacity_race_arm"
for _ in {1..100}; do
	[[ -e "$audio_capacity_race_ready" ]] && break
	sleep 0.02
done
[[ -e "$audio_capacity_race_ready" ]] ||
	fail "audio capacity ACK/delete race hook was not reached"
inspect_audio_ring "$token1"
hard_bound_count=$((AUDIO_FILE_COUNT + AUDIO_STAGED_COUNT))
hard_bound_bytes="$AUDIO_TOTAL_BYTES"
[[ "$hard_bound_count" -le 8 ]] ||
	fail "saturated audio ring exceeded eight storage slots: $hard_bound_count"
[[ "$hard_bound_bytes" -le $((8 * 192000)) ]] ||
	fail "saturated audio ring exceeded its byte bound: $hard_bound_bytes"
[[ -f "$runtime/s-$token1/audio-00000000.pcm" ]] ||
	fail "unacknowledged first audio chunk was overwritten"
assert_eq \
	"$(sed -n '2p' "$runtime/s-$token1/audio-ack")" \
	0 \
	"initial audio acknowledgement"

# HEAD is read-only even when it describes a complete future batch. A request
# beyond the published high-water mark is also non-destructive: validating the
# entire requested batch must happen before ACK/deletion is committed.
run_ready_audio_batch_cgi HEAD "$token1" 2 2 "$work/audio-batch-head-2"
check_audio_batch_response "$work/audio-batch-head-2" HEAD 2 2
run_ready_audio_batch_cgi GET "$token1" 8 1 "$work/audio-batch-invalid"
check_status_line "$work/audio-batch-invalid" "202 Accepted"
assert_eq \
	"$(sed -n '2p' "$runtime/s-$token1/audio-ack")" \
	0 \
	"non-destructive HEAD and not-ready batch"
inspect_audio_ring "$token1"
assert_eq "$AUDIO_FILE_COUNT" 8 "unacknowledged saturated audio ring"
for sequence in {0..7}; do
	[[ -f "$runtime/s-$token1/audio-$(printf '%08d' "$sequence").pcm" ]] ||
		fail "audio chunk $sequence disappeared before acknowledgement"
done

# GET(S) acknowledges only chunks strictly before S. The current response can
# therefore be retried after a lost HTTP body, while a later valid S releases
# capacity and lets the same FFmpeg producer resume both tracks.
run_ready_audio_batch_cgi GET "$token1" 0 2 "$work/audio-batch-get-0"
check_audio_batch_response "$work/audio-batch-get-0" GET 0 2
for sequence in {0..1}; do
	[[ -f "$runtime/s-$token1/audio-$(printf '%08d' "$sequence").pcm" ]] ||
		fail "current audio batch was deleted before it could be retried"
done
run_ready_audio_batch_cgi GET "$token1" 0 2 "$work/audio-batch-retry"
check_audio_batch_response "$work/audio-batch-retry" GET 0 2
# The full-ring chunker is held by the disposable hook immediately after it
# read the old ACK=0 snapshot. GET(2) now atomically advances ACK and deletes
# 0..1. Holding audio.lock before releasing the hook proves both invariants:
# the chunker rechecks ACK after observing the missing oldest file, and its
# capacity path no longer collides with valid browser requests. The old
# implementation either reports false corruption or blocks on this lock.
run_ready_audio_batch_cgi GET "$token1" 2 2 "$work/audio-batch-get-2"
check_audio_batch_response "$work/audio-batch-get-2" GET 2 2
exec 7< "$runtime/s-$token1/audio.lock"
flock -x 7
: > "$audio_capacity_race_release"
assert_eq \
	"$(sed -n '2p' "$runtime/s-$token1/audio-ack")" \
	2 \
	"advanced audio acknowledgement"
for sequence in {0..1}; do
	[[ ! -e "$runtime/s-$token1/audio-$(printf '%08d' "$sequence").pcm" ]] ||
		fail "acknowledged audio chunk $sequence was not released"
done
[[ -f "$runtime/s-$token1/audio-00000002.pcm" ]] ||
	fail "current acknowledged audio batch was not retained for retry"
audio_unblocked=0
for _ in {1..100}; do
	[[ -f "$runtime/s-$token1/audio-00000008.pcm" ]] && audio_unblocked=1
	[[ "$audio_unblocked" -eq 1 ]] && break
	sleep 0.02
done
exec 7<&-
[[ "$audio_unblocked" -eq 1 ]] ||
	fail "valid next audio batch did not unblock the lock-free shared producer"

# Model an active browser consumer while the MJPEG lifecycle cases run. Each
# request advances the ACK by one batch and keeps only its own retryable batch;
# the long prebuffer itself remains browser-side rather than in router tmpfs.
audio_drain_stop="$work/audio-drain.stop"
audio_drain_error="$work/audio-drain.error"
rm -f -- "$audio_drain_stop" "$audio_drain_error"
(
	sequence=4
	while [[ ! -e "$audio_drain_stop" ]]; do
		run_ready_audio_batch_cgi \
			GET "$token1" "$sequence" 2 "$work/audio-drain-response"
		case "$(head -c 32 "$work/audio-drain-response")" in
			'Status: 200 OK'*) sequence=$((sequence + 2)) ;;
			'Status: 202 Accepted'*) sleep 0.02 ;;
			*)
				printf '%s\n' \
					"unexpected audio drain response for chunk $sequence" \
					> "$audio_drain_error"
				exit 1
				;;
		esac
	done
) &
audio_drain_pid=$!

heartbeat="$runtime/s-$token1/heartbeat"
before="$(< "$heartbeat")"

# Token-only requests expose FFmpeg's continuous multipart MJPEG stream. HEAD
# describes it without acquiring the single-viewer lock or renewing playback.
run_mjpeg_head "$token1" "$work/mjpeg-head"
check_mjpeg_head "$work/mjpeg-head" "$token1"
assert_eq "$(< "$heartbeat")" "$before" "MJPEG HEAD heartbeat"

# Keep one stream open long enough to prove that continuous FFmpeg output shares
# one HTTP response. A concurrent viewer must fail fast instead of consuming
# all of uhttpd's bounded CGI worker slots.
while [[ "$(date +%s)" -le "$before" ]]; do
	sleep 0.05
done
ffmpeg_identity_before="$(< "$runtime/s-$token1/ffmpeg")"
run_mjpeg_cgi "$token1" 1-1 "$work/mjpeg-response" &
mjpeg_pid=$!
for _ in {1..100}; do
	grep -aFq 'Content-Type: multipart/x-mixed-replace; boundary=' \
		"$work/mjpeg-response" 2>/dev/null && break
	sleep 0.02
done
grep -aFq 'Content-Type: multipart/x-mixed-replace; boundary=' \
	"$work/mjpeg-response" ||
	fail "MJPEG stream did not publish its headers"
assert_eq \
	"$(stat -c '%u:%a' -- "$runtime/s-$token1/stream.lock")" \
	0:600 \
	"MJPEG stream lock permissions"
run_mjpeg_cgi "$token1" 1-2 "$work/mjpeg-conflict"
check_status_line "$work/mjpeg-conflict" "409 Conflict"
wait "$mjpeg_pid"
IFS=: read -r \
	mjpeg_parts mjpeg_first mjpeg_last mjpeg_preamble <<< "$(
		check_mjpeg_response \
			"$work/mjpeg-response" "$token1" 12 initial
	)"
[[ "$mjpeg_parts" -ge 12 && "$mjpeg_first" -le "$mjpeg_last" ]] ||
	fail "invalid initial MJPEG sequence summary"
assert_eq "$mjpeg_preamble" 0 "initial MJPEG preamble"
after="$(< "$heartbeat")"
[[ "$after" -gt "$before" ]] || fail "MJPEG stream did not refresh heartbeat"
assert_eq \
	"$(< "$runtime/s-$token1/ffmpeg")" \
	"$ffmpeg_identity_before" \
	"FFmpeg identity after bounded stream"

# A new bounded segment must acquire the lock after the previous response
# closes. It may begin with the tail of the in-flight part, but complete parts
# must continue the same producer's increasing sequence.
run_mjpeg_cgi "$token1" 1-3 "$work/mjpeg-reconnected"
IFS=: read -r \
	reconnected_parts reconnected_first reconnected_last \
	reconnected_preamble <<< "$(
		check_mjpeg_response \
			"$work/mjpeg-reconnected" "$token1" 12 reconnect
)"
[[ "$reconnected_parts" -ge 12 &&
   "$reconnected_preamble" -le 8192 &&
   "$reconnected_first" -le "$reconnected_last" ]] ||
	fail "invalid reconnected MJPEG sequence summary"
[[ "$reconnected_first" -gt "$mjpeg_last" ]] ||
	fail "MJPEG reconnect replayed an old frame sequence"
assert_eq \
	"$(< "$runtime/s-$token1/ffmpeg")" \
	"$ffmpeg_identity_before" \
	"FFmpeg identity after reconnect"

# A browser may close a response without reading its remainder. SIGPIPE must
# release the viewer lock without killing or restarting the persistent FFmpeg
# producer, and the following reconnect must resume at a later frame.
run_mjpeg_disconnect "$token1" 1-4 "$work/mjpeg-disconnected"
IFS=: read -r \
	disconnected_parts disconnected_first disconnected_last \
	disconnected_preamble <<< "$(
		check_mjpeg_response \
			"$work/mjpeg-disconnected" "$token1" 1 reconnect
	)"
[[ "$disconnected_parts" -ge 1 &&
   "$disconnected_preamble" -le 8192 &&
   "$disconnected_first" -le "$disconnected_last" ]] ||
	fail "invalid disconnected MJPEG sequence summary"
[[ "$disconnected_first" -gt "$reconnected_last" ]] ||
	fail "MJPEG disconnect stream replayed an old frame sequence"
kill -0 "$ffmpeg1"
assert_eq \
	"$(< "$runtime/s-$token1/ffmpeg")" \
	"$ffmpeg_identity_before" \
	"FFmpeg identity after client disconnect"
assert_eq "$("$helper" status "$token1")" running \
	"status after MJPEG client disconnect"

run_mjpeg_cgi "$token1" 1-5 "$work/mjpeg-after-disconnect"
IFS=: read -r \
	after_disconnect_parts after_disconnect_first after_disconnect_last \
	after_disconnect_preamble <<< "$(
		check_mjpeg_response \
			"$work/mjpeg-after-disconnect" "$token1" 12 reconnect
	)"
[[ "$after_disconnect_parts" -ge 12 &&
   "$after_disconnect_preamble" -le 8192 &&
   "$after_disconnect_first" -le "$after_disconnect_last" ]] ||
	fail "invalid post-disconnect MJPEG sequence summary"
[[ "$after_disconnect_first" -gt "$disconnected_last" ]] ||
	fail "MJPEG stream did not advance after client disconnect"
assert_eq \
	"$(< "$runtime/s-$token1/ffmpeg")" \
	"$ffmpeg_identity_before" \
	"FFmpeg identity after disconnect reconnect"

before="$(< "$heartbeat")"
REQUEST_METHOD=GET \
QUERY_STRING="token=$token1&stream=not-a-number" \
	"$helper" cgi > "$work/mjpeg-invalid"
check_status_line "$work/mjpeg-invalid" "400 Bad Request"
REQUEST_METHOD=GET \
QUERY_STRING="token=$token1&stream=1&extra=1" \
	"$helper" cgi > "$work/mjpeg-invalid"
check_status_line "$work/mjpeg-invalid" "400 Bad Request"
REQUEST_METHOD=POST \
QUERY_STRING="token=$token1&stream=1" \
	"$helper" cgi > "$work/mjpeg-invalid"
check_status_line "$work/mjpeg-invalid" "405 Method Not Allowed"
assert_eq "$(< "$heartbeat")" "$before" "invalid MJPEG request heartbeat"

touch -- "$audio_drain_stop"
if ! wait "$audio_drain_pid"; then
	fail "browser-side audio batch drain failed"
fi
audio_drain_pid=""
[[ ! -e "$audio_drain_error" ]] ||
	fail "$(< "$audio_drain_error")"

for _ in {1..30}; do
	run_uncontended_audio_cgi GET "$token1" live "$work/audio-response"
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
run_uncontended_audio_cgi HEAD "$token1" "$audio_sequence" \
	"$work/audio-response"
assert_eq \
	"$(check_audio_response "$work/audio-response" HEAD)" \
	"$audio_sequence" \
	"audio HEAD sequence"
assert_eq "$(< "$heartbeat")" "$before" "audio HEAD heartbeat"

run_uncontended_audio_cgi GET "$token1" "$audio_sequence" \
	"$work/audio-response" 'bytes=0-3'
check_status_line "$work/audio-response" "416 Range Not Satisfiable"
assert_eq "$(< "$heartbeat")" "$before" "audio Range heartbeat"

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
wait_dead "$chunker1"

# A background tab may get only one JavaScript timer callback per minute.
# Verify that a 60-second pause does not reclaim the sole renderer, then that
# authenticated status polling renews its 90-second lease during prebuffering.
assert_eq "$("$helper" start "$lease_touch" "$media")" started \
	"status-touch lease start"
lease_touch_worker="$(session_pid "$lease_touch" worker)"
now="$(date +%s)"
heartbeat_tmp="$runtime/s-$lease_touch/.heartbeat-test"
(umask 077; printf '%s\n' "$((now - 60))" > "$heartbeat_tmp")
chmod 0600 "$heartbeat_tmp"
mv -f -- "$heartbeat_tmp" "$runtime/s-$lease_touch/heartbeat"
sleep 1.25
assert_eq \
	"$("$helper" status "$lease_touch")" \
	running \
	"minute-throttled renderer lease"
kill -0 "$lease_touch_worker"
for _ in {1..4}; do
	now="$(date +%s)"
	near_expiry=$((now - 80))
	heartbeat_tmp="$runtime/s-$lease_touch/.heartbeat-test"
	(umask 077; printf '%s\n' "$near_expiry" > "$heartbeat_tmp")
	chmod 0600 "$heartbeat_tmp"
	mv -f -- "$heartbeat_tmp" "$runtime/s-$lease_touch/heartbeat"
	assert_eq "$("$helper" status-touch "$lease_touch")" running \
		"authenticated status lease refresh"
	[[ "$(< "$runtime/s-$lease_touch/heartbeat")" -ge "$now" ]] ||
		fail "status-touch did not refresh the renderer heartbeat"
	sleep 0.25
done
kill -0 "$lease_touch_worker"
assert_eq "$("$helper" stop "$lease_touch")" stopped "status-touch lease stop"
wait_dead "$lease_touch_worker"

# Without an authenticated touch (or a progressing media response), the same
# worker must still enforce its longer but bounded stale-client timeout.
assert_eq "$("$helper" start "$lease_expire" "$media")" started \
	"untouched lease start"
lease_expire_worker="$(session_pid "$lease_expire" worker)"
now="$(date +%s)"
heartbeat_tmp="$runtime/s-$lease_expire/.heartbeat-test"
(umask 077; printf '%s\n' "$((now - 120))" > "$heartbeat_tmp")
chmod 0600 "$heartbeat_tmp"
mv -f -- "$heartbeat_tmp" "$runtime/s-$lease_expire/heartbeat"
lease_expire_state=running
for _ in {1..100}; do
	lease_expire_state="$("$helper" status "$lease_expire")"
	[[ "$lease_expire_state" != running ]] && break
	sleep 0.05
done
[[ "$lease_expire_state" != running ]] ||
	fail "renderer ignored an untouched expired heartbeat"
wait_dead "$lease_expire_worker"
assert_eq "$("$helper" stop "$lease_expire")" stopped "expired lease stop"

# Exercise recovery after the wrapper dies without running its signal trap.
assert_eq "$("$helper" start "$token2" "$media")" started "second start"

worker2="$(session_pid "$token2" worker)"
ffmpeg2="$(session_pid "$token2" ffmpeg)"
chunker2="$(session_pid "$token2" chunker)"

assert_eq \
	"$("$helper" status "$token2")" \
	running \
	"status before crash"

kill -KILL "$worker2"
wait_dead "$worker2"

# The chunker's worker-liveness watchdog closes the FIFO after an untrappable
# worker crash. That must terminate the audio chunker without waiting for a
# later cleanup request, and the bounded ring must stop changing.
wait_dead "$chunker2"
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
run_mjpeg_cgi "$token2" 8 "$work/mjpeg-error"
check_status_line "$work/mjpeg-error" "503 Service Unavailable"

assert_eq \
	"$(< "$runtime/s-$token2/heartbeat")" \
	"$before" \
	"failed CGI heartbeat"

# Closing the worker-owned FIFO anchor must also release the video writer.
# A crashed wrapper therefore cannot leave an orphaned FFmpeg process behind.
wait_dead "$ffmpeg2"

# Entering maintenance is the only operation which authorizes destructive
# runtime cleanup. The marker survives cleanup and repeated helper invocations,
# blocking starts and runtime attestation until an explicit, quiescent exit.
assert_eq "$("$helper" maintenance-enter)" maintenance \
	"maintenance entry after worker crash"
assert_eq \
	"$(stat -c '%u:%a:%s' -- "$maintenance_file")" \
	"0:600:15" \
	"maintenance marker metadata"
assert_eq "$(< "$maintenance_file")" maintenance-v1 \
	"maintenance marker schema"
for blocked_command in probe attest; do
	set +e
	blocked_output="$("$helper" "$blocked_command" 2>&1)"
	blocked_rc=$?
	set -e
	assert_eq "$blocked_rc" 1 "$blocked_command during maintenance"
	[[ "$blocked_output" == *"maintenance is active"* ]] ||
		fail "$blocked_command did not report maintenance"
done
set +e
blocked_output="$("$helper" start "$token1" "$media" 2>&1)"
blocked_rc=$?
set -e
assert_eq "$blocked_rc" 1 "start during maintenance"
[[ "$blocked_output" == *"maintenance is active"* ]] ||
	fail "start did not report maintenance"
assert_eq "$("$helper" maintenance-enter)" maintenance \
	"idempotent persistent maintenance entry"
"$helper" cleanup

[[ ! -e "$runtime" && ! -L "$runtime" ]] ||
	fail "cleanup left runtime state"
[[ -f "$maintenance_file" ]] ||
	fail "cleanup removed the persistent maintenance gate"

assert_eq \
	"$("$helper" status "$token2")" \
	inactive \
	"status after cleanup"
# Simulate the package replacing the helper while the old invocation is gone.
# The fixed marker must gate the new executable and only that executable's
# explicit resume may clear it.
replacement_helper="$bin/videoplayer-renderer-replacement"
cp -- "$helper" "$replacement_helper"
chmod 0755 "$replacement_helper"
set +e
replacement_probe_output="$("$replacement_helper" probe 2>&1)"
replacement_probe_rc=$?
set -e
assert_eq "$replacement_probe_rc" 1 "replacement helper maintenance gate"
[[ "$replacement_probe_output" == *"maintenance is active"* ]] ||
	fail "replacement helper did not inherit persistent maintenance"
assert_eq "$("$replacement_helper" maintenance-exit)" resumed \
	"replacement helper maintenance exit"
[[ ! -e "$maintenance_file" && ! -L "$maintenance_file" ]] ||
	fail "maintenance exit retained its marker"
assert_eq "$("$helper" probe)" available "probe after maintenance exit"
set +e
"$helper" maintenance-exit > "$work/maintenance-exit-absent" 2>&1
maintenance_exit_absent_rc=$?
set -e
assert_eq "$maintenance_exit_absent_rc" 1 \
	"maintenance exit requires an active marker"

# Cleanup without a prior maintenance gate is never a one-shot substitute: it
# would reopen the start race as soon as the helper returns.
set +e
"$helper" cleanup > "$work/cleanup-without-maintenance" 2>&1
cleanup_without_maintenance_rc=$?
set -e
assert_eq "$cleanup_without_maintenance_rc" 1 \
	"cleanup without maintenance gate"

# A malformed marker is an immutable fail-closed condition: ordinary commands,
# cleanup, and maintenance-exit must all refuse it rather than chmod/remove an
# attacker-controlled object.
ln -s -- "$work" "$maintenance_file"
for unsafe_command in probe attest maintenance-enter maintenance-exit cleanup; do
	set +e
	"$helper" "$unsafe_command" > "$work/unsafe-maintenance-$unsafe_command" 2>&1
	unsafe_maintenance_rc=$?
	set -e
	assert_eq "$unsafe_maintenance_rc" 1 \
		"unsafe maintenance marker $unsafe_command"
done
[[ -L "$maintenance_file" ]] ||
	fail "unsafe maintenance marker was mutated by helper"
rm -f -- "$maintenance_file"

# Unsafe runtime state must fail maintenance entry after the gate is written;
# cleanup must preserve both objects for an administrator to inspect/repair.
mkdir -m 0755 -- "$runtime"
set +e
unsafe_runtime_output="$("$helper" maintenance-enter 2>&1)"
unsafe_runtime_rc=$?
set -e
assert_eq "$unsafe_runtime_rc" 1 "unsafe runtime maintenance entry"
[[ "$unsafe_runtime_output" == *"could not be quiesced safely"* ]] ||
	fail "unsafe runtime maintenance entry lacked fail-closed diagnostic"
[[ -f "$maintenance_file" ]] ||
	fail "unsafe runtime failure did not retain maintenance marker"
set +e
"$helper" cleanup > "$work/unsafe-runtime-cleanup" 2>&1
unsafe_runtime_cleanup_rc=$?
set -e
assert_eq "$unsafe_runtime_cleanup_rc" 1 "unsafe runtime cleanup"
[[ -d "$runtime" && -f "$maintenance_file" ]] ||
	fail "unsafe runtime cleanup mutated protected state"
rmdir -- "$runtime"
assert_eq "$("$helper" maintenance-exit)" resumed \
	"resume after administrator repairs unsafe runtime"

# A stop failure is equally fail-closed. The persistent marker remains, the
# active session remains tracked, and no cleanup/replacement is authorized.
assert_eq "$("$helper" start "$token1" "$media")" started \
	"maintenance stop-failure source start"
set +e
VIDEOPLAYER_TEST_STOP_FAILURE=1 \
	"$helper" maintenance-enter > "$work/maintenance-stop-failure" 2>&1
maintenance_stop_failure_rc=$?
set -e
assert_eq "$maintenance_stop_failure_rc" 1 "maintenance stop failure"
[[ -f "$maintenance_file" && -f "$runtime/current" ]] ||
	fail "stop failure removed maintenance or current tracking state"
set +e
"$helper" cleanup > "$work/cleanup-after-stop-failure" 2>&1
cleanup_after_stop_failure_rc=$?
set -e
assert_eq "$cleanup_after_stop_failure_rc" 0 \
	"maintenance cleanup retries a transient stop failure"
assert_eq "$("$helper" maintenance-exit)" resumed \
	"resume after recovered stop failure"

# Once the gate is published, a concurrent start waits on CONTROL_LOCK and then
# observes the still-persistent marker. It cannot slip between stop and package
# mutation, even across a separate helper invocation.
assert_eq "$("$helper" start "$token1" "$media")" started \
	"maintenance race source start"
rm -f -- "$maintenance_pause_ready" "$maintenance_pause_release"
VIDEOPLAYER_TEST_MAINTENANCE_PAUSE=1 \
	"$helper" maintenance-enter > "$work/maintenance-race-enter" &
maintenance_enter_pid=$!
for _ in {1..100}; do
	[[ -e "$maintenance_pause_ready" ]] && break
	sleep 0.05
done
[[ -e "$maintenance_pause_ready" ]] ||
	fail "maintenance entry did not publish its durable gate"
set +e
timeout 1 "$helper" start "$token2" "$media" \
	> "$work/maintenance-race-start" 2>&1
maintenance_race_start_rc=$?
set -e
assert_eq "$maintenance_race_start_rc" 124 \
	"concurrent start waits on maintenance control lock"
touch "$maintenance_pause_release"
wait "$maintenance_enter_pid"
maintenance_enter_pid=""
assert_eq "$(< "$work/maintenance-race-enter")" maintenance \
	"concurrent maintenance entry"
set +e
blocked_output="$("$helper" start "$token2" "$media" 2>&1)"
blocked_rc=$?
set -e
assert_eq "$blocked_rc" 1 "start after maintenance race"
[[ "$blocked_output" == *"maintenance is active"* ]] ||
	fail "post-race start did not observe persistent maintenance"
"$helper" cleanup
assert_eq "$("$helper" maintenance-exit)" resumed \
	"maintenance race resume"

printf 'renderer lifecycle test: OK\n'
