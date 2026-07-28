#!/bin/sh
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Development-only file installer for a live OpenWrt router.
#
# Usage:
#   ./scripts/install-to-router.sh [root@192.168.1.1]
#   ./scripts/install-to-router.sh --uninstall [root@192.168.1.1]
#
# Requires ssh and scp. OpenSSH scp is tried in legacy (-O) mode first
# because a stock Dropbear installation usually has no SFTP server.

set -eu

ACTION=install
case "${1:-}" in
	--uninstall)
		ACTION=uninstall
		shift
		;;
	-h|--help)
		sed -n '3,9p' "$0"
		exit 0
		;;
esac

TARGET="${1:-root@192.168.1.1}"
[ "$#" -le 1 ] || {
	echo "Too many arguments" >&2
	exit 2
}

ROOT="$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)"
PKG="$ROOT/luci-app-videoplayer/root"
HTDOCS="$ROOT/luci-app-videoplayer/htdocs"
REMOTE_STAGE="/tmp/luci-app-videoplayer-install-$$"

scp_openwrt() {
	if scp -O "$@"; then
		return 0
	fi

	echo "Legacy scp (-O) failed; retrying the default scp transport." >&2
	scp "$@"
}

uninstall_files() {
	echo "Removing manually installed files from $TARGET ..."
ssh "$TARGET" sh -s <<'REMOTE_UNINSTALL'
set -e

cleanup_token_store() (
	lock_file="/tmp/videoplayer-tokens.lock"
	token_dir="/tmp/videoplayer-tokens"
	marker="$token_dir/.bucket-v1"
	if [ ! -e "$lock_file" ] && [ ! -L "$lock_file" ]; then
		(umask 077; set -C; : > "$lock_file") 2>/dev/null || :
	fi
	[ -f "$lock_file" ] && [ ! -L "$lock_file" ] || return 1
	[ "$(stat -c '%u' -- "$lock_file" 2>/dev/null)" = "0" ] || return 1
	[ "$(readlink -f -- "$lock_file" 2>/dev/null)" = "$lock_file" ] || return 1
	chmod 0600 "$lock_file" 2>/dev/null || return 1
	exec 9< "$lock_file" || return 1
	flock -x 9 || return 1
	if [ ! -e "$token_dir" ] && [ ! -L "$token_dir" ]; then
		(umask 077; mkdir "$token_dir") || return 1
	fi
	[ -d "$token_dir" ] && [ ! -L "$token_dir" ] || return 1
	[ "$(stat -c '%u' -- "$token_dir" 2>/dev/null)" = "0" ] || return 1
	[ "$(readlink -f -- "$token_dir" 2>/dev/null)" = "$token_dir" ] || return 1
	chmod 0700 "$token_dir" 2>/dev/null || return 1
	if [ ! -e "$marker" ] && [ ! -L "$marker" ]; then
		marker_tmp="$token_dir/.cleanup-marker.$$"
		rm -f -- "$marker_tmp" || return 1
		(umask 077; set -C; printf 'bucket-v1\n' > "$marker_tmp") 2>/dev/null || {
			rm -f -- "$marker_tmp"
			return 1
		}
		if ! ln "$marker_tmp" "$marker" 2>/dev/null; then
			if [ ! -f "$marker" ] || [ -L "$marker" ]; then
				rm -f -- "$marker_tmp"
				return 1
			fi
		fi
		rm -f -- "$marker_tmp"
	fi
	[ -f "$marker" ] && [ ! -L "$marker" ] || return 1
	exec 8< "$marker" || return 1
	flock -x 8 || return 1
	find "$token_dir" -mindepth 1 -maxdepth 1 ! -name '.bucket-v1' \
		-exec rm -rf -- '{}' \;
)

[ ! -x /usr/libexec/videoplayer-renderer ] ||
	/usr/libexec/videoplayer-renderer cleanup 2>/dev/null || true

rm -f \
	/www/luci-static/resources/view/videoplayer/main.js \
	/www/cgi-bin/videoplayer-stream \
	/www/cgi-bin/videoplayer-frame \
	/usr/libexec/rpcd/luci.videoplayer \
	/usr/libexec/videoplayer-renderer \
	/usr/share/luci/menu.d/luci-app-videoplayer.json \
	/usr/share/rpcd/acl.d/luci-app-videoplayer.json

rmdir /www/luci-static/resources/view/videoplayer 2>/dev/null || true

rm -f /tmp/luci-indexcache /tmp/luci-indexcache.* 2>/dev/null || true
rm -rf /tmp/luci-modulecache 2>/dev/null || true
cleanup_token_store 2>/dev/null || true
rm -f /tmp/videoplayer-render-v1.lock /tmp/videoplayer-render-v1.worker.lock 2>/dev/null || true
/etc/init.d/rpcd reload 2>/dev/null || true

echo "Program files removed; /etc/config/videoplayer and media were preserved."
REMOTE_UNINSTALL
}

if [ "$ACTION" = uninstall ]; then
	command -v ssh >/dev/null 2>&1 || {
		echo "Required local command is missing: ssh" >&2
		exit 1
	}
	uninstall_files
	exit 0
fi

if [ ! -d "$PKG" ] || [ ! -d "$HTDOCS" ]; then
	echo "Cannot find package files under $ROOT/luci-app-videoplayer" >&2
	exit 1
fi

for local_command in ssh scp; do
	if ! command -v "$local_command" >/dev/null 2>&1; then
		echo "Required local command is missing: $local_command" >&2
		exit 1
	fi
done

for source_file in \
	"$PKG/etc/config/videoplayer" \
	"$PKG/etc/uci-defaults/80_luci-videoplayer" \
	"$PKG/usr/share/luci/menu.d/luci-app-videoplayer.json" \
	"$PKG/usr/share/rpcd/acl.d/luci-app-videoplayer.json" \
	"$PKG/usr/libexec/rpcd/luci.videoplayer" \
	"$PKG/usr/libexec/videoplayer-renderer" \
	"$PKG/www/cgi-bin/videoplayer-stream" \
	"$PKG/www/cgi-bin/videoplayer-frame" \
	"$HTDOCS/luci-static/resources/view/videoplayer/main.js"
do
	if [ ! -f "$source_file" ]; then
		echo "Required package source is missing: $source_file" >&2
		exit 1
	fi
done

echo "Checking required services and commands on $TARGET ..."
ssh "$TARGET" sh -s <<'REMOTE_PREFLIGHT'
set -u
failed=0

missing() {
	echo "Missing requirement: $1" >&2
	failed=1
}

for command_name in uci ubus sort stat flock ffmpeg; do
	command -v "$command_name" >/dev/null 2>&1 ||
		missing "command '$command_name'"
done

if command -v ffmpeg >/dev/null 2>&1; then
	ffmpeg -hide_banner -encoders 2>/dev/null |
		grep -Eq '^[[:space:]]*V[^[:space:]]*[[:space:]]+mjpeg([[:space:]]|$)' ||
		missing "an ffmpeg build with the MJPEG encoder"
	ffmpeg -hide_banner -muxers 2>/dev/null |
		grep -Eq '^[[:space:]]*E[[:space:]]+image2([[:space:]]|$)' ||
		missing "an ffmpeg build with the image2 muxer"
	ffmpeg_filters="$(ffmpeg -hide_banner -filters 2>/dev/null)" ||
		ffmpeg_filters=""
	printf '%s\n' "$ffmpeg_filters" |
		grep -Eq '^[[:space:]]*[^[:space:]]+[[:space:]]+fps[[:space:]]' ||
		missing "an ffmpeg build with the fps filter"
	printf '%s\n' "$ffmpeg_filters" |
		grep -Eq '^[[:space:]]*[^[:space:]]+[[:space:]]+scale[[:space:]]' ||
		missing "an ffmpeg build with the scale filter"
	printf '%s\n' "$ffmpeg_filters" |
		grep -Eq '^[[:space:]]*[^[:space:]]+[[:space:]]+format[[:space:]]' ||
		missing "an ffmpeg build with the format filter"
fi

if command -v stat >/dev/null 2>&1; then
	stat_probe="$(LC_ALL=C stat -L -c '%F:%s' /etc/passwd 2>/dev/null)" || stat_probe=""
	case "$stat_probe" in
		"regular file:"*) ;;
		*) missing "a stat implementation supporting -L, -c and %F (install coreutils-stat)" ;;
	esac
fi
if command -v sort >/dev/null 2>&1; then
	printf 'b\000a\000' | sort -z >/dev/null 2>&1 ||
		missing "a sort implementation supporting NUL-delimited input (-z)"
fi

[ -r /usr/share/libubox/jshn.sh ] ||
	missing "/usr/share/libubox/jshn.sh (install jshn)"
[ -x /etc/init.d/uhttpd ] ||
	missing "/etc/init.d/uhttpd (install and enable uhttpd)"
[ -x /etc/init.d/rpcd ] ||
	missing "/etc/init.d/rpcd"
[ -e /www/cgi-bin/luci ] ||
	missing "/www/cgi-bin/luci (install luci-base)"
[ -d /usr/share/luci/menu.d ] ||
	missing "/usr/share/luci/menu.d (install luci-base)"

[ "$failed" -eq 0 ] || exit 1
REMOTE_PREFLIGHT

echo "Staging files for $TARGET ..."
ssh "$TARGET" sh -s -- "$REMOTE_STAGE" <<'REMOTE_STAGE_SETUP'
set -eu
stage="$1"
prefix="/tmp/luci-app-videoplayer-install-"
case "$stage" in
	"$prefix"*) ;;
	*) exit 2 ;;
esac
stage_id="${stage#"$prefix"}"
case "$stage_id" in
	''|*[!0-9]*) exit 2 ;;
esac

rm -rf "$stage"
umask 077
mkdir -p "$stage"
chmod 0700 "$stage"
REMOTE_STAGE_SETUP

cleanup_stage() {
	ssh "$TARGET" sh -s -- "$REMOTE_STAGE" >/dev/null 2>&1 <<'REMOTE_STAGE_CLEANUP' || true
stage="$1"
prefix="/tmp/luci-app-videoplayer-install-"
case "$stage" in
	"$prefix"*) ;;
	*) exit 2 ;;
esac
stage_id="${stage#"$prefix"}"
case "$stage_id" in
	''|*[!0-9]*) exit 2 ;;
esac
rm -rf "$stage"
REMOTE_STAGE_CLEANUP
}

abort_install() {
	code="$1"
	trap - HUP INT TERM
	exit "$code"
}

trap cleanup_stage EXIT
trap 'abort_install 129' HUP
trap 'abort_install 130' INT
trap 'abort_install 143' TERM

scp_openwrt "$PKG/etc/config/videoplayer" \
	"$TARGET:$REMOTE_STAGE/videoplayer.config"
scp_openwrt "$PKG/etc/uci-defaults/80_luci-videoplayer" \
	"$TARGET:$REMOTE_STAGE/80_luci-videoplayer"
scp_openwrt "$PKG/usr/share/luci/menu.d/luci-app-videoplayer.json" \
	"$TARGET:$REMOTE_STAGE/menu.json"
scp_openwrt "$PKG/usr/share/rpcd/acl.d/luci-app-videoplayer.json" \
	"$TARGET:$REMOTE_STAGE/acl.json"
scp_openwrt "$PKG/usr/libexec/rpcd/luci.videoplayer" \
	"$TARGET:$REMOTE_STAGE/rpcd-backend"
scp_openwrt "$PKG/usr/libexec/videoplayer-renderer" \
	"$TARGET:$REMOTE_STAGE/renderer"
scp_openwrt "$PKG/www/cgi-bin/videoplayer-stream" \
	"$TARGET:$REMOTE_STAGE/stream-cgi"
scp_openwrt "$PKG/www/cgi-bin/videoplayer-frame" \
	"$TARGET:$REMOTE_STAGE/frame-cgi"
scp_openwrt "$HTDOCS/luci-static/resources/view/videoplayer/main.js" \
	"$TARGET:$REMOTE_STAGE/main.js"

ssh "$TARGET" sh -s -- "$REMOTE_STAGE" <<'REMOTE_INSTALL'
set -eu

stage="$1"
prefix="/tmp/luci-app-videoplayer-install-"
case "$stage" in
	"$prefix"*) ;;
	*) echo "Unsafe staging path: $stage" >&2; exit 2 ;;
esac
stage_id="${stage#"$prefix"}"
case "$stage_id" in
	''|*[!0-9]*) echo "Unsafe staging path: $stage" >&2; exit 2 ;;
esac
[ -d "$stage" ] && [ ! -L "$stage" ] || {
	echo "Unsafe or missing staging directory: $stage" >&2
	exit 2
}

install_staged() {
	source="$stage/$1"
	destination="$2"
	mode="$3"
	parent="${destination%/*}"
	temporary="$destination.new.$$"

	mkdir -p "$parent"
	rm -f "$temporary"
	cp "$source" "$temporary"
	chmod "$mode" "$temporary"
	mv -f "$temporary" "$destination"
}

if [ ! -f /etc/config/videoplayer ]; then
	install_staged videoplayer.config /etc/config/videoplayer 0644
fi

[ ! -x /usr/libexec/videoplayer-renderer ] ||
	/usr/libexec/videoplayer-renderer cleanup 2>/dev/null || true

install_staged menu.json /usr/share/luci/menu.d/luci-app-videoplayer.json 0644
install_staged acl.json /usr/share/rpcd/acl.d/luci-app-videoplayer.json 0644
install_staged rpcd-backend /usr/libexec/rpcd/luci.videoplayer 0755
install_staged renderer /usr/libexec/videoplayer-renderer 0755
install_staged stream-cgi /www/cgi-bin/videoplayer-stream 0755
install_staged frame-cgi /www/cgi-bin/videoplayer-frame 0755
install_staged main.js /www/luci-static/resources/view/videoplayer/main.js 0644

# Add only missing UCI values; this never creates the media directory.
sh "$stage/80_luci-videoplayer"

rm -f /tmp/luci-indexcache /tmp/luci-indexcache.* 2>/dev/null || true
rm -rf /tmp/luci-modulecache 2>/dev/null || true
/etc/init.d/rpcd reload 2>/dev/null || true

rm -rf "$stage"
echo OK
REMOTE_INSTALL

trap - EXIT HUP INT TERM

echo "Done."
echo "  1) Log out of LuCI and log in again if the new menu is not visible."
echo "  2) Open LuCI -> Services -> Video Player."
echo "The media directory is not created automatically."
echo "Mount USB/SD storage first, then create the configured directory there."
