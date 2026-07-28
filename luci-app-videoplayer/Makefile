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
LUCI_DESCRIPTION:=LuCI video player with browser playback and experimental router-CPU rendering for local media.
LUCI_DEPENDS:=+luci-base +uhttpd +jshn +coreutils-stat +coreutils-timeout +ffmpeg
LUCI_PKGARCH:=all
LUCI_URL:=https://github.com/communism420/luci-app-videoplayer

PKG_LICENSE:=GPL-2.0-or-later
LUCI_MAINTAINER:=openwrt-video-player contributors
PKG_MAINTAINER:=$(LUCI_MAINTAINER)
PKG_FILE_MODES:=/etc/uci-defaults/80_luci-videoplayer:root:root:0755 \
	/usr/libexec/rpcd/luci.videoplayer:root:root:0755 \
	/usr/libexec/videoplayer-renderer:root:root:0755 \
	/www/cgi-bin/videoplayer-stream:root:root:0755 \
	/www/cgi-bin/videoplayer-frame:root:root:0755

define Package/luci-app-videoplayer/conffiles
/etc/config/videoplayer
endef

define Package/luci-app-videoplayer/prerm
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] ||
	/usr/libexec/videoplayer-renderer cleanup 2>/dev/null || true
exit 0
endef

define Package/luci-app-videoplayer/postrm
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	/usr/libexec/videoplayer-renderer cleanup 2>/dev/null || true
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
	rm -f /tmp/videoplayer-render-v1.lock /tmp/videoplayer-render-v1.worker.lock 2>/dev/null || true
	/etc/init.d/rpcd reload 2>/dev/null || true
}
exit 0
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
