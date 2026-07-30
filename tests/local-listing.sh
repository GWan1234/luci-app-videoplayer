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
assert "list_renderer" not in read_methods, read_methods
assert "list_renderer" in write_methods, write_methods
assert "resolve_audio" not in read_methods, read_methods
assert "resolve_audio" in write_methods, write_methods
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
uci() {
	[[ "$#" -eq 3 &&
	   "$1" == "-q" &&
	   "$2" == "get" &&
	   "$3" == "videoplayer.main.router_fps" ]] || return 1
	printf '%s\n' "$VIDEOPLAYER_TEST_ROUTER_FPS"
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
	start)
		[ "$#" -eq 3 ] || exit 2
		printf 'started\n'
		;;
	has-audio)
		[ "$#" -eq 2 ] || exit 2
		printf '1\n'
		;;
	source)
		[ "$#" -eq 2 ] || exit 2
		[ -n "${VIDEOPLAYER_TEST_AUDIO_SOURCE:-}" ] || exit 1
		printf '%s\n' "$VIDEOPLAYER_TEST_AUDIO_SOURCE"
		;;
	authorize-browser-audio)
		[ "$#" -eq 3 ] || exit 2
		[ "$2" = "22222222222222222222222222222222" ] || exit 1
		[ "$3" = "44444444444444444444444444444444" ] || exit 1
		printf '%s\n' "$3"
		;;
	position-ms)
		[ "$#" -eq 3 ] || exit 2
		[ "$2" = "22222222222222222222222222222222" ] || exit 1
		[ "$3" = "44444444444444444444444444444444" ] || exit 1
		printf '1750\n'
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
get_render_mode() {
	printf 'router\n'
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
json_error() {
	fail "cmd_resolve returned an error: $1"
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
for invalid_router_fps in 31 61; do
	VIDEOPLAYER_TEST_ROUTER_FPS="$invalid_router_fps"
	assert_eq "$(get_router_fps)" "8" \
		"unsupported router FPS $invalid_router_fps fallback"
done
VIDEOPLAYER_TEST_ROUTER_FPS=60
cmd_resolve '{}' router >/dev/null
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
assert_eq "${json_fields[audio_sample_rate]:-}" "48000" \
	"router audio sample rate"
assert_eq "${json_fields[audio_channels]:-}" "2" "router audio channels"
assert_eq "${json_fields[audio_frames_per_chunk]:-}" "12000" \
	"router audio chunk frames"
assert_eq "${json_fields[router_fps]:-}" "60" "router FPS"
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
cmd_resolve '{}' browser >/dev/null
[[ ! -e "$renderer_token_marker" ]] ||
	fail "browser mode allocated a renderer token"
[[ -e "$stream_token_marker" ]] ||
	fail "browser mode did not allocate a stream token"

# Browser-audio fallback mints a distinct nonce bound to the active renderer
# and deliberately accepts extensionless files exposed only by CPU mode.
export VIDEOPLAYER_TEST_AUDIO_SOURCE="$media/no-extension"
rm -f -- "$stream_token_marker" "$renderer_token_marker"
create_token() {
	: > "$stream_token_marker"
	return 1
}
generate_random_token() {
	: > "$renderer_token_marker"
	printf '44444444444444444444444444444444\n'
}
cmd_resolve_audio '{}' >/dev/null
[[ ! -e "$stream_token_marker" ]] ||
	fail "browser-audio fallback allocated a long-lived path token"
[[ -e "$renderer_token_marker" ]] ||
	fail "browser-audio fallback did not allocate a distinct capability"
assert_eq "${json_fields[path]:-}" "no-extension" \
	"browser-audio canonical path"
assert_eq "${json_fields[render_mode]:-}" "browser" \
	"browser-audio render mode"
assert_eq "${json_fields[stream_type]:-}" "html5-video" \
	"browser-audio stream type"
assert_eq "${json_fields[stream_url]:-}" \
	"/cgi-bin/videoplayer-stream?renderer=22222222222222222222222222222222&audio=44444444444444444444444444444444" \
	"browser-audio stream URL"
assert_eq "${json_fields[media_offset_ms]:-}" "1750" \
	"browser-audio playback offset"
assert_eq "${json_fields[mime]:-}" "application/octet-stream" \
	"extensionless browser-audio MIME"

printf 'local-listing-test: ok\n'
