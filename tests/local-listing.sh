#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
set -Eeuo pipefail

fail() {
	printf 'local-listing-test: %s\n' "$*" >&2
	exit 1
}

assert_eq() {
	[[ "$1" == "$2" ]] ||
		fail "$3: expected '$2', got '$1'"
}

repo_root="$(readlink -f -- "${1:-$PWD}")"
rpc_backend="$repo_root/luci-app-videoplayer/root/usr/libexec/rpcd/luci.videoplayer"
stream_backend="$repo_root/luci-app-videoplayer/root/www/cgi-bin/videoplayer-stream"
acl_file="$repo_root/luci-app-videoplayer/root/usr/share/rpcd/acl.d/luci-app-videoplayer.json"

[[ -f "$rpc_backend" ]] || fail "rpc backend not found"
[[ -f "$stream_backend" ]] || fail "stream backend not found"
[[ -f "$acl_file" ]] || fail "rpc ACL not found"

work="$(mktemp -d /tmp/videoplayer-listing-ci.XXXXXX)"

cleanup() {
	local rc=$?

	trap - EXIT INT TERM
	case "${work:-}" in
		/tmp/videoplayer-listing-ci.*)
			rm -rf -- "$work"
			;;
	esac
	exit "$rc"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

python3 - "$acl_file" <<'PY'
import json
from pathlib import Path
import sys

acl = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
grant = acl["luci-app-videoplayer"]
read_methods = grant["read"]["ubus"]["luci.videoplayer"]
write_methods = grant["write"]["ubus"]["luci.videoplayer"]
uci_read_methods = set(grant["read"]["ubus"]["uci"])
uci_write_methods = set(grant["write"]["ubus"]["uci"])
assert "list_renderer" not in read_methods, read_methods
assert "list_renderer" in write_methods, write_methods
assert "resolve_audio" not in read_methods, read_methods
assert "resolve_audio" not in write_methods, write_methods
assert {"get", "changes", "configs"} <= uci_read_methods, uci_read_methods
assert {"set", "apply", "confirm", "rollback"} <= uci_write_methods, uci_write_methods
assert grant["read"]["uci"] == ["videoplayer"], grant["read"]["uci"]
assert grant["write"]["uci"] == ["videoplayer"], grant["write"]["uci"]
PY

uppercase=ABCDEFGHIJKLMNOPQRSTUVWXYZ
lowercase=abcdefghijklmnopqrstuvwxyz

# Stock OpenWrt BusyBox is commonly built without FEATURE_TR_CLASSES. Reject
# character-class operands here so the test behaves like that configuration
# even when CI provides GNU tr.
tr() {
	if [[ "$#" -ne 2 || "$1" != "$uppercase" || "$2" != "$lowercase" ]]; then
		printf 'local-listing-test: unsupported tr operands: %q %q\n' \
			"${1:-}" "${2:-}" >&2
		return 97
	fi
	command tr "$@"
}

for source_file in "$rpc_backend" "$stream_backend"; do
	assert_eq "$(
		grep -Fc "tr 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' 'abcdefghijklmnopqrstuvwxyz'" \
			"$source_file" || true
	)" "2" "$source_file portable case-fold count"
	! grep -Fq "tr '[:upper:]' '[:lower:]'" "$source_file" ||
		fail "$source_file still relies on BusyBox tr character classes"
done

rpc_harness="$work/luci.videoplayer"
stream_harness="$work/videoplayer-stream"

grep -Fxq '. /usr/share/libubox/jshn.sh' "$rpc_backend" ||
	fail "unexpected rpc jshn import"
grep -Fxq '# --- rpcd entry point ---' "$rpc_backend" ||
	fail "rpc entry-point marker not found"
grep -Fxq 'valid_token() {' "$stream_backend" ||
	fail "stream helper boundary not found"

awk '
	$0 == ". /usr/share/libubox/jshn.sh" {
		print ":"
		next
	}
	$0 == "# --- rpcd entry point ---" {
		exit
	}
	{ print }
' "$rpc_backend" > "$rpc_harness"

awk '
	$0 == "valid_token() {" {
		exit
	}
	{ print }
' "$stream_backend" > "$stream_harness"

check_extension_helpers() {
	local harness="$1"

	(
		# shellcheck disable=SC1090
		source "$harness"

		is_allowed_ext "/mnt/video/movie.mp4" ||
			fail "$harness rejected lowercase MP4"
		is_allowed_ext "/mnt/video/UPPER.MP4" ||
			fail "$harness rejected uppercase MP4"
		is_allowed_ext "/mnt/video/My Film.MkV" ||
			fail "$harness rejected mixed-case MKV"
		is_allowed_ext "/mnt/video/.hidden.webm" ||
			fail "$harness rejected hidden WebM"
		is_allowed_ext "/mnt/video/clip.3GP" ||
			fail "$harness rejected uppercase 3GP"
		! is_allowed_ext "/mnt/video/notes.txt" ||
			fail "$harness accepted a non-video extension"
		! is_allowed_ext "/mnt/video/no-extension" ||
			fail "$harness accepted a name without an extension"

		assert_eq "$(mime_for '/mnt/video/movie.MOV')" "video/quicktime" \
			"$harness uppercase MIME lookup"
		assert_eq "$(mime_for '/mnt/video/movie.MP4')" "video/mp4" \
			"$harness MP4 MIME lookup"
		assert_eq "$(mime_for '/mnt/video/movie.F4V')" "video/mp4" \
			"$harness F4V MIME lookup"
		assert_eq "$(mime_for '/mnt/video/no-extension')" \
			"application/octet-stream" \
			"$harness extensionless MIME lookup"
	)
}

check_extension_helpers "$rpc_harness"
check_extension_helpers "$stream_harness"

(
	# The original-file CGI must share the rpcd/frontend safe default: only an
	# exact Router setting selects Router mode; missing or malformed values stay
	# in Browser mode.
	# shellcheck disable=SC1090
	source "$stream_harness"
	STREAM_TEST_RENDER_MODE=
	# Sourced CGI code invokes this PATH-compatible test double indirectly.
	# shellcheck disable=SC2317,SC2329
	uci() {
		[[ "$#" -eq 3 && "$1" == "-q" && "$2" == "get" ]] || return 1
		[ -n "$STREAM_TEST_RENDER_MODE" ] || return 1
		printf '%s\n' "$STREAM_TEST_RENDER_MODE"
	}
	assert_eq "$(get_render_mode)" "browser" "missing CGI render-mode default"
	STREAM_TEST_RENDER_MODE=invalid
	assert_eq "$(get_render_mode)" "browser" "invalid CGI render-mode default"
	STREAM_TEST_RENDER_MODE=router
	assert_eq "$(get_render_mode)" "router" "explicit CGI Router mode"
)

media="$work/media"
mkdir -- "$media" "$media/Sub Folder"
touch -- \
	"$media/movie.mp4" \
	"$media/UPPER.MP4" \
	"$media/My Film.MkV" \
	"$media/.hidden.webm" \
	"$media/clip.3GP" \
	"$media/notes.txt" \
	"$media/no-extension" \
	"$work/outside.mp4"
ln -s -- "$media/movie.mp4" "$media/in-root-link.mp4"
ln -s -- "$work/outside.mp4" "$media/out-of-root-link.mp4"

# Exercise the actual rpcd directory producer. It is the stage that previously
# emitted directories but silently discarded MP4 files on OpenWrt.
# shellcheck disable=SC1090
source "$rpc_harness"

VIDEOPLAYER_TEST_ROUTER_FPS=8
VIDEOPLAYER_TEST_ROUTER_PROFILE=quality
VIDEOPLAYER_TEST_ROUTER_MAX_THREADS=0
uci() {
	[[ "$#" -eq 3 && "$1" == "-q" && "$2" == "get" ]] || return 1
	case "$3" in
		videoplayer.main.router_fps)
			printf '%s\n' "$VIDEOPLAYER_TEST_ROUTER_FPS"
			;;
		videoplayer.main.router_profile)
			printf '%s\n' "$VIDEOPLAYER_TEST_ROUTER_PROFILE"
			;;
		videoplayer.main.router_max_threads)
			printf '%s\n' "$VIDEOPLAYER_TEST_ROUTER_MAX_THREADS"
			;;
		*) return 1 ;;
	esac
}

declare -A seen=()
record_count=0
while IFS= read -r -d '' record; do
	[[ "$record" == [12]* ]] || fail "unexpected listing record prefix"
	full="${record:1}"
	seen["${record:0:1}:${full##*/}"]=1
	record_count=$((record_count + 1))
done < <(stream_sorted_children "$media" 1)

assert_eq "$record_count" "6" "filtered directory entry count"
for expected in \
	"1:Sub Folder" \
	"2:.hidden.webm" \
	"2:My Film.MkV" \
	"2:UPPER.MP4" \
	"2:clip.3GP" \
	"2:movie.mp4"
do
	[[ -n "${seen[$expected]:-}" ]] || fail "missing listing entry: $expected"
done

for rejected in \
	"2:notes.txt" \
	"2:no-extension" \
	"2:in-root-link.mp4" \
	"2:out-of-root-link.mp4"
do
	[[ -z "${seen[$rejected]:-}" ]] ||
		fail "unexpected listing entry: $rejected"
done

# Consumed by list_file_is_visible from the sourced rpcd backend.
# shellcheck disable=SC2034
LIST_ALLOW_ANY_FILE=1
declare -A cpu_seen=()
cpu_record_count=0
while IFS= read -r -d '' record; do
	[[ "$record" == [12]* ]] || fail "unexpected CPU listing record prefix"
	full="${record:1}"
	cpu_seen["${record:0:1}:${full##*/}"]=1
	cpu_record_count=$((cpu_record_count + 1))
done < <(stream_sorted_children "$media" 1)
unset LIST_ALLOW_ANY_FILE

assert_eq "$cpu_record_count" "8" "CPU directory entry count"
for expected in \
	"1:Sub Folder" \
	"2:.hidden.webm" \
	"2:My Film.MkV" \
	"2:UPPER.MP4" \
	"2:clip.3GP" \
	"2:movie.mp4" \
	"2:no-extension" \
	"2:notes.txt"
do
	[[ -n "${cpu_seen[$expected]:-}" ]] ||
		fail "missing CPU listing entry: $expected"
done
for rejected in \
	"2:in-root-link.mp4" \
	"2:out-of-root-link.mp4"
do
	[[ -z "${cpu_seen[$rejected]:-}" ]] ||
		fail "unexpected CPU listing entry: $rejected"
done

renderer_stub="$work/videoplayer-renderer"
cat > "$renderer_stub" <<'SH'
#!/bin/sh
case "${1:-}" in
	attest)
		[ "$#" -eq 1 ] || exit 2
		printf 'private-software-cpu\tsoftware-cpu-v1\tnone\n'
		;;
	start)
		[ "$#" -eq 3 ] || exit 2
		printf 'started\n'
		;;
	audio-state)
		[ "$#" -eq 2 ] || exit 2
		printf 'ready\n'
		;;
	media-info)
		[ "$#" -eq 2 ] || exit 2
		printf '0\t0\t60\tquality\tprivate-software-cpu\tsoftware-cpu-v1\tnone\t0\n'
		;;
	*) exit 2 ;;
esac
SH
chmod 0755 "$renderer_stub"

# cmd_resolve must not consume a six-hour browser streaming-token bucket for
# CPU sessions. Conversely, browser mode must not use the renderer namespace.
# shellcheck disable=SC2034
RENDERER_HELPER="$renderer_stub"
test_request_path="no-extension"
test_request_token="22222222222222222222222222222222"
parse_request() {
	# Consumed by cmd_resolve from the sourced rpcd backend.
	# shellcheck disable=SC2034
	REQ_PATH="$test_request_path"
	# shellcheck disable=SC2034
	REQ_TOKEN="$test_request_token"
	return 0
}
get_enabled() {
	printf '1\n'
}
VIDEOPLAYER_TEST_RENDER_MODE=router
get_render_mode() {
	printf '%s\n' "$VIDEOPLAYER_TEST_RENDER_MODE"
}
get_media_root() {
	printf '%s\n' "$media"
}
resolve_under_root() {
	printf '%s/%s\n' "$media" "$2"
}
relative_from_root() {
	printf '%s\n' "${2#"$1"/}"
}
path_depth() {
	printf '0\n'
}
get_max_depth() {
	printf '8\n'
}
get_file_metadata() {
	# Consumed by cmd_resolve from the sourced rpcd backend.
	# shellcheck disable=SC2034
	FILE_SIZE=1
}
declare -A json_fields=()
json_init() {
	json_fields=()
}
json_add_string() {
	json_fields["$1"]="$2"
}
json_add_int() {
	json_fields["$1"]="$2"
}
json_add_boolean() {
	json_fields["$1"]="$2"
}
json_dump() {
	printf '{}\n'
}
RESOLVE_ERROR=
json_error() {
	RESOLVE_ERROR="$1"
}

stream_token_marker="$work/stream-token-created"
renderer_token_marker="$work/renderer-token-created"
# Invoked indirectly by cmd_resolve from the sourced rpcd backend.
# shellcheck disable=SC2317,SC2329
create_token() {
	: > "$stream_token_marker"
	return 1
}
# Invoked indirectly by cmd_resolve from the sourced rpcd backend.
# shellcheck disable=SC2317,SC2329
generate_random_token() {
	: > "$renderer_token_marker"
	printf '22222222222222222222222222222222\n'
}
for fps_case in \
	5:200 8:125 12:83 15:67 20:50 24:42 30:33 48:21 50:20 60:17
do
	test_router_fps="${fps_case%%:*}"
	expected_interval="${fps_case##*:}"
	VIDEOPLAYER_TEST_ROUTER_FPS="$test_router_fps"
	assert_eq "$(get_router_fps)" "$test_router_fps" \
		"accepted router FPS $test_router_fps"
	assert_eq "$(frame_interval_for_fps "$test_router_fps")" \
		"$expected_interval" \
		"frame interval for $test_router_fps FPS"
done
VIDEOPLAYER_TEST_ROUTER_PROFILE=fast
VIDEOPLAYER_TEST_ROUTER_FPS=60
assert_eq "$(get_router_fps)" "8" \
	"fast profile high-FPS clamp"
VIDEOPLAYER_TEST_ROUTER_PROFILE=quality
for invalid_router_fps in 31 61; do
	VIDEOPLAYER_TEST_ROUTER_FPS="$invalid_router_fps"
	assert_eq "$(get_router_fps)" "8" \
		"unsupported router FPS $invalid_router_fps fallback"
done
VIDEOPLAYER_TEST_ROUTER_FPS=60
VIDEOPLAYER_TEST_ROUTER_MAX_THREADS=1
assert_eq "$(get_router_max_threads)" "1" \
	"exact maximum-resource setting"
for invalid_max_threads in 0 yes 2 -1 ''; do
	VIDEOPLAYER_TEST_ROUTER_MAX_THREADS="$invalid_max_threads"
	assert_eq "$(get_router_max_threads)" "0" \
		"invalid maximum-resource setting '$invalid_max_threads' fallback"
done
VIDEOPLAYER_TEST_ROUTER_MAX_THREADS=0
cmd_resolve '{}' router >/dev/null
[[ -z "$RESOLVE_ERROR" ]] ||
	fail "router resolve returned an error: $RESOLVE_ERROR"
[[ ! -e "$stream_token_marker" ]] ||
	fail "router mode allocated a browser stream token"
[[ -e "$renderer_token_marker" ]] ||
	fail "router mode did not allocate a renderer token"
assert_eq "${json_fields[stream_type]:-}" "mjpeg-stream" \
	"router stream type"
assert_eq "${json_fields[stream_url]:-}" \
	"/cgi-bin/videoplayer-frame?token=22222222222222222222222222222222" \
	"router frame URL"
assert_eq "${json_fields[audio_url]:-}" \
	"/cgi-bin/videoplayer-audio?token=22222222222222222222222222222222" \
	"router audio URL"
assert_eq "${json_fields[audio_type]:-}" "pcm-s16le-chunks" \
	"router audio type"
assert_eq "${json_fields[has_audio]:-}" "1" "router audio flag"
assert_eq "${json_fields[audio_state]:-}" "ready" "router audio state"
assert_eq "${json_fields[renderer_backend]:-}" "private-software-cpu" \
	"router attested backend"
assert_eq "${json_fields[attestation_marker]:-}" "software-cpu-v1" \
	"router attestation marker"
assert_eq "${json_fields[hardware_acceleration]:-}" "0" \
	"router hardware acceleration flag"
assert_eq "${json_fields[runtime_attested]:-}" "1" \
	"router runtime attestation flag"
assert_eq "${json_fields[presentation]:-}" "browser-managed" \
	"router presentation boundary"
assert_eq "${json_fields[audio_sample_rate]:-}" "48000" \
	"router audio sample rate"
assert_eq "${json_fields[audio_channels]:-}" "2" "router audio channels"
assert_eq "${json_fields[audio_frames_per_chunk]:-}" "48000" \
	"router audio chunk frames"
assert_eq "${json_fields[audio_batch_max_chunks]:-}" "2" \
	"router audio batch size"
assert_eq "${json_fields[audio_ring_chunks]:-}" "8" \
	"router audio ring size"
assert_eq "${json_fields[router_profile]:-}" "quality" "router profile"
assert_eq "${json_fields[router_fps]:-}" "60" "router FPS"
assert_eq "${json_fields[router_max_threads]:-}" "0" \
	"frozen maximum-resource setting"
assert_eq "${json_fields[frame_interval_ms]:-}" "17" \
	"router frame interval"
assert_eq "${json_fields[mime]:-}" "multipart/x-mixed-replace" \
	"router stream MIME"
assert_eq "${json_fields[stream_segment_seconds]:-}" "45" \
	"router stream segment duration"

test_request_path="movie.mp4"
# Invoked indirectly by cmd_resolve from the sourced rpcd backend.
# shellcheck disable=SC2317,SC2329
create_token() {
	: > "$stream_token_marker"
	printf '33333333333333333333333333333333\n'
}
# Invoked indirectly by cmd_resolve from the sourced rpcd backend.
# shellcheck disable=SC2317,SC2329
generate_random_token() {
	: > "$renderer_token_marker"
	return 1
}
rm -f -- "$renderer_token_marker"
rm -f -- "$stream_token_marker"
RESOLVE_ERROR=
cmd_resolve '{}' browser >/dev/null
assert_eq "$RESOLVE_ERROR" "browser source decoding is not selected" \
	"browser resolve while Router mode is active"
[[ ! -e "$stream_token_marker" ]] ||
	fail "Router mode allowed a browser source token"

VIDEOPLAYER_TEST_RENDER_MODE=browser
RESOLVE_ERROR=
cmd_resolve '{}' browser >/dev/null
[[ -z "$RESOLVE_ERROR" ]] ||
	fail "browser resolve returned an error: $RESOLVE_ERROR"
[[ ! -e "$renderer_token_marker" ]] ||
	fail "browser mode allocated a renderer token"
[[ -e "$stream_token_marker" ]] ||
	fail "browser mode did not allocate a stream token"

! grep -Fq 'cmd_resolve_audio' "$rpc_backend" ||
	fail "strict CPU rpcd backend still contains resolve_audio"
! grep -Fq 'resolve_audio)' "$rpc_backend" ||
	fail "strict CPU rpcd dispatch still exposes resolve_audio"
# This is an exact source-code literal; the test must not expand REQ_TOKEN.
# shellcheck disable=SC2016
grep -Fq 'if load_renderer_attestation && load_renderer_media_info "$REQ_TOKEN"; then' \
	"$rpc_backend" ||
	fail "renderer status does not re-attest the live private runtime"
grep -Fq 'http_err "409 Conflict" "Browser source decoding is not selected"' \
	"$stream_backend" ||
	fail "original-file CGI is not gated by active Browser mode"

printf 'local-listing-test: ok\n'
