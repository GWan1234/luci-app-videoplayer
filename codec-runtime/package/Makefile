# SPDX-License-Identifier: GPL-2.0-or-later
#
# Private FFmpeg runtime for luci-app-videoplayer.
# This recipe is intentionally pinned to the FFmpeg source used by the
# OpenWrt 25.12.5 packages feed.

include $(TOPDIR)/rules.mk

PKG_NAME:=ffmpeg
PKG_VERSION:=6.1.4
PKG_RELEASE:=1

PKG_SOURCE:=$(PKG_NAME)-$(PKG_VERSION).tar.xz
PKG_SOURCE_URL:=https://ffmpeg.org/releases/
PKG_HASH:=a231e3d5742c44b1cdaebfb98ad7b6200d12763e0b6db9e1e2c5891f2c083a18

PKG_MAINTAINER:=openwrt-video-player contributors
PKG_LICENSE:=LGPL-2.1-or-later GPL-2.0-or-later LGPL-3.0-or-later
PKG_LICENSE_FILES:=COPYING.GPLv2 COPYING.GPLv3 COPYING.LGPLv2.1 COPYING.LGPLv3
PKG_CPE_ID:=cpe:/a:ffmpeg:ffmpeg

PKG_BUILD_PARALLEL:=1
PKG_CONFIG_DEPENDS:=CONFIG_BUILD_PATENTED

include $(INCLUDE_DIR)/package.mk

# Match the CPU selection used by the official OpenWrt FFmpeg recipe.
REAL_CPU_TYPE:=$(call qstrip,$(firstword $(subst +, ,$(CONFIG_CPU_TYPE))))
REAL_CPU_TYPE:=$(subst octeonplus,octeon+,$(REAL_CPU_TYPE))

define Package/luci-videoplayer-codec-runtime
  SECTION:=multimedia
  CATEGORY:=Multimedia
  TITLE:=Private patented-codec FFmpeg runtime for LuCI Video Player
  URL:=https://github.com/communism420/luci-app-videoplayer
  DEPENDS:=@TARGET_mediatek_filogic @BUILD_PATENTED
  VARIANT:=videoplayer
endef

define Package/luci-videoplayer-codec-runtime/description
 A target-specific FFmpeg command-line runtime for luci-app-videoplayer.
 It embeds the libav libraries into one private ELF and installs no files in
 /usr/bin or /usr/lib. This build is only for OpenWrt 25.12.5,
 mediatek/filogic, aarch64_cortex-a53.
endef

define Build/Configure
	test "$(CONFIG_BUILD_PATENTED)" = "y" || { \
		echo "CONFIG_BUILD_PATENTED=y is required" >&2; \
		exit 1; \
	}
	( cd $(PKG_BUILD_DIR); \
		CFLAGS="$(TARGET_CFLAGS) $(TARGET_CPPFLAGS)" \
		LDFLAGS="$(TARGET_LDFLAGS)" \
		./configure \
			--enable-cross-compile \
			--cross-prefix="$(TARGET_CROSS)" \
			--arch="$(ARCH)" \
			$(if $(REAL_CPU_TYPE),--cpu="$(REAL_CPU_TYPE)") \
			--target-os=linux \
			--prefix="/usr" \
			--bindir="/usr/libexec/videoplayer-ffmpeg" \
			--pkg-config=false \
			--extra-ldflags="-static-libgcc" \
			--enable-ffmpeg \
			--disable-ffplay \
			--disable-ffprobe \
			--disable-programs \
			--enable-ffmpeg \
			--enable-avcodec \
			--enable-avformat \
			--enable-avfilter \
			--enable-swscale \
			--disable-avdevice \
			--disable-swresample \
			--disable-postproc \
			--disable-shared \
			--enable-static \
			--disable-autodetect \
			--disable-network \
			--disable-indevs \
			--disable-outdevs \
			--disable-hwaccels \
			--disable-vaapi \
			--disable-vdpau \
			--disable-vulkan \
			--disable-zlib \
			--disable-bzlib \
			--disable-lzma \
			--disable-iconv \
			--disable-doc \
			--disable-debug \
			--enable-small \
			--enable-pthreads \
			--disable-runtime-cpudetect \
			--enable-neon \
			--enable-vfp \
			--disable-decoder=h263_v4l2m2m \
			--disable-decoder=h264_v4l2m2m \
			--disable-decoder=hevc_v4l2m2m \
			--disable-decoder=mpeg1_v4l2m2m \
			--disable-decoder=mpeg2_v4l2m2m \
			--disable-decoder=mpeg4_v4l2m2m \
			--disable-decoder=vc1_v4l2m2m \
			--disable-decoder=vp8_v4l2m2m \
			--disable-decoder=vp9_v4l2m2m \
			--enable-decoder=h264 \
			--enable-decoder=hevc \
			--enable-decoder=vc1 \
	)
endef

define Build/Compile
	+$(MAKE) $(PKG_JOBS) -C $(PKG_BUILD_DIR) ffmpeg
endef

define Package/luci-videoplayer-codec-runtime/install
	$(INSTALL_DIR) $(1)/usr/libexec/videoplayer-ffmpeg
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/ffmpeg \
		$(1)/usr/libexec/videoplayer-ffmpeg/ffmpeg
	$(INSTALL_DIR) $(1)/usr/share/luci-videoplayer-codec-runtime
	$(INSTALL_DATA) ./files/build-info \
		$(1)/usr/share/luci-videoplayer-codec-runtime/build-info
endef

define Package/luci-videoplayer-codec-runtime/preinst
#!/bin/sh
if [ -z "$${IPKG_INSTROOT:-}" ]; then
	[ -r /etc/openwrt_release ] || {
		echo "This codec runtime can only be installed on OpenWrt." >&2
		exit 1
	}
	. /etc/openwrt_release
	[ "$${DISTRIB_RELEASE:-}" = "25.12.5" ] &&
		[ "$${DISTRIB_REVISION:-}" = "r33051-f5dae5ece4" ] &&
		[ "$${DISTRIB_TARGET:-}" = "mediatek/filogic" ] &&
		[ "$${DISTRIB_ARCH:-}" = "aarch64_cortex-a53" ] || {
		echo "This codec runtime requires OpenWrt 25.12.5 r33051-f5dae5ece4 mediatek/filogic aarch64_cortex-a53." >&2
		exit 1
	}
fi
exit 0
endef

$(eval $(call BuildPackage,luci-videoplayer-codec-runtime))
