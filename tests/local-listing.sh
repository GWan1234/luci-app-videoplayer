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

[[ -f "$rpc_backend" ]] || fail "rpc backend not found"
[[ -f "$stream_backend" ]] || fail "stream backend not found"

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

renderer_stub="$work/videoplayer-renderer"
cat > "$renderer_stub" <<'SH'
#!/bin/sh
[ "$#" -eq 3 ] && [ "$1" = "start" ] || exit 2
printf 'started\n'
SH
chmod 0755 "$renderer_stub"

# cmd_resolve must not consume a six-hour browser streaming-token bucket for
# CPU sessions. Conversely, browser mode must not use the renderer namespace.
# shellcheck disable=SC2034
RENDERER_HELPER="$renderer_stub"
parse_request() {
	# Consumed by cmd_resolve from the sourced rpcd backend.
	# shellcheck disable=SC2034
	REQ_PATH="movie.mp4"
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
	printf '%s\n' "$media/movie.mp4"
}
relative_from_root() {
	printf 'movie.mp4\n'
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
json_init() {
	:
}
json_add_string() {
	:
}
json_add_int() {
	:
}
json_add_boolean() {
	:
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
# shellcheck disable=SC2329
create_token() {
	: > "$stream_token_marker"
	return 1
}
# Invoked indirectly by cmd_resolve from the sourced rpcd backend.
# shellcheck disable=SC2329
generate_random_token() {
	: > "$renderer_token_marker"
	printf '22222222222222222222222222222222\n'
}
cmd_resolve '{}' router >/dev/null
[[ ! -e "$stream_token_marker" ]] ||
	fail "router mode allocated a browser stream token"
[[ -e "$renderer_token_marker" ]] ||
	fail "router mode did not allocate a renderer token"

# Invoked indirectly by cmd_resolve from the sourced rpcd backend.
# shellcheck disable=SC2329
create_token() {
	: > "$stream_token_marker"
	printf '33333333333333333333333333333333\n'
}
# Invoked indirectly by cmd_resolve from the sourced rpcd backend.
# shellcheck disable=SC2329
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

printf 'local-listing-test: ok\n'
