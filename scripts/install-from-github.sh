#!/bin/sh
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Install luci-app-videoplayer 1.0.0 directly from its GitHub release.

set -eu

RELEASE_VERSION="1.0.0"
RELEASE_BASE_URL="https://github.com/communism420/luci-app-videoplayer/releases/download/$RELEASE_VERSION"

APK_FILE="luci-app-videoplayer-$RELEASE_VERSION.apk"
APK_SHA256="1748d7c763da95f2e4ac6a1c75d304042584ac309f836c1722962e511542f34d"
IPK_FILE="luci-app-videoplayer_${RELEASE_VERSION}_all.ipk"
IPK_SHA256="045ac25a604175c9a793e4a50509ccad4155dd46d81ef1deac360479aa40aa24"

# POSIX ulimit -f counts 512-byte blocks. This caps a download at 4 MiB.
MAX_PACKAGE_BLOCKS="8192"
WORK_DIR=""

die() {
	printf 'Error: %s\n' "$*" >&2
	exit 1
}

warn() {
	printf 'Warning: %s\n' "$*" >&2
}

cleanup() {
	[ -n "$WORK_DIR" ] || return 0
	case "$WORK_DIR" in
		/tmp/luci-app-videoplayer.*)
			rm -rf -- "$WORK_DIR"
			;;
	esac
}

download_file() (
	url="$1"
	destination="$2"

	if ! ulimit -f "$MAX_PACKAGE_BLOCKS"; then
		die "Could not set the package download size limit."
	fi

	if command -v uclient-fetch >/dev/null 2>&1; then
		uclient-fetch -O "$destination" "$url"
	elif command -v wget >/dev/null 2>&1; then
		wget -O "$destination" "$url"
	elif command -v curl >/dev/null 2>&1; then
		curl -fL --retry 3 --connect-timeout 20 -o "$destination" "$url"
	else
		die "No HTTPS downloader found (uclient-fetch, wget, or curl is required)."
	fi
)

case "${1:-}" in
	"")
		;;
	-h|--help)
		printf '%s\n' \
			"Usage: sh install-from-github.sh" \
			"" \
			"Downloads, verifies, and installs luci-app-videoplayer $RELEASE_VERSION on OpenWrt."
		exit 0
		;;
	*)
		die "This installer does not accept arguments."
		;;
esac

[ -r /etc/openwrt_release ] ||
	die "This installer must be run on OpenWrt."
[ "$(id -u)" = "0" ] ||
	die "Run this installer as root."
command -v sha256sum >/dev/null 2>&1 ||
	die "The sha256sum command is required to verify the package."
command -v mktemp >/dev/null 2>&1 ||
	die "The mktemp command is required."

HAS_APK="0"
HAS_OPKG="0"
if command -v apk >/dev/null 2>&1; then
	HAS_APK="1"
fi
if command -v opkg >/dev/null 2>&1; then
	HAS_OPKG="1"
fi

case "$HAS_APK:$HAS_OPKG" in
	1:0)
		PACKAGE_MANAGER="apk"
		PACKAGE_FILE="$APK_FILE"
		PACKAGE_SHA256="$APK_SHA256"
		;;
	0:1)
		PACKAGE_MANAGER="opkg"
		PACKAGE_FILE="$IPK_FILE"
		PACKAGE_SHA256="$IPK_SHA256"
		;;
	1:1)
		die "Both apk and opkg were found; package manager selection is ambiguous."
		;;
	*)
		die "Neither apk nor opkg was found."
		;;
esac

umask 077
WORK_DIR="$(mktemp -d /tmp/luci-app-videoplayer.XXXXXX)" ||
	die "Could not create a temporary directory."
trap cleanup 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

PACKAGE_PATH="$WORK_DIR/$PACKAGE_FILE"
PACKAGE_URL="$RELEASE_BASE_URL/$PACKAGE_FILE"
CHECKSUM_FILE="$WORK_DIR/SHA256SUMS"

printf 'Downloading %s from GitHub Release %s...\n' \
	"$PACKAGE_FILE" "$RELEASE_VERSION"
if ! download_file "$PACKAGE_URL" "$PACKAGE_PATH"; then
	die "Could not download $PACKAGE_URL"
fi
[ -s "$PACKAGE_PATH" ] ||
	die "The downloaded package is empty."

printf '%s  %s\n' "$PACKAGE_SHA256" "$PACKAGE_PATH" > "$CHECKSUM_FILE"
if ! sha256sum -c "$CHECKSUM_FILE"; then
	die "The downloaded package failed SHA-256 verification."
fi

printf 'Installing %s with %s...\n' "$PACKAGE_FILE" "$PACKAGE_MANAGER"
case "$PACKAGE_MANAGER" in
	apk)
		if ! apk update; then
			warn "Could not refresh apk indexes; continuing with the current indexes."
		fi
		apk add --allow-untrusted "$PACKAGE_PATH"
		;;
	opkg)
		if ! opkg update; then
			warn "Could not refresh opkg indexes; continuing with the current indexes."
		fi
		opkg --force-downgrade install "$PACKAGE_PATH"
		;;
esac

printf '%s\n' \
	"Installation complete." \
	"Sign out of LuCI and sign in again if the menu item is not visible." \
	"Open LuCI -> Services -> Video Player."
