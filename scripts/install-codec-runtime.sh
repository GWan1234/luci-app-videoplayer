#!/bin/sh
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Install the private FFmpeg codec runtime published to the generated
# codec-snapshot branch. This installer intentionally supports exactly one
# OpenWrt release/target/architecture tuple.

set -eu

REPOSITORY="communism420/luci-app-videoplayer"
SNAPSHOT_BRANCH="codec-snapshot"
API_BASE_URL="https://api.github.com/repos/$REPOSITORY"
RAW_BASE_URL="https://raw.githubusercontent.com/$REPOSITORY"

REQUIRED_RELEASE="25.12.5"
REQUIRED_REVISION="r33051-f5dae5ece4"
REQUIRED_TARGET="mediatek/filogic"
REQUIRED_DISTRIB_ARCH="aarch64_cortex-a53"
REQUIRED_DISTRIB_ID="OpenWrt"
REQUIRED_MACHINE_ARCH="aarch64"
REQUIRED_APK_ARCH="aarch64"

PACKAGE_NAME="luci-videoplayer-codec-runtime"
PACKAGE_FILE="luci-videoplayer-codec-runtime-6.1.4-r1.apk"
ARTIFACT_DIRECTORY="targets/openwrt-25.12.5-r33051-f5dae5ece4/mediatek-filogic/aarch64_cortex-a53"
ARTIFACT_PATH="$ARTIFACT_DIRECTORY/$PACKAGE_FILE"
CHECKSUM_OBJECT="$ARTIFACT_PATH.sha256"
SOURCE_COMMIT_OBJECT="SOURCE_COMMIT"
PRIVATE_FFMPEG="/usr/libexec/videoplayer-ffmpeg/ffmpeg"

# POSIX ulimit -f counts 512-byte blocks.
MAX_METADATA_BLOCKS="64"
MAX_PACKAGE_BLOCKS="131072"
MAX_REPORT_BLOCKS="512"
DOWNLOAD_TIMEOUT_SECONDS="30"
DOWNLOAD_DEADLINE_SECONDS="180"
FFMPEG_PROBE_DEADLINE_SECONDS="30"
WORK_DIR=""

die() {
	printf 'Error: %s\n' "$*" >&2
	exit 1
}

cleanup() {
	[ -n "$WORK_DIR" ] || return 0
	case "$WORK_DIR" in
		/tmp/videoplayer-codec-runtime.*)
			rm -rf -- "$WORK_DIR"
			;;
	esac
}

read_release_value() {
	release_key="$1"
	sed -n "s/^${release_key}='\([^']*\)'$/\1/p" /etc/openwrt_release
}

require_exact_value() {
	value_label="$1"
	actual_value="$2"
	required_value="$3"

	[ "$actual_value" = "$required_value" ] ||
		die "Unsupported $value_label '$actual_value'; required '$required_value'."
}

run_with_download_deadline() {
	timeout "$DOWNLOAD_DEADLINE_SECONDS" "$@"
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
		printf 'Error: could not set the download size limit.\n' >&2
		exit 1
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
		printf '%s\n' \
			'Error: no HTTPS downloader found (uclient-fetch, wget, or curl is required).' >&2
		exit 1
	fi

	check_download_size "$destination" "$max_blocks"
)

download_commit_sha() (
	url="$1"
	destination="$2"

	if ! ulimit -f "$MAX_METADATA_BLOCKS"; then
		printf 'Error: could not set the metadata download size limit.\n' >&2
		exit 1
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
		printf '%s\n' \
			'Error: no HTTPS downloader found (uclient-fetch, wget, or curl is required).' >&2
		exit 1
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

run_ffmpeg_report() (
	report_option="$1"
	report_output="$2"
	report_error="$3"

	if ! ulimit -f "$MAX_REPORT_BLOCKS"; then
		exit 1
	fi

	timeout "$FFMPEG_PROBE_DEADLINE_SECONDS" \
		"$PRIVATE_FFMPEG" -hide_banner "$report_option" \
		>"$report_output" 2>"$report_error"
)

check_component() {
	component_report="$1"
	component_pattern="$2"
	component_description="$3"

	if grep -Eq "$component_pattern" "$component_report"; then
		return 0
	fi

	printf 'Error: private FFmpeg does not report %s.\n' \
		"$component_description" >&2
	return 1
}

case "${1:-}" in
	"")
		;;
	-h|--help)
		printf '%s\n' \
			"Usage: sh install-codec-runtime.sh" \
			"" \
			"Downloads, verifies, and installs the private FFmpeg codec runtime." \
			"Supported system only:" \
			"  OpenWrt $REQUIRED_RELEASE $REQUIRED_REVISION" \
			"  target $REQUIRED_TARGET, package architecture $REQUIRED_DISTRIB_ARCH" \
			"  machine and apk architecture $REQUIRED_MACHINE_ARCH"
		exit 0
		;;
	*)
		die "This installer does not accept arguments."
		;;
esac

[ -r /etc/openwrt_release ] ||
	die "This installer must be run on OpenWrt."
command -v id >/dev/null 2>&1 ||
	die "Required command is missing: id"
[ "$(id -u)" = "0" ] ||
	die "Run this installer as root."

for required_command in apk grep mktemp sed sha256sum timeout tr uname wc; do
	command -v "$required_command" >/dev/null 2>&1 ||
		die "Required command is missing: $required_command"
done
if command -v opkg >/dev/null 2>&1; then
	die "Both apk and opkg were found; package manager selection is ambiguous."
fi
if ! command -v uclient-fetch >/dev/null 2>&1 &&
	! command -v wget >/dev/null 2>&1 &&
	! command -v curl >/dev/null 2>&1; then
	die "No HTTPS downloader found (uclient-fetch, wget, or curl is required)."
fi

DISTRIB_RELEASE_VALUE="$(read_release_value DISTRIB_RELEASE)"
DISTRIB_REVISION_VALUE="$(read_release_value DISTRIB_REVISION)"
DISTRIB_TARGET_VALUE="$(read_release_value DISTRIB_TARGET)"
DISTRIB_ARCH_VALUE="$(read_release_value DISTRIB_ARCH)"
DISTRIB_ID_VALUE="$(read_release_value DISTRIB_ID)"

require_exact_value "distribution" \
	"$DISTRIB_ID_VALUE" "$REQUIRED_DISTRIB_ID"
require_exact_value "OpenWrt release" \
	"$DISTRIB_RELEASE_VALUE" "$REQUIRED_RELEASE"
require_exact_value "OpenWrt revision" \
	"$DISTRIB_REVISION_VALUE" "$REQUIRED_REVISION"
require_exact_value "OpenWrt target" \
	"$DISTRIB_TARGET_VALUE" "$REQUIRED_TARGET"
require_exact_value "OpenWrt package architecture" \
	"$DISTRIB_ARCH_VALUE" "$REQUIRED_DISTRIB_ARCH"

if ! MACHINE_ARCH="$(uname -m 2>/dev/null)"; then
	die "Could not determine the machine architecture."
fi
require_exact_value "machine architecture" \
	"$MACHINE_ARCH" "$REQUIRED_MACHINE_ARCH"

if ! APK_ARCH="$(apk --print-arch 2>/dev/null)"; then
	die "Could not determine the apk architecture."
fi
require_exact_value "apk architecture" \
	"$APK_ARCH" "$REQUIRED_APK_ARCH"

umask 077
WORK_DIR="$(mktemp -d /tmp/videoplayer-codec-runtime.XXXXXX)" ||
	die "Could not create a temporary directory."
trap cleanup 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

SNAPSHOT_REF_PATH="$WORK_DIR/codec-snapshot-ref"
SNAPSHOT_REF_URL="$API_BASE_URL/commits/$SNAPSHOT_BRANCH"
printf 'Resolving the published codec snapshot...\n'
if ! download_commit_sha "$SNAPSHOT_REF_URL" "$SNAPSHOT_REF_PATH"; then
	die "No published codec snapshot was found. Wait for its GitHub build and retry."
fi
SNAPSHOT_COMMIT="$(read_commit_sha "$SNAPSHOT_REF_PATH")" ||
	die "GitHub returned an invalid codec snapshot commit identifier."

SNAPSHOT_RAW_URL="$RAW_BASE_URL/$SNAPSHOT_COMMIT"
SOURCE_COMMIT_PATH="$WORK_DIR/SOURCE_COMMIT"
CHECKSUM_PATH="$WORK_DIR/$PACKAGE_FILE.sha256"
PACKAGE_PATH="$WORK_DIR/$PACKAGE_FILE"

if ! download_file \
	"$SNAPSHOT_RAW_URL/$SOURCE_COMMIT_OBJECT" \
	"$SOURCE_COMMIT_PATH" \
	"$MAX_METADATA_BLOCKS"; then
	die "Could not download the codec snapshot source identifier."
fi
SOURCE_COMMIT="$(read_commit_sha "$SOURCE_COMMIT_PATH")" ||
	die "The codec snapshot contains an invalid source commit identifier."

if ! download_file \
	"$SNAPSHOT_RAW_URL/$CHECKSUM_OBJECT" \
	"$CHECKSUM_PATH" \
	"$MAX_METADATA_BLOCKS"; then
	die "Could not download the codec package checksum."
fi

EXPECTED_SHA256=""
CHECKSUM_NAME=""
CHECKSUM_EXTRA=""
if ! IFS=' ' read -r EXPECTED_SHA256 CHECKSUM_NAME CHECKSUM_EXTRA \
	< "$CHECKSUM_PATH"; then
	die "The codec package checksum file is empty."
fi
[ "${#EXPECTED_SHA256}" -eq 64 ] ||
	die "The codec package checksum has an invalid length."
case "$EXPECTED_SHA256" in
	*[!0-9a-f]*)
		die "The codec package checksum is not lowercase hexadecimal."
		;;
esac
case "$CHECKSUM_NAME" in
	\*)
		CHECKSUM_NAME="${CHECKSUM_NAME#\*}"
		;;
esac
case "$CHECKSUM_NAME" in
	"$PACKAGE_FILE"|"./$PACKAGE_FILE"|"$ARTIFACT_PATH")
		;;
	*)
		die "The codec package checksum names an unexpected file."
		;;
esac
[ -z "$CHECKSUM_EXTRA" ] ||
	die "The codec package checksum line has unexpected fields."
CHECKSUM_TRAILING="$(
	sed -n '2,$p' "$CHECKSUM_PATH" | tr -d '[:space:]'
)"
[ -z "$CHECKSUM_TRAILING" ] ||
	die "The codec package checksum file has unexpected extra lines."

printf 'Downloading codecs built from source commit %s...\n' "$SOURCE_COMMIT"
if ! download_file \
	"$SNAPSHOT_RAW_URL/$ARTIFACT_PATH" \
	"$PACKAGE_PATH" \
	"$MAX_PACKAGE_BLOCKS"; then
	die "Could not download the codec package."
fi

ACTUAL_SHA256="$(sha256sum "$PACKAGE_PATH")"
ACTUAL_SHA256="${ACTUAL_SHA256%% *}"
[ "$ACTUAL_SHA256" = "$EXPECTED_SHA256" ] ||
	die "The downloaded codec package failed SHA-256 verification."

printf '%s\n' \
	"Verified snapshot commit: $SNAPSHOT_COMMIT" \
	"Verified source commit: $SOURCE_COMMIT" \
	"Verified codec package SHA-256: $ACTUAL_SHA256"

PACKAGE_PRESENT="0"
if apk info -e "$PACKAGE_NAME" >/dev/null 2>&1; then
	PACKAGE_PRESENT="1"
else
	APK_INFO_STATUS="$?"
	case "$APK_INFO_STATUS" in
		1)
			;;
		*)
			die "Could not determine whether $PACKAGE_NAME is already installed."
			;;
	esac
fi

printf 'Installing %s with apk...\n' "$PACKAGE_FILE"
if [ "$PACKAGE_PRESENT" = "1" ]; then
	if apk add --force-reinstall --help >/dev/null 2>&1; then
		apk add --allow-untrusted --force-reinstall "$PACKAGE_PATH"
	else
		die "This apk version cannot safely reinstall $PACKAGE_NAME; no files were removed."
	fi
else
	apk add --allow-untrusted "$PACKAGE_PATH"
fi

apk info -e "$PACKAGE_NAME" >/dev/null 2>&1 ||
	die "apk completed without registering $PACKAGE_NAME."
[ -x "$PRIVATE_FFMPEG" ] ||
	die "The installed private FFmpeg is missing or not executable: $PRIVATE_FFMPEG"

DECODERS_REPORT="$WORK_DIR/ffmpeg-decoders"
ENCODERS_REPORT="$WORK_DIR/ffmpeg-encoders"
MUXERS_REPORT="$WORK_DIR/ffmpeg-muxers"
FILTERS_REPORT="$WORK_DIR/ffmpeg-filters"
FFMPEG_ERROR="$WORK_DIR/ffmpeg-error"

if ! run_ffmpeg_report -decoders "$DECODERS_REPORT" "$FFMPEG_ERROR"; then
	[ ! -s "$FFMPEG_ERROR" ] ||
		sed -n '1,8p' "$FFMPEG_ERROR" >&2
	die "The installed private FFmpeg could not report its decoders."
fi
if ! run_ffmpeg_report -encoders "$ENCODERS_REPORT" "$FFMPEG_ERROR"; then
	[ ! -s "$FFMPEG_ERROR" ] ||
		sed -n '1,8p' "$FFMPEG_ERROR" >&2
	die "The installed private FFmpeg could not report its encoders."
fi
if ! run_ffmpeg_report -muxers "$MUXERS_REPORT" "$FFMPEG_ERROR"; then
	[ ! -s "$FFMPEG_ERROR" ] ||
		sed -n '1,8p' "$FFMPEG_ERROR" >&2
	die "The installed private FFmpeg could not report its muxers."
fi
if ! run_ffmpeg_report -filters "$FILTERS_REPORT" "$FFMPEG_ERROR"; then
	[ ! -s "$FFMPEG_ERROR" ] ||
		sed -n '1,8p' "$FFMPEG_ERROR" >&2
	die "The installed private FFmpeg could not report its filters."
fi

COMPONENTS_OK="1"
check_component "$DECODERS_REPORT" \
	'^[[:space:]]*V[^[:space:]]*[[:space:]]+h264([[:space:]]|$)' \
	"the native h264 video decoder" ||
	COMPONENTS_OK="0"
check_component "$DECODERS_REPORT" \
	'^[[:space:]]*V[^[:space:]]*[[:space:]]+hevc([[:space:]]|$)' \
	"the native hevc video decoder" ||
	COMPONENTS_OK="0"
check_component "$DECODERS_REPORT" \
	'^[[:space:]]*V[^[:space:]]*[[:space:]]+vc1([[:space:]]|$)' \
	"the native vc1 video decoder" ||
	COMPONENTS_OK="0"
check_component "$ENCODERS_REPORT" \
	'^[[:space:]]*V[^[:space:]]*[[:space:]]+mjpeg([[:space:]]|$)' \
	"the mjpeg video encoder" ||
	COMPONENTS_OK="0"
check_component "$MUXERS_REPORT" \
	'^[[:space:]]*E[[:space:]]+image2([[:space:]]|$)' \
	"the image2 muxer" ||
	COMPONENTS_OK="0"
check_component "$FILTERS_REPORT" \
	'^[[:space:]]*[^[:space:]]+[[:space:]]+fps[[:space:]]' \
	"the fps video filter" ||
	COMPONENTS_OK="0"
check_component "$FILTERS_REPORT" \
	'^[[:space:]]*[^[:space:]]+[[:space:]]+scale[[:space:]]' \
	"the scale video filter" ||
	COMPONENTS_OK="0"
check_component "$FILTERS_REPORT" \
	'^[[:space:]]*[^[:space:]]+[[:space:]]+format[[:space:]]' \
	"the format video filter" ||
	COMPONENTS_OK="0"
[ "$COMPONENTS_OK" = "1" ] ||
	die "The installed private FFmpeg is incomplete."

printf '%s\n' \
	"Codec runtime installation complete." \
	"Verified private FFmpeg: $PRIVATE_FFMPEG" \
	"Verified decoders: h264, hevc, vc1" \
	"Verified renderer pipeline: mjpeg, image2, fps, scale, format"
