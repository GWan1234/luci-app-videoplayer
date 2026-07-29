# SPDX-License-Identifier: GPL-2.0-or-later
#
# Private FFmpeg runtime for luci-app-videoplayer.
# The workflow generates files/build-info for one exact release/package ABI
# before invoking this recipe.

include $(TOPDIR)/rules.mk

CODEC_BUILD_INFO:=$(CURDIR)/files/build-info
CODEC_OPENWRT_RELEASE:=$(strip $(shell sed -n 's/^openwrt_release=//p' $(CODEC_BUILD_INFO)))
CODEC_OPENWRT_REVISION:=$(strip $(shell sed -n 's/^openwrt_revision=//p' $(CODEC_BUILD_INFO)))
CODEC_COMPATIBLE_ARCH:=$(strip $(shell sed -n 's/^compatible_arch=//p' $(CODEC_BUILD_INFO)))
CODEC_BUILD_TARGET:=$(strip $(shell sed -n 's/^build_target=//p' $(CODEC_BUILD_INFO)))
CODEC_BUILD_SUBTARGET:=$(strip $(shell sed -n 's/^build_subtarget=//p' $(CODEC_BUILD_INFO)))

ifeq ($(CODEC_OPENWRT_RELEASE),)
  $(error codec runtime build-info is missing openwrt_release)
endif
ifeq ($(CODEC_OPENWRT_REVISION),)
  $(error codec runtime build-info is missing openwrt_revision)
endif
ifeq ($(CODEC_COMPATIBLE_ARCH),)
  $(error codec runtime build-info is missing compatible_arch)
endif
ifeq ($(CODEC_BUILD_TARGET),)
  $(error codec runtime build-info is missing build_target)
endif
ifeq ($(CODEC_BUILD_SUBTARGET),)
  $(error codec runtime build-info is missing build_subtarget)
endif
ifneq ($(findstring @,$(CODEC_OPENWRT_RELEASE)$(CODEC_OPENWRT_REVISION)$(CODEC_COMPATIBLE_ARCH)$(CODEC_BUILD_TARGET)$(CODEC_BUILD_SUBTARGET)),)
  $(error codec runtime build-info template was not expanded)
endif

PKG_NAME:=ffmpeg
PKG_VERSION:=6.1.4
PKG_RELEASE:=2

PKG_SOURCE:=$(PKG_NAME)-$(PKG_VERSION).tar.xz
PKG_SOURCE_URL:=https://ffmpeg.org/releases/
PKG_HASH:=a231e3d5742c44b1cdaebfb98ad7b6200d12763e0b6db9e1e2c5891f2c083a18

PKG_MAINTAINER:=openwrt-video-player contributors
PKG_LICENSE:=LGPL-2.1-or-later GPL-2.0-or-later LGPL-3.0-or-later
PKG_LICENSE_FILES:=COPYING.GPLv2 COPYING.GPLv3 COPYING.LGPLv2.1 COPYING.LGPLv3
PKG_CPE_ID:=cpe:/a:ffmpeg:ffmpeg

PKG_BUILD_PARALLEL:=1
# FFmpeg's native H.264 CABAC inline assembly cannot be compiled as MIPS16.
# OpenWrt's package flag removes -mips16 only on targets that enable it.
PKG_BUILD_FLAGS:=no-mips16
PKG_CONFIG_DEPENDS:=CONFIG_BUILD_PATENTED

include $(INCLUDE_DIR)/package.mk

# Match the CPU selection used by the official OpenWrt FFmpeg recipe.
REAL_CPU_TYPE:=$(call qstrip,$(firstword $(subst +, ,$(CONFIG_CPU_TYPE))))
REAL_CPU_TYPE:=$(subst octeonplus,octeon+,$(REAL_CPU_TYPE))

# Keep the architecture safeguards from OpenWrt's pinned FFmpeg recipe. These
# flags are especially important on soft-float ARM and embedded PowerPC CPUs:
# allowing configure to auto-enable a newer ISA can produce an installable
# package which then dies with SIGILL on the router.
CODEC_ARCH_CONFIG:=
ifeq ($(CONFIG_SOFT_FLOAT),y)
  CODEC_ARCH_CONFIG+= \
	--disable-altivec \
	--disable-vsx \
	--disable-power8 \
	--disable-armv5te \
	--disable-armv6 \
	--disable-armv6t2 \
	--disable-fast-unaligned
else ifneq ($(findstring powerpc,$(CONFIG_ARCH)),)
  CODEC_ARCH_CONFIG+=--disable-altivec
endif

ifneq ($(findstring arm,$(CONFIG_ARCH)),)
  ifneq ($(findstring vfp,$(CONFIG_CPU_TYPE)),)
    CODEC_ARCH_CONFIG+=--enable-vfp
  else
    CODEC_ARCH_CONFIG+=--disable-vfp
  endif
  ifneq ($(findstring neon,$(CONFIG_CPU_TYPE)),)
    CODEC_ARCH_CONFIG+=--enable-neon --enable-vfp
  else
    CODEC_ARCH_CONFIG+=--disable-neon
  endif
endif

ifneq ($(findstring aarch64,$(CONFIG_ARCH)),)
  CODEC_ARCH_CONFIG+=--enable-neon --enable-vfp
endif

define Package/luci-videoplayer-codec-runtime
  SECTION:=multimedia
  CATEGORY:=Multimedia
  TITLE:=Private patented-codec FFmpeg runtime for LuCI Video Player
  URL:=https://github.com/communism420/luci-app-videoplayer
  DEPENDS:=@BUILD_PATENTED
  VARIANT:=videoplayer
endef

define Package/luci-videoplayer-codec-runtime/description
 A target-specific FFmpeg command-line runtime for luci-app-videoplayer.
 It embeds the libav libraries into one private ELF and installs no files in
 /usr/bin or /usr/lib. Every package is built for one exact OpenWrt release,
 revision, and package architecture recorded in its private build metadata.
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
			--extra-ldflags="-static-libgcc -Wl,-Bstatic" \
			--extra-libs="-latomic -Wl,-Bdynamic" \
			--enable-ffmpeg \
			--disable-ffplay \
			--disable-ffprobe \
			--disable-programs \
			--enable-ffmpeg \
			--enable-avcodec \
			--enable-avformat \
			--enable-avfilter \
			--enable-swscale \
			--enable-swresample \
			--disable-avdevice \
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
			--disable-x86asm \
			--disable-zlib \
			--disable-bzlib \
			--disable-lzma \
			--disable-iconv \
			--disable-doc \
			--disable-debug \
			--enable-small \
			--enable-pthreads \
			--disable-runtime-cpudetect \
			$(CODEC_ARCH_CONFIG) \
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
			--enable-decoder=aac \
			--enable-decoder=ac3 \
			--enable-decoder=eac3 \
			--enable-decoder=alac \
			--enable-decoder=dca \
			--enable-decoder=flac \
			--enable-decoder=mp3 \
			--enable-decoder=opus \
			--enable-decoder=pcm_s16le \
			--enable-decoder=truehd \
			--enable-decoder=vorbis \
			--enable-encoder=pcm_s16le \
			--enable-muxer=pcm_s16le \
			--enable-filter=aresample \
			--enable-filter=aformat \
			--enable-filter=asetnsamples \
	)
endef

define Build/Compile
	+$(MAKE) $(PKG_JOBS) -C $(PKG_BUILD_DIR) ffmpeg
	$(INSTALL_DIR) $(PKG_BUILD_DIR)/.pkgdir/.videoplayer-validation
	$(CP) $(PKG_BUILD_DIR)/config.h \
		$(PKG_BUILD_DIR)/config_components.h \
		$(PKG_BUILD_DIR)/.pkgdir/.videoplayer-validation/
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
	[ "$${DISTRIB_RELEASE:-}" = "$(CODEC_OPENWRT_RELEASE)" ] &&
		[ "$${DISTRIB_REVISION:-}" = "$(CODEC_OPENWRT_REVISION)" ] &&
		[ "$${DISTRIB_ARCH:-}" = "$(CODEC_COMPATIBLE_ARCH)" ] || {
		echo "This codec runtime requires OpenWrt $(CODEC_OPENWRT_RELEASE) $(CODEC_OPENWRT_REVISION), architecture $(CODEC_COMPATIBLE_ARCH)." >&2
		exit 1
	}
fi
exit 0
endef

$(eval $(call BuildPackage,luci-videoplayer-codec-runtime))
