#!/bin/sh
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Install the APK built from the current main branch after its checks pass.

set -eu

REPOSITORY="communism420/luci-app-videoplayer"
MAIN_BRANCH="main"
SNAPSHOT_BRANCH="snapshot"
APP_VERSION="1.1.1"
SNAPSHOT_APK="luci-app-videoplayer-$APP_VERSION.apk"
SNAPSHOT_INDEX="INDEX.tsv"
CODEC_INSTALLER_OBJECT="scripts/install-codec-runtime.sh"
CODEC_INSTALLER_SHA256="a5f3b50310e7551958158fcc9b84d69c984e94194c7718321f6c01be21224dab"
API_BASE_URL="https://api.github.com/repos/$REPOSITORY"
RAW_BASE_URL="https://raw.githubusercontent.com/$REPOSITORY"

# POSIX ulimit -f counts 512-byte blocks.
MAX_METADATA_BLOCKS="128"
MAX_INSTALLER_BLOCKS="128"
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
			--header="Cache-Control: no-cache" \
			--header="Pragma: no-cache" \
			-T "$DOWNLOAD_TIMEOUT_SECONDS" \
			-O "$destination" "$url"; then
			exit 1
		fi
	elif command -v wget >/dev/null 2>&1; then
		if ! run_with_download_deadline \
			wget \
			--header="Accept: application/vnd.github.sha" \
			--header="Cache-Control: no-cache" \
			--header="Pragma: no-cache" \
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
			-H "Cache-Control: no-cache" \
			-H "Pragma: no-cache" \
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

verify_sha256() {
	expected_sha256="$1"
	verified_path="$2"
	description="$3"
	actual_sha256="$(sha256sum "$verified_path")"
	actual_sha256="${actual_sha256%% *}"

	[ "$actual_sha256" = "$expected_sha256" ] ||
		die "The downloaded $description failed SHA-256 verification."
}

read_release_value() {
	release_key="$1"
	release_file="${2:-/etc/openwrt_release}"
	sed -n "s/^${release_key}='\([^']*\)'$/\1/p" "$release_file"
}

read_apk_architecture_file() {
	apk_architecture_path="$1"
	[ -r "$apk_architecture_path" ] || return 1

	while IFS= read -r apk_architecture_line ||
		[ -n "$apk_architecture_line" ]; do
		apk_architecture_line="$(
			printf '%s\n' "$apk_architecture_line" |
				sed 's/^[[:space:]]*//; s/[[:space:]]*$//'
		)"
		[ -n "$apk_architecture_line" ] || continue
		printf '%s\n' "$apk_architecture_line"
		return 0
	done < "$apk_architecture_path"
	return 1
}

verify_apk_architecture() {
	wanted_architecture="$1"
	apk_arch_file="${2:-/etc/apk/arch}"
	native_architecture="$(read_apk_architecture_file "$apk_arch_file")" ||
		die "Could not read the APK package architecture from $apk_arch_file."
	[ "$native_architecture" = "$wanted_architecture" ] ||
		die "OpenWrt architecture metadata '$wanted_architecture' does not match the APK package architecture '$native_architecture'."
}

require_supported_apk_platform() {
	if [ "$1" = "25.12.5" ] && [ "$2" = "r33051-f5dae5ece4" ]; then
		return 0
	fi
	die "No current-main APK is published for OpenWrt $1 $2."
}

require_current_snapshot() {
	[ "$1" = "$2" ] ||
		die "The verified APK does not match current main. Wait for the package checks and retry."
}

select_apk_install_mode() {
	if apk add --force-reinstall --help >/dev/null 2>&1; then
		printf '%s\n' "force"
		return 0
	fi

	apk_info_status="0"
	apk info -e luci-app-videoplayer >/dev/null 2>&1 ||
		apk_info_status="$?"
	case "$apk_info_status" in
		0)
			die \
				"This apk version cannot safely reinstall an existing snapshot. Upgrade OpenWrt or remove luci-app-videoplayer before retrying."
			;;
		1)
			printf '%s\n' "plain"
			;;
		*)
			die "Could not determine whether luci-app-videoplayer is already installed."
			;;
	esac
}

install_apk_package() {
	case "$1" in
		force)
			apk add --allow-untrusted --force-reinstall "$2"
			;;
		plain)
			apk add --allow-untrusted "$2"
			;;
		*)
			die "Internal error: unknown apk installation mode."
			;;
	esac
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
					"Downloads and verifies the required files, installs the APK built from the" \
					"current main branch first, then installs or updates its matching private FFmpeg runtime." \
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
command -v sed >/dev/null 2>&1 ||
	die "The sed command is required."
command -v tr >/dev/null 2>&1 ||
	die "The tr command is required."
command -v wc >/dev/null 2>&1 ||
	die "The wc command is required."
detect_working_timeout

OPENWRT_ID="$(read_release_value DISTRIB_ID)"
OPENWRT_RELEASE="$(read_release_value DISTRIB_RELEASE)"
OPENWRT_REVISION="$(read_release_value DISTRIB_REVISION)"
OPENWRT_ARCH="$(read_release_value DISTRIB_ARCH)"
[ "$OPENWRT_ID" = "OpenWrt" ] ||
	die "This installer supports OpenWrt only."
for field in "$OPENWRT_RELEASE" "$OPENWRT_REVISION" "$OPENWRT_ARCH"; do
	case "$field" in
		""|*[!a-zA-Z0-9._+-]*)
			die "OpenWrt returned unsafe release or architecture metadata."
			;;
	esac
done
verify_apk_architecture "$OPENWRT_ARCH"
require_supported_apk_platform "$OPENWRT_RELEASE" "$OPENWRT_REVISION"

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
require_current_snapshot "$SOURCE_COMMIT" "$MAIN_COMMIT"

ACTUAL_SHA256="$(sha256sum "$APK_PATH")"
ACTUAL_SHA256="${ACTUAL_SHA256%% *}"
[ "$ACTUAL_SHA256" = "$EXPECTED_SHA256" ] ||
	die "The downloaded APK failed SHA-256 verification."

printf '%s\n' \
	"Verified source commit: $SOURCE_COMMIT" \
	"Verified APK SHA-256: $ACTUAL_SHA256"

CODEC_INSTALLER_PATH="$WORK_DIR/install-codec-runtime.sh"
CODEC_INSTALLER_URL="$RAW_BASE_URL/$MAIN_COMMIT/$CODEC_INSTALLER_OBJECT"
printf '%s\n' \
	"Downloading the architecture-specific FFmpeg installer..."
if ! download_file \
	"$CODEC_INSTALLER_URL" \
	"$CODEC_INSTALLER_PATH" \
	"$MAX_INSTALLER_BLOCKS"; then
	die "Could not download the architecture-specific FFmpeg installer."
fi
verify_sha256 \
	"$CODEC_INSTALLER_SHA256" \
	"$CODEC_INSTALLER_PATH" \
	"FFmpeg installer"

if ! apk update; then
	warn "Could not refresh apk indexes; continuing with the current indexes."
fi

APK_INSTALL_MODE="$(select_apk_install_mode)"

FINAL_MAIN_REF_PATH="$WORK_DIR/main-ref-final"
printf 'Rechecking current main immediately before application installation...\n'
if ! download_commit_sha "$MAIN_REF_URL" "$FINAL_MAIN_REF_PATH"; then
	die "Could not recheck the current main branch before application installation."
fi
FINAL_MAIN_COMMIT="$(read_commit_sha "$FINAL_MAIN_REF_PATH")" ||
	die "GitHub returned an invalid final main commit identifier."
require_current_snapshot "$SOURCE_COMMIT" "$FINAL_MAIN_COMMIT"

printf 'Installing %s with apk...\n' "$SNAPSHOT_APK"
install_apk_package "$APK_INSTALL_MODE" "$APK_PATH"

printf '%s\n' \
	"Installing or updating the architecture-specific FFmpeg runtime after the strict application maintenance helper..."
if ! /bin/sh "$CODEC_INSTALLER_PATH"; then
	die "The application was updated, but the architecture-specific FFmpeg installation or update failed. Browser mode remains available; retry this installer before using strict Router mode."
fi

printf '%s\n' \
	"Installation complete." \
	"Sign out of LuCI and sign in again if the menu item is not visible." \
	"Open LuCI -> Services -> Video Player."
}

main "$@"
