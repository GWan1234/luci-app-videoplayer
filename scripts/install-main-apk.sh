#!/bin/sh
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Install the APK built from the current main branch after its checks pass.

set -eu

REPOSITORY="communism420/luci-app-videoplayer"
MAIN_BRANCH="main"
SNAPSHOT_BRANCH="snapshot"
SNAPSHOT_APK="luci-app-videoplayer-main.apk"
API_BASE_URL="https://api.github.com/repos/$REPOSITORY"
RAW_BASE_URL="https://raw.githubusercontent.com/$REPOSITORY"

# POSIX ulimit -f counts 512-byte blocks.
MAX_METADATA_BLOCKS="32"
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
		/tmp/luci-app-videoplayer-main.*)
			rm -rf -- "$WORK_DIR"
			;;
	esac
}

download_file() (
	url="$1"
	destination="$2"
	max_blocks="$3"

	if ! ulimit -f "$max_blocks"; then
		die "Could not set the download size limit."
	fi

	if command -v uclient-fetch >/dev/null 2>&1; then
		uclient-fetch -T 20 -O "$destination" "$url"
	elif command -v wget >/dev/null 2>&1; then
		wget -T 20 -O "$destination" "$url"
	elif command -v curl >/dev/null 2>&1; then
		curl -fL --retry 3 --connect-timeout 20 -o "$destination" "$url"
	else
		die "No HTTPS downloader found (uclient-fetch, wget, or curl is required)."
	fi
)

download_commit_sha() (
	url="$1"
	destination="$2"

	if ! ulimit -f "$MAX_METADATA_BLOCKS"; then
		die "Could not set the metadata download size limit."
	fi

	if command -v uclient-fetch >/dev/null 2>&1; then
		uclient-fetch \
			--header="Accept: application/vnd.github.sha" \
			-T 20 -O "$destination" "$url"
	elif command -v wget >/dev/null 2>&1; then
		wget \
			--header="Accept: application/vnd.github.sha" \
			-T 20 -O "$destination" "$url"
	elif command -v curl >/dev/null 2>&1; then
		curl -fL --retry 3 --connect-timeout 20 \
			-H "Accept: application/vnd.github.sha" \
			-o "$destination" "$url"
	else
		die "No HTTPS downloader found (uclient-fetch, wget, or curl is required)."
	fi
)

read_commit_sha() {
	sha_file="$1"
	sha_value="$(tr -d '\r\n' < "$sha_file")"

	[ "${#sha_value}" -eq 40 ] || return 1
	case "$sha_value" in
		*[!0-9a-f]*)
			return 1
			;;
	esac

	printf '%s\n' "$sha_value"
}

case "${1:-}" in
	"")
		;;
	-h|--help)
		printf '%s\n' \
			"Usage: sh install-main-apk.sh" \
			"" \
			"Downloads, verifies, and installs the APK built from the current main branch." \
			"This installer supports only OpenWrt versions that use apk."
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
command -v apk >/dev/null 2>&1 ||
	die "The apk package manager is required; this installer does not support opkg."
if command -v opkg >/dev/null 2>&1; then
	die "Both apk and opkg were found; package manager selection is ambiguous."
fi
command -v sha256sum >/dev/null 2>&1 ||
	die "The sha256sum command is required to verify the package."
command -v mktemp >/dev/null 2>&1 ||
	die "The mktemp command is required."
command -v tr >/dev/null 2>&1 ||
	die "The tr command is required."

umask 077
WORK_DIR="$(mktemp -d /tmp/luci-app-videoplayer-main.XXXXXX)" ||
	die "Could not create a temporary directory."
trap cleanup 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

SNAPSHOT_REF_PATH="$WORK_DIR/snapshot-ref"
SNAPSHOT_REF_URL="$API_BASE_URL/commits/$SNAPSHOT_BRANCH"
printf 'Resolving the latest successful main APK...\n'
if ! download_commit_sha "$SNAPSHOT_REF_URL" "$SNAPSHOT_REF_PATH"; then
	die "No published main APK was found. Wait for the GitHub package checks and retry."
fi
SNAPSHOT_COMMIT="$(read_commit_sha "$SNAPSHOT_REF_PATH")" ||
	die "GitHub returned an invalid snapshot commit identifier."

SNAPSHOT_RAW_URL="$RAW_BASE_URL/$SNAPSHOT_COMMIT"
SOURCE_COMMIT_PATH="$WORK_DIR/SOURCE_COMMIT"
CHECKSUM_PATH="$WORK_DIR/$SNAPSHOT_APK.sha256"
APK_PATH="$WORK_DIR/$SNAPSHOT_APK"

if ! download_file \
	"$SNAPSHOT_RAW_URL/SOURCE_COMMIT" \
	"$SOURCE_COMMIT_PATH" \
	"$MAX_METADATA_BLOCKS"; then
	die "Could not download the snapshot source identifier."
fi
SOURCE_COMMIT="$(read_commit_sha "$SOURCE_COMMIT_PATH")" ||
	die "The snapshot contains an invalid source commit identifier."

if ! download_file \
	"$SNAPSHOT_RAW_URL/$SNAPSHOT_APK.sha256" \
	"$CHECKSUM_PATH" \
	"$MAX_METADATA_BLOCKS"; then
	die "Could not download the APK checksum."
fi

printf 'Downloading the APK built from main commit %s...\n' "$SOURCE_COMMIT"
if ! download_file \
	"$SNAPSHOT_RAW_URL/$SNAPSHOT_APK" \
	"$APK_PATH" \
	"$MAX_PACKAGE_BLOCKS"; then
	die "Could not download the current main APK."
fi
[ -s "$APK_PATH" ] ||
	die "The downloaded APK is empty."

MAIN_REF_PATH="$WORK_DIR/main-ref"
MAIN_REF_URL="$API_BASE_URL/commits/$MAIN_BRANCH"
if ! download_commit_sha "$MAIN_REF_URL" "$MAIN_REF_PATH"; then
	die "Could not resolve the current main branch."
fi
MAIN_COMMIT="$(read_commit_sha "$MAIN_REF_PATH")" ||
	die "GitHub returned an invalid main commit identifier."
[ "$SOURCE_COMMIT" = "$MAIN_COMMIT" ] ||
	die "The verified APK has not caught up with current main yet. Wait for the package checks and retry."

EXPECTED_SHA256=""
CHECKSUM_NAME=""
CHECKSUM_EXTRA=""
if ! IFS=' ' read -r EXPECTED_SHA256 CHECKSUM_NAME CHECKSUM_EXTRA < "$CHECKSUM_PATH"; then
	die "The APK checksum file is empty."
fi
[ "${#EXPECTED_SHA256}" -eq 64 ] ||
	die "The APK checksum has an invalid length."
case "$EXPECTED_SHA256" in
	*[!0-9a-f]*)
		die "The APK checksum is not lowercase hexadecimal."
		;;
esac
[ "$CHECKSUM_NAME" = "$SNAPSHOT_APK" ] ||
	die "The APK checksum names an unexpected file."
[ -z "$CHECKSUM_EXTRA" ] ||
	die "The APK checksum line has unexpected fields."

ACTUAL_SHA256="$(sha256sum "$APK_PATH")"
ACTUAL_SHA256="${ACTUAL_SHA256%% *}"
[ "$ACTUAL_SHA256" = "$EXPECTED_SHA256" ] ||
	die "The downloaded APK failed SHA-256 verification."

printf '%s\n' \
	"Verified source commit: $SOURCE_COMMIT" \
	"Verified APK SHA-256: $ACTUAL_SHA256"

if ! apk update; then
	warn "Could not refresh apk indexes; continuing with the current indexes."
fi

printf 'Installing %s with apk...\n' "$SNAPSHOT_APK"
if apk add --force-reinstall --help >/dev/null 2>&1; then
	apk add --allow-untrusted --force-reinstall "$APK_PATH"
else
	APK_INFO_STATUS="0"
	apk info -e luci-app-videoplayer >/dev/null 2>&1 ||
		APK_INFO_STATUS="$?"
	case "$APK_INFO_STATUS" in
		0)
			die \
				"This apk version cannot safely reinstall an existing snapshot. Upgrade OpenWrt or remove luci-app-videoplayer before retrying."
			;;
		1)
			apk add --allow-untrusted "$APK_PATH"
			;;
		*)
			die "Could not determine whether luci-app-videoplayer is already installed."
			;;
	esac
fi

printf '%s\n' \
	"Installation complete." \
	"Sign out of LuCI and sign in again if the menu item is not visible." \
	"Open LuCI -> Services -> Video Player."
