#!/bin/sh
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Install the APK built from the current main branch after its checks pass.

set -eu

REPOSITORY="communism420/luci-app-videoplayer"
MAIN_BRANCH="main"
SNAPSHOT_BRANCH="snapshot"
APP_VERSION="1.1.0"
SNAPSHOT_APK="luci-app-videoplayer-$APP_VERSION.apk"
SNAPSHOT_INDEX="INDEX.tsv"
API_BASE_URL="https://api.github.com/repos/$REPOSITORY"
RAW_BASE_URL="https://raw.githubusercontent.com/$REPOSITORY"

# POSIX ulimit -f counts 512-byte blocks.
MAX_METADATA_BLOCKS="128"
MAX_PACKAGE_BLOCKS="8192"
DOWNLOAD_TIMEOUT_SECONDS="30"
DOWNLOAD_DEADLINE_SECONDS="180"
HAS_WORKING_TIMEOUT="0"
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

detect_working_timeout() {
	HAS_WORKING_TIMEOUT="0"
	if command -v timeout >/dev/null 2>&1 &&
		timeout 1 /bin/sh -c ':' >/dev/null 2>&1; then
		HAS_WORKING_TIMEOUT="1"
	fi
}

run_with_download_deadline() {
	if [ "$HAS_WORKING_TIMEOUT" = "1" ]; then
		timeout "$DOWNLOAD_DEADLINE_SECONDS" "$@"
	else
		"$@"
	fi
}

check_download_size() {
	download_path="$1"
	max_blocks="$2"
	max_bytes=$((max_blocks * 512))
	download_size="$(wc -c < "$download_path" | tr -d '[:space:]')"

	case "$download_size" in
		''|*[!0-9]*)
			return 1
			;;
	esac
	[ "$download_size" -gt 0 ] &&
		[ "$download_size" -le "$max_bytes" ]
}

download_file() (
	url="$1"
	destination="$2"
	max_blocks="$3"

	if ! ulimit -f "$max_blocks"; then
		die "Could not set the download size limit."
	fi

	if command -v uclient-fetch >/dev/null 2>&1; then
		if ! run_with_download_deadline \
			uclient-fetch -T "$DOWNLOAD_TIMEOUT_SECONDS" \
			-O "$destination" "$url"; then
			exit 1
		fi
	elif command -v wget >/dev/null 2>&1; then
		if ! run_with_download_deadline \
			wget -T "$DOWNLOAD_TIMEOUT_SECONDS" \
			-O "$destination" "$url"; then
			exit 1
		fi
	elif command -v curl >/dev/null 2>&1; then
		if ! run_with_download_deadline \
			curl -fL --retry 2 --retry-delay 1 \
			--connect-timeout "$DOWNLOAD_TIMEOUT_SECONDS" \
			--max-time "$DOWNLOAD_DEADLINE_SECONDS" \
			--proto '=https' --proto-redir '=https' \
			-o "$destination" "$url"; then
			exit 1
		fi
	else
		die "No HTTPS downloader found (uclient-fetch, wget, or curl is required)."
	fi

	check_download_size "$destination" "$max_blocks"
)

download_commit_sha() (
	url="$1"
	destination="$2"

	if ! ulimit -f "$MAX_METADATA_BLOCKS"; then
		die "Could not set the metadata download size limit."
	fi

	if command -v uclient-fetch >/dev/null 2>&1; then
		if ! run_with_download_deadline \
			uclient-fetch \
			--header="Accept: application/vnd.github.sha" \
			-T "$DOWNLOAD_TIMEOUT_SECONDS" \
			-O "$destination" "$url"; then
			exit 1
		fi
	elif command -v wget >/dev/null 2>&1; then
		if ! run_with_download_deadline \
			wget \
			--header="Accept: application/vnd.github.sha" \
			-T "$DOWNLOAD_TIMEOUT_SECONDS" \
			-O "$destination" "$url"; then
			exit 1
		fi
	elif command -v curl >/dev/null 2>&1; then
		if ! run_with_download_deadline \
			curl -fL --retry 2 --retry-delay 1 \
			--connect-timeout "$DOWNLOAD_TIMEOUT_SECONDS" \
			--max-time "$DOWNLOAD_DEADLINE_SECONDS" \
			--proto '=https' --proto-redir '=https' \
			-H "Accept: application/vnd.github.sha" \
			-o "$destination" "$url"; then
			exit 1
		fi
	else
		die "No HTTPS downloader found (uclient-fetch, wget, or curl is required)."
	fi

	check_download_size "$destination" "$MAX_METADATA_BLOCKS"
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

# Keep all side effects behind the final entry-point call so the installer is
# inert until a complete script has been parsed.
main() {
case "$#" in
	0)
		;;
	1)
		case "$1" in
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
		;;
	*)
		die "This installer does not accept arguments."
		;;
esac

[ -r /etc/openwrt_release ] ||
	die "This installer must be run on OpenWrt."
command -v id >/dev/null 2>&1 ||
	die "The id command is required."
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
command -v wc >/dev/null 2>&1 ||
	die "The wc command is required."
detect_working_timeout

# shellcheck disable=SC1091
. /etc/openwrt_release
OPENWRT_RELEASE="${DISTRIB_RELEASE:-}"
OPENWRT_REVISION="${DISTRIB_REVISION:-}"
OPENWRT_ARCH="${DISTRIB_ARCH:-}"
[ "${DISTRIB_ID:-}" = "OpenWrt" ] ||
	die "This installer supports OpenWrt only."
for field in "$OPENWRT_RELEASE" "$OPENWRT_REVISION" "$OPENWRT_ARCH"; do
	case "$field" in
		""|*[!a-zA-Z0-9._+-]*)
			die "OpenWrt returned unsafe release or architecture metadata."
			;;
	esac
done

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
	die \
		"Could not resolve the published main APK snapshot. Check the downloader error above and GitHub HTTPS connectivity, then retry."
fi
SNAPSHOT_COMMIT="$(read_commit_sha "$SNAPSHOT_REF_PATH")" ||
	die "GitHub returned an invalid snapshot commit identifier."

SNAPSHOT_RAW_URL="$RAW_BASE_URL/$SNAPSHOT_COMMIT"
SOURCE_COMMIT_PATH="$WORK_DIR/SOURCE_COMMIT"
INDEX_PATH="$WORK_DIR/$SNAPSHOT_INDEX"
APK_PATH="$WORK_DIR/$SNAPSHOT_APK"

if ! download_file \
	"$SNAPSHOT_RAW_URL/dist/SOURCE_COMMIT" \
	"$SOURCE_COMMIT_PATH" \
	"$MAX_METADATA_BLOCKS"; then
	die "Could not download the snapshot source identifier."
fi
SOURCE_COMMIT="$(read_commit_sha "$SOURCE_COMMIT_PATH")" ||
	die "The snapshot contains an invalid source commit identifier."

if ! download_file \
	"$SNAPSHOT_RAW_URL/dist/$SNAPSHOT_INDEX" \
	"$INDEX_PATH" \
	"$MAX_METADATA_BLOCKS"; then
	die "Could not download the architecture package index."
fi

EXPECTED_SHA256=""
APP_RELATIVE_PATH=""
MATCH_COUNT="0"
while IFS='|' read -r \
	package_format release revision architecture \
	application_path application_sha256 \
	_codec_path _codec_sha256 extra
do
	case "$package_format" in
		\#*|"")
			continue
			;;
	esac
	[ -z "$extra" ] ||
		die "The architecture package index has unexpected fields."
	if [ "$package_format" = "apk" ] &&
		[ "$release" = "$OPENWRT_RELEASE" ] &&
		[ "$revision" = "$OPENWRT_REVISION" ] &&
		[ "$architecture" = "$OPENWRT_ARCH" ]; then
		MATCH_COUNT=$((MATCH_COUNT + 1))
		APP_RELATIVE_PATH="$application_path"
		EXPECTED_SHA256="$application_sha256"
	fi
done < "$INDEX_PATH"

[ "$MATCH_COUNT" -eq 1 ] ||
	die \
		"No unique current-main APK exists for OpenWrt $OPENWRT_RELEASE $OPENWRT_REVISION, architecture $OPENWRT_ARCH."
EXPECTED_RELATIVE_PATH="$OPENWRT_ARCH/openwrt-$OPENWRT_RELEASE-$OPENWRT_REVISION/$SNAPSHOT_APK"
[ "$APP_RELATIVE_PATH" = "$EXPECTED_RELATIVE_PATH" ] ||
	die "The architecture package index returned an unexpected APK path."
[ "${#EXPECTED_SHA256}" -eq 64 ] ||
	die "The APK checksum has an invalid length."
case "$EXPECTED_SHA256" in
	*[!0-9a-f]*)
		die "The APK checksum is not lowercase hexadecimal."
		;;
esac

printf 'Downloading the APK built from main commit %s...\n' "$SOURCE_COMMIT"
if ! download_file \
	"$SNAPSHOT_RAW_URL/dist/$APP_RELATIVE_PATH" \
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
}

main "$@"
