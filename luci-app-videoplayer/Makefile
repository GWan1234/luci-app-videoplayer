# SPDX-License-Identifier: GPL-2.0-or-later
#
# Copyright (C) 2026 openwrt-video-player contributors
#
# Build as part of an OpenWrt tree with the luci feed, e.g.:
#   ./scripts/feeds update luci
#   cp -r luci-app-videoplayer feeds/luci/applications/
#   ./scripts/feeds install luci-app-videoplayer
#   make package/luci-app-videoplayer/compile

include $(TOPDIR)/rules.mk

PKG_VERSION:=1.1.0
# Override luci.mk's default release so the package version stays exactly 1.1.0.
PKG_RELEASE:=

LUCI_TITLE:=LuCI Video Player (local + remote)
LUCI_DESCRIPTION:=LuCI video player with browser playback and strict attested software-CPU MJPEG/PCM rendering for local media.
LUCI_DEPENDS:=+luci-base +uhttpd +jshn +coreutils-stat +coreutils-timeout
LUCI_PKGARCH:=all
LUCI_URL:=https://github.com/communism420/luci-app-videoplayer

PKG_LICENSE:=GPL-2.0-or-later
LUCI_MAINTAINER:=openwrt-video-player contributors
PKG_MAINTAINER:=$(LUCI_MAINTAINER)
PKG_FILE_MODES:=/etc/uci-defaults/80_luci-videoplayer:root:root:0755 \
	/usr/libexec/rpcd/luci.videoplayer:root:root:0755 \
	/usr/libexec/videoplayer-renderer:root:root:0755 \
	/www/cgi-bin/videoplayer-stream:root:root:0755 \
	/www/cgi-bin/videoplayer-frame:root:root:0755 \
	/www/cgi-bin/videoplayer-audio:root:root:0755

define Package/luci-app-videoplayer/conffiles
/etc/config/videoplayer
endef

define Package/luci-app-videoplayer/preinst
#!/bin/sh
if [ -z "$${IPKG_INSTROOT:-}" ]; then
	renderer_helper="/usr/libexec/videoplayer-renderer"
	maintenance_marker="/tmp/videoplayer-render-v1.maintenance"
	control_lock="/tmp/videoplayer-render-v1.lock"
	worker_lock="/tmp/videoplayer-render-v1.worker.lock"
	runtime_dir="/tmp/videoplayer-render-v1"
	validate_marker() {
		[ -f "$$maintenance_marker" ] && [ ! -L "$$maintenance_marker" ] &&
			[ "$$(readlink -f -- "$$maintenance_marker" 2>/dev/null)" = "$$maintenance_marker" ] &&
			[ "$$(stat -c '%u:%a:%s' -- "$$maintenance_marker" 2>/dev/null)" = "0:600:15" ] &&
			[ "$$(cat "$$maintenance_marker" 2>/dev/null)" = "maintenance-v1" ]
	}
	ensure_lock() {
		if [ ! -e "$$1" ] && [ ! -L "$$1" ]; then
			(umask 077; set -C; : > "$$1") 2>/dev/null || :
		fi
		[ -f "$$1" ] && [ ! -L "$$1" ] &&
			[ "$$(readlink -f -- "$$1" 2>/dev/null)" = "$$1" ] || return 1
		chmod 0600 "$$1" 2>/dev/null &&
			[ "$$(stat -c '%u:%a' -- "$$1" 2>/dev/null)" = "0:600" ]
	}
	lock_fd() {
		lock_round=0
		while ! flock -xn "$$1" 2>/dev/null; do
			lock_round=$$((lock_round + 1))
			[ "$$lock_round" -lt 15 ] || return 1
			sleep 1
		done
	}
	if [ -e "$${renderer_helper}" ] || [ -L "$${renderer_helper}" ]; then
		[ -f "$${renderer_helper}" ] &&
			[ ! -L "$${renderer_helper}" ] &&
			[ -x "$${renderer_helper}" ] &&
			[ "$$(readlink -f -- "$${renderer_helper}" 2>/dev/null)" = "$${renderer_helper}" ] &&
			[ "$$(stat -c '%u:%a' -- "$${renderer_helper}" 2>/dev/null)" = "0:755" ] || {
			echo "Cannot enter safe renderer maintenance before replacing the application." >&2
			exit 1
		}
		maintenance_output="$$(
			"$${renderer_helper}" maintenance-enter
			maintenance_status=$$?
			printf '__VIDEOPLAYER_RC__%s' "$$maintenance_status"
		)"
		maintenance_expected="$$(printf 'maintenance\n__VIDEOPLAYER_RC__0')"
		[ "$$maintenance_output" = "$$maintenance_expected" ] || {
			echo "The installed renderer predates strict maintenance. Use the current verified standalone application package once to migrate it safely." >&2
			exit 1
		}
		if ! "$${renderer_helper}" cleanup || ! validate_marker; then
			echo "Could not quiesce the renderer before replacing the application; maintenance remains active." >&2
			exit 1
		fi
	else
		had_marker=0
		{ [ -e "$$maintenance_marker" ] || [ -L "$$maintenance_marker" ]; } && had_marker=1
		if [ "$$had_marker" -eq 0 ]; then
			{ [ ! -e "$$control_lock" ] && [ ! -L "$$control_lock" ] &&
				[ ! -e "$$worker_lock" ] && [ ! -L "$$worker_lock" ]; } || {
				echo "Renderer helper is missing while renderer locks exist; use the standalone installer for recovery." >&2
				exit 1
			}
			(umask 077; set -C; printf 'maintenance-v1\n' > "$$maintenance_marker") 2>/dev/null ||
				validate_marker || exit 1
		fi
		validate_marker && ensure_lock "$$control_lock" && ensure_lock "$$worker_lock" || exit 1
		exec 9< "$$control_lock" && lock_fd 9 &&
			exec 8< "$$worker_lock" && lock_fd 8 || exit 1
		[ ! -e "$$runtime_dir" ] && [ ! -L "$$runtime_dir" ] || {
			echo "Renderer runtime exists without a trusted helper; use the standalone installer for recovery." >&2
			exit 1
		}
	fi
fi
exit 0
endef

define Package/luci-app-videoplayer/postinst
#!/bin/sh
if [ -z "$${IPKG_INSTROOT:-}" ]; then
	renderer_helper="/usr/libexec/videoplayer-renderer"
	maintenance_marker="/tmp/videoplayer-render-v1.maintenance"
	if [ -e "$$maintenance_marker" ] || [ -L "$$maintenance_marker" ]; then
		[ -f "$$renderer_helper" ] && [ ! -L "$$renderer_helper" ] &&
			[ -x "$$renderer_helper" ] &&
			[ "$$(readlink -f -- "$$renderer_helper" 2>/dev/null)" = "$$renderer_helper" ] &&
			[ "$$(stat -c '%u:%a' -- "$$renderer_helper" 2>/dev/null)" = "0:755" ] &&
			[ -f "$$maintenance_marker" ] && [ ! -L "$$maintenance_marker" ] &&
			[ "$$(stat -c '%u:%a:%s' -- "$$maintenance_marker" 2>/dev/null)" = "0:600:15" ] &&
			[ "$$(cat "$$maintenance_marker" 2>/dev/null)" = "maintenance-v1" ] || exit 1
		maintenance_output="$$(
			"$$renderer_helper" maintenance-enter
			maintenance_status=$$?
			printf '__VIDEOPLAYER_RC__%s' "$$maintenance_status"
		)"
		[ "$$maintenance_output" = "$$(printf 'maintenance\n__VIDEOPLAYER_RC__0')" ] &&
			"$$renderer_helper" cleanup || exit 1
		resume_output="$$(
			"$$renderer_helper" maintenance-exit
			resume_status=$$?
			printf '__VIDEOPLAYER_RC__%s' "$$resume_status"
		)"
		[ "$$resume_output" = "$$(printf 'resumed\n__VIDEOPLAYER_RC__0')" ] &&
			[ ! -e "$$maintenance_marker" ] && [ ! -L "$$maintenance_marker" ] || exit 1
	fi
fi
exit 0
endef

define Package/luci-app-videoplayer/prerm
#!/bin/sh
if [ -z "$${IPKG_INSTROOT:-}" ]; then
	renderer_helper="/usr/libexec/videoplayer-renderer"
	maintenance_marker="/tmp/videoplayer-render-v1.maintenance"
	if [ -e "$${renderer_helper}" ] || [ -L "$${renderer_helper}" ]; then
		[ -f "$${renderer_helper}" ] &&
			[ ! -L "$${renderer_helper}" ] &&
			[ -x "$${renderer_helper}" ] &&
			[ "$$(readlink -f -- "$${renderer_helper}" 2>/dev/null)" = "$${renderer_helper}" ] &&
			[ "$$(stat -c '%u:%a' -- "$${renderer_helper}" 2>/dev/null)" = "0:755" ] || {
			echo "Cannot enter safe renderer maintenance before removing the application." >&2
			exit 1
		}
		maintenance_output="$$(
			"$${renderer_helper}" maintenance-enter
			maintenance_status=$$?
			printf '__VIDEOPLAYER_RC__%s' "$$maintenance_status"
		)"
		[ "$$maintenance_output" = "$$(printf 'maintenance\n__VIDEOPLAYER_RC__0')" ] &&
			"$${renderer_helper}" cleanup &&
			[ -f "$$maintenance_marker" ] && [ ! -L "$$maintenance_marker" ] &&
			[ "$$(stat -c '%u:%a:%s' -- "$$maintenance_marker" 2>/dev/null)" = "0:600:15" ] &&
			[ "$$(cat "$$maintenance_marker" 2>/dev/null)" = "maintenance-v1" ] || {
			echo "Could not quiesce the renderer before removing the application; maintenance remains active." >&2
			exit 1
		}
	fi
fi
exit 0
endef

define Package/luci-app-videoplayer/postrm
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	cleanup_token_store() (
		lock_file="/tmp/videoplayer-tokens.lock"
		token_dir="/tmp/videoplayer-tokens"
		marker="$$token_dir/.bucket-v1"
		if [ ! -e "$$lock_file" ] && [ ! -L "$$lock_file" ]; then
			(umask 077; set -C; : > "$$lock_file") 2>/dev/null || :
		fi
		[ -f "$$lock_file" ] && [ ! -L "$$lock_file" ] || return 1
		[ "$$(stat -c '%u' -- "$$lock_file" 2>/dev/null)" = "0" ] || return 1
		[ "$$(readlink -f -- "$$lock_file" 2>/dev/null)" = "$$lock_file" ] || return 1
		chmod 0600 "$$lock_file" 2>/dev/null || return 1
		exec 9< "$$lock_file" || return 1
		flock -x 9 || return 1
		if [ ! -e "$$token_dir" ] && [ ! -L "$$token_dir" ]; then
			(umask 077; mkdir "$$token_dir") || return 1
		fi
		[ -d "$$token_dir" ] && [ ! -L "$$token_dir" ] || return 1
		[ "$$(stat -c '%u' -- "$$token_dir" 2>/dev/null)" = "0" ] || return 1
		[ "$$(readlink -f -- "$$token_dir" 2>/dev/null)" = "$$token_dir" ] || return 1
		chmod 0700 "$$token_dir" 2>/dev/null || return 1
		if [ ! -e "$$marker" ] && [ ! -L "$$marker" ]; then
			marker_tmp="$$token_dir/.cleanup-marker.$$$$"
			rm -f -- "$$marker_tmp" || return 1
			(umask 077; set -C; printf 'bucket-v1\n' > "$$marker_tmp") 2>/dev/null || {
				rm -f -- "$$marker_tmp"
				return 1
			}
			if ! ln "$$marker_tmp" "$$marker" 2>/dev/null; then
				if [ ! -f "$$marker" ] || [ -L "$$marker" ]; then
					rm -f -- "$$marker_tmp"
					return 1
				fi
			fi
			rm -f -- "$$marker_tmp"
		fi
		[ -f "$$marker" ] && [ ! -L "$$marker" ] || return 1
		exec 8< "$$marker" || return 1
		flock -x 8 || return 1
		find "$$token_dir" -mindepth 1 -maxdepth 1 ! -name '.bucket-v1' -exec rm -rf -- '{}' \;
	)
	rm -f /tmp/luci-indexcache /tmp/luci-indexcache.* 2>/dev/null || true
	rm -rf /tmp/luci-modulecache 2>/dev/null || true
	cleanup_token_store 2>/dev/null || true
	/etc/init.d/rpcd reload 2>/dev/null || true
}
exit 0
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
