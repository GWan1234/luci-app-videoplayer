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

enter_renderer_maintenance() {
	renderer_helper="/usr/libexec/videoplayer-renderer"
	maintenance_marker="/tmp/videoplayer-render-v1.maintenance"
	[ -e "$renderer_helper" ] || [ -L "$renderer_helper" ] || {
		echo "Renderer helper is missing; use the verified application package to repair or remove this installation safely." >&2
		return 1
	}
	[ -f "$renderer_helper" ] &&
		[ ! -L "$renderer_helper" ] &&
		[ -x "$renderer_helper" ] &&
		[ "$(readlink -f -- "$renderer_helper" 2>/dev/null)" = "$renderer_helper" ] &&
		[ "$(stat -c '%u:%a' "$renderer_helper" 2>/dev/null)" = "0:755" ] || {
		echo "Cannot safely enter renderer maintenance before uninstalling the application." >&2
		return 1
	}
	maintenance_output="$(
		"$renderer_helper" maintenance-enter
		maintenance_status=$?
		printf '__VIDEOPLAYER_RC__%s' "$maintenance_status"
	)"
	[ "$maintenance_output" = "$(printf 'maintenance\n__VIDEOPLAYER_RC__0')" ] || {
		echo "The installed renderer does not support strict maintenance. Upgrade with the verified 1.2.0 package before using the development uninstaller." >&2
		return 1
	}
	"$renderer_helper" cleanup || {
		echo "Could not quiesce the renderer before uninstalling the application; maintenance remains active." >&2
		return 1
	}
	[ -f "$maintenance_marker" ] && [ ! -L "$maintenance_marker" ] &&
		[ "$(readlink -f -- "$maintenance_marker" 2>/dev/null)" = "$maintenance_marker" ] &&
		[ "$(stat -c '%u:%a:%s' -- "$maintenance_marker" 2>/dev/null)" = "0:600:15" ] &&
		[ "$(cat "$maintenance_marker" 2>/dev/null)" = maintenance-v1 ] || {
		echo "Renderer maintenance marker is absent or unsafe; uninstall aborted." >&2
		return 1
	}
}

enter_renderer_maintenance

rm -f \
	/www/luci-static/resources/view/videoplayer/main.js \
	/www/cgi-bin/videoplayer-stream \
	/www/cgi-bin/videoplayer-frame \
	/www/cgi-bin/videoplayer-audio \
	/usr/libexec/rpcd/luci.videoplayer \
	/usr/libexec/videoplayer-renderer \
	/usr/share/luci/menu.d/luci-app-videoplayer.json \
	/usr/share/rpcd/acl.d/luci-app-videoplayer.json

rmdir /www/luci-static/resources/view/videoplayer 2>/dev/null || true

rm -f /tmp/luci-indexcache /tmp/luci-indexcache.* 2>/dev/null || true
rm -rf /tmp/luci-modulecache 2>/dev/null || true
cleanup_token_store 2>/dev/null || true
/etc/init.d/rpcd reload 2>/dev/null || true

echo "Program files removed; renderer maintenance remains active and /etc/config/videoplayer and media were preserved."
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
	"$PKG/www/cgi-bin/videoplayer-audio" \
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

for command_name in uci ubus sort stat flock; do
	command -v "$command_name" >/dev/null 2>&1 ||
		missing "command '$command_name'"
done

if [ -x /usr/libexec/videoplayer-ffmpeg/ffmpeg ]; then
	echo "Private codec runtime found; strict software-CPU attestation follows installation."
else
	echo "No private codec runtime found; Browser mode remains available, but strict Router mode will be unavailable." >&2
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
scp_openwrt "$PKG/www/cgi-bin/videoplayer-audio" \
	"$TARGET:$REMOTE_STAGE/audio-cgi"
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

maintenance_marker_is_safe() {
	maintenance_marker="/tmp/videoplayer-render-v1.maintenance"
	[ -f "$maintenance_marker" ] && [ ! -L "$maintenance_marker" ] &&
		[ "$(readlink -f -- "$maintenance_marker" 2>/dev/null)" = "$maintenance_marker" ] &&
		[ "$(stat -c '%u:%a:%s' -- "$maintenance_marker" 2>/dev/null)" = "0:600:15" ] &&
		[ "$(cat "$maintenance_marker" 2>/dev/null)" = maintenance-v1 ]
}

ensure_renderer_lock() {
	if [ ! -e "$1" ] && [ ! -L "$1" ]; then
		(umask 077; set -C; : > "$1") 2>/dev/null || :
	fi
	[ -f "$1" ] && [ ! -L "$1" ] &&
		[ "$(readlink -f -- "$1" 2>/dev/null)" = "$1" ] || return 1
	chmod 0600 "$1" 2>/dev/null &&
		[ "$(stat -c '%u:%a' -- "$1" 2>/dev/null)" = "0:600" ]
}

lock_renderer_fd() {
	lock_round=0
	while ! flock -xn "$1" 2>/dev/null; do
		lock_round=$((lock_round + 1))
		[ "$lock_round" -lt 15 ] || return 1
		sleep 1
	done
}

enter_renderer_maintenance() {
	renderer_helper="/usr/libexec/videoplayer-renderer"
	maintenance_marker="/tmp/videoplayer-render-v1.maintenance"
	control_lock="/tmp/videoplayer-render-v1.lock"
	worker_lock="/tmp/videoplayer-render-v1.worker.lock"
	runtime_dir="/tmp/videoplayer-render-v1"
	if [ ! -e "$renderer_helper" ] && [ ! -L "$renderer_helper" ]; then
		had_marker=0
		{ [ -e "$maintenance_marker" ] || [ -L "$maintenance_marker" ]; } && had_marker=1
		if [ "$had_marker" -eq 0 ]; then
			{ [ ! -e "$control_lock" ] && [ ! -L "$control_lock" ] &&
				[ ! -e "$worker_lock" ] && [ ! -L "$worker_lock" ]; } || {
				echo "Renderer helper is missing while renderer locks exist; use the verified application package for recovery." >&2
				return 1
			}
			(umask 077; set -C; printf 'maintenance-v1\n' > "$maintenance_marker") 2>/dev/null ||
				maintenance_marker_is_safe || return 1
		fi
		maintenance_marker_is_safe &&
			ensure_renderer_lock "$control_lock" &&
			ensure_renderer_lock "$worker_lock" || return 1
		exec 9< "$control_lock" && lock_renderer_fd 9 &&
			exec 8< "$worker_lock" && lock_renderer_fd 8 || return 1
		[ ! -e "$runtime_dir" ] && [ ! -L "$runtime_dir" ] || {
			echo "Renderer runtime exists without a trusted helper; use the verified application package for recovery." >&2
			return 1
		}
		return 0
	fi
	[ -f "$renderer_helper" ] &&
		[ ! -L "$renderer_helper" ] &&
		[ -x "$renderer_helper" ] &&
		[ "$(readlink -f -- "$renderer_helper" 2>/dev/null)" = "$renderer_helper" ] &&
		[ "$(stat -c '%u:%a' "$renderer_helper" 2>/dev/null)" = "0:755" ] || {
		echo "Cannot safely enter renderer maintenance before replacing the application." >&2
		return 1
	}
	maintenance_output="$(
		"$renderer_helper" maintenance-enter
		maintenance_status=$?
		printf '__VIDEOPLAYER_RC__%s' "$maintenance_status"
	)"
	[ "$maintenance_output" = "$(printf 'maintenance\n__VIDEOPLAYER_RC__0')" ] || {
		echo "The installed renderer predates strict maintenance. Upgrade with the verified 1.2.0 package before using the development installer." >&2
		return 1
	}
	"$renderer_helper" cleanup && maintenance_marker_is_safe || {
		echo "Could not quiesce the renderer before replacing the application; maintenance remains active." >&2
		return 1
	}
}

resume_renderer_after_change() {
	renderer_helper="/usr/libexec/videoplayer-renderer"
	maintenance_marker_is_safe || return 1
	[ -f "$renderer_helper" ] && [ ! -L "$renderer_helper" ] &&
		[ -x "$renderer_helper" ] &&
		[ "$(readlink -f -- "$renderer_helper" 2>/dev/null)" = "$renderer_helper" ] &&
		[ "$(stat -c '%u:%a' -- "$renderer_helper" 2>/dev/null)" = "0:755" ] || return 1
	maintenance_output="$(
		"$renderer_helper" maintenance-enter
		maintenance_status=$?
		printf '__VIDEOPLAYER_RC__%s' "$maintenance_status"
	)"
	[ "$maintenance_output" = "$(printf 'maintenance\n__VIDEOPLAYER_RC__0')" ] &&
		"$renderer_helper" cleanup && maintenance_marker_is_safe || return 1
	resume_output="$(
		"$renderer_helper" maintenance-exit
		resume_status=$?
		printf '__VIDEOPLAYER_RC__%s' "$resume_status"
	)"
	[ "$resume_output" = "$(printf 'resumed\n__VIDEOPLAYER_RC__0')" ] &&
		[ ! -e "/tmp/videoplayer-render-v1.maintenance" ] &&
		[ ! -L "/tmp/videoplayer-render-v1.maintenance" ]
}

if [ ! -f /etc/config/videoplayer ]; then
	install_staged videoplayer.config /etc/config/videoplayer 0644
fi

enter_renderer_maintenance

install_staged menu.json /usr/share/luci/menu.d/luci-app-videoplayer.json 0644
install_staged acl.json /usr/share/rpcd/acl.d/luci-app-videoplayer.json 0644
install_staged rpcd-backend /usr/libexec/rpcd/luci.videoplayer 0755
install_staged renderer /usr/libexec/videoplayer-renderer 0755
install_staged stream-cgi /www/cgi-bin/videoplayer-stream 0755
install_staged frame-cgi /www/cgi-bin/videoplayer-frame 0755
install_staged audio-cgi /www/cgi-bin/videoplayer-audio 0755
install_staged main.js /www/luci-static/resources/view/videoplayer/main.js 0644

# Add only missing UCI values; this never creates the media directory.
sh "$stage/80_luci-videoplayer"

resume_renderer_after_change || {
	echo "The new files were installed, but renderer maintenance could not be completed; playback remains blocked." >&2
	exit 1
}

rm -f /tmp/luci-indexcache /tmp/luci-indexcache.* 2>/dev/null || true
rm -rf /tmp/luci-modulecache 2>/dev/null || true
/etc/init.d/rpcd reload 2>/dev/null || true

attestation_tab="$(printf '\t')"
expected_attestation="private-software-cpu${attestation_tab}software-cpu-v1${attestation_tab}none"
if renderer_attestation="$(
	/usr/libexec/videoplayer-renderer attest 2>/dev/null
)" && [ "$renderer_attestation" = "$expected_attestation" ]; then
	echo "Strict Router mode attestation passed: private software CPU runtime."
else
	echo "Strict Router mode is unavailable until codec runtime 6.1.4-r4 passes attestation; Browser mode remains available." >&2
fi

rm -rf "$stage"
echo OK
REMOTE_INSTALL

trap - EXIT HUP INT TERM

echo "Done."
echo "  1) Log out of LuCI and log in again if the new menu is not visible."
echo "  2) Open LuCI -> Services -> Video Player."
echo "The media directory is not created automatically."
echo "Mount USB/SD storage first, then create the configured directory there."
