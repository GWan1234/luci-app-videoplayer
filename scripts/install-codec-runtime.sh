#!/bin/sh
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Select, verify, and install the private FFmpeg runtime for the router's exact
# OpenWrt release, revision, package manager, and DISTRIB_ARCH value.

set -eu

REPOSITORY="communism420/luci-app-videoplayer"
SNAPSHOT_BRANCH="codec-snapshot"
API_BASE_URL="https://api.github.com/repos/$REPOSITORY"
RAW_BASE_URL="https://raw.githubusercontent.com/$REPOSITORY"

PACKAGE_NAME="luci-videoplayer-codec-runtime"
CODEC_VERSION="6.1.4"
CODEC_RELEASE="5"
TARGET_PACKAGE_VERSION="$CODEC_VERSION-r$CODEC_RELEASE"
RENDERER_PROFILE="software-cpu-v1"
EXECUTION_BACKEND="software-cpu-v1"
SOFTWARE_CPU_ONLY="1"
BUILD_INFO_FORMAT="4"
BUILD_INFO_LINES="24"
INDEX_OBJECT="dist/INDEX.tsv"
SOURCE_COMMIT_OBJECT="dist/SOURCE_COMMIT"
PRIVATE_FFMPEG="/usr/libexec/videoplayer-ffmpeg/ffmpeg"
PRIVATE_RELAY="/usr/libexec/videoplayer-ffmpeg/videoplayer-mjpeg-relay"
PRIVATE_BUILD_INFO="/usr/share/luci-videoplayer-codec-runtime/build-info"

# POSIX ulimit -f counts 512-byte blocks.
MAX_METADATA_BLOCKS="256"
MAX_PACKAGE_BLOCKS="131072"
MAX_REPORT_BLOCKS="512"
DOWNLOAD_TIMEOUT_SECONDS="30"
DOWNLOAD_DEADLINE_SECONDS="180"
FFMPEG_PROBE_DEADLINE_SECONDS="30"
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
		/tmp/videoplayer-codec-runtime.*)
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

read_release_value() {
	release_key="$1"
	sed -n "s/^${release_key}='\([^']*\)'$/\1/p" /etc/openwrt_release
}

installed_runtime_matches_router() {
	build_info="$PRIVATE_BUILD_INFO"
	[ -f "$build_info" ] &&
		[ ! -L "$build_info" ] &&
		[ -r "$build_info" ] &&
		[ "$(stat -c '%u:%a' "$build_info" 2>/dev/null)" = "0:644" ] &&
		[ -f "$PRIVATE_FFMPEG" ] &&
		[ ! -L "$PRIVATE_FFMPEG" ] &&
		[ -x "$PRIVATE_FFMPEG" ] &&
		[ "$(stat -c '%u:%a' "$PRIVATE_FFMPEG" 2>/dev/null)" = "0:755" ] &&
		[ -f "$PRIVATE_RELAY" ] &&
		[ ! -L "$PRIVATE_RELAY" ] &&
		[ -x "$PRIVATE_RELAY" ] &&
		[ "$(stat -c '%u:%a' "$PRIVATE_RELAY" 2>/dev/null)" = "0:755" ] &&
		[ "$(wc -l < "$build_info" | tr -d '[:space:]')" = \
			"$BUILD_INFO_LINES" ] &&
		[ "$(sed -n 's/^format=//p' "$build_info")" = \
			"$BUILD_INFO_FORMAT" ] &&
		[ "$(sed -n 's/^openwrt_release=//p' "$build_info")" = \
			"$DISTRIB_RELEASE_VALUE" ] &&
		[ "$(sed -n 's/^openwrt_revision=//p' "$build_info")" = \
			"$DISTRIB_REVISION_VALUE" ] &&
		[ "$(sed -n 's/^compatible_arch=//p' "$build_info")" = \
			"$DISTRIB_ARCH_VALUE" ] &&
		[ "$(sed -n 's/^package_format=//p' "$build_info")" = \
			"$PACKAGE_FORMAT" ] &&
		[ -n "$(sed -n 's/^build_target=//p' "$build_info")" ] &&
		[ -n "$(sed -n 's/^build_subtarget=//p' "$build_info")" ] &&
		printf '%s\n' "$(sed -n 's/^sdk_sha256=//p' "$build_info")" |
			grep -Eq '^[0-9a-f]{64}$' &&
		printf '%s\n' "$(sed -n 's/^packages_feed_commit=//p' "$build_info")" |
			grep -Eq '^[0-9a-f]{40}$' &&
		[ "$(sed -n 's/^ffmpeg_version=//p' "$build_info")" = \
			"$CODEC_VERSION" ] &&
		case "$(sed -n 's/^validation_mode=//p' "$build_info")" in
			qemu|static) true ;;
			*) false ;;
		esac &&
		[ "$(sed -n 's/^renderer_profile=//p' "$build_info")" = \
			"$RENDERER_PROFILE" ] &&
		[ "$(sed -n 's/^execution_backend=//p' "$build_info")" = \
			"$EXECUTION_BACKEND" ] &&
		[ "$(sed -n 's/^software_cpu_only=//p' "$build_info")" = \
			"$SOFTWARE_CPU_ONLY" ] &&
		[ "$(sed -n 's/^build_patented=//p' "$build_info")" = "y" ] &&
		[ "$(sed -n 's/^network_enabled=//p' "$build_info")" = "n" ] &&
		[ "$(sed -n 's/^avdevice_enabled=//p' "$build_info")" = "n" ] &&
		[ "$(sed -n 's/^swresample_enabled=//p' "$build_info")" = "y" ] &&
		[ "$(sed -n 's/^audio_output=//p' "$build_info")" = "pcm_s16le" ] &&
		[ "$(sed -n 's/^audio_sample_rate=//p' "$build_info")" = "48000" ] &&
		[ "$(sed -n 's/^audio_channels=//p' "$build_info")" = "2" ] &&
		[ "$(sed -n 's/^audio_chunk_frames=//p' "$build_info")" = "48000" ] &&
		[ "$(sed -n 's/^audio_chunk_bytes=//p' "$build_info")" = "192000" ] &&
		[ "$(sed -n 's/^private_binary=//p' "$build_info")" = \
			"$PRIVATE_FFMPEG" ]
}

select_runtime_action() {
	version_order="$1"
	metadata_matches="$2"

	case "$version_order:$metadata_matches" in
		"<:0"|"<:1")
			printf '%s\n' "upgrade"
			;;
		"=:1")
			printf '%s\n' "current"
			;;
		"=:0")
			printf '%s\n' "repair"
			;;
		">:1")
			printf '%s\n' "newer"
			;;
		">:0")
			return 1
			;;
		*)
			return 2
			;;
	esac
}

require_safe_component() {
	value_label="$1"
	value="$2"
	case "$value" in
		""|"."|".."|*".."*|*[!a-zA-Z0-9._+-]*)
			die "OpenWrt returned an unsafe $value_label value."
			;;
	esac
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
	if [ "$HAS_WORKING_TIMEOUT" = "1" ]; then
		timeout "$FFMPEG_PROBE_DEADLINE_SECONDS" \
			"$PRIVATE_FFMPEG" -hide_banner "$report_option" \
			>"$report_output" 2>"$report_error"
	else
		"$PRIVATE_FFMPEG" -hide_banner "$report_option" \
			>"$report_output" 2>"$report_error"
	fi
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

# CODEC_REPORT_ALLOWLIST_BEGIN
unexpected_codec_aliases() (
	component_report="$1"
	allowed_names="$2"
	awk -v allowed_names="$allowed_names" '
		BEGIN {
			count = split(allowed_names, names, " ")
			for (i = 1; i <= count; i++)
				allowed[names[i]] = 1
		}
		$2 == "=" { next }
		length($1) == 6 && substr($1, 1, 1) ~ /^[VAS]$/ {
			if ($2 !~ /^[a-z0-9_]+(,[a-z0-9_]+)*$/) {
				invalid_alias = 1
				next
			}
			count = split($2, aliases, ",")
			for (i = 1; i <= count; i++)
				if (!allowed[aliases[i]])
					unexpected = unexpected \
						(unexpected ? "," : "") aliases[i]
		}
		END {
			if (invalid_alias)
				unexpected = unexpected \
					(unexpected ? "," : "") "__invalid_component_alias__"
			print unexpected
		}
	' "$component_report"
)
# CODEC_REPORT_ALLOWLIST_END

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
					"Usage: sh install-codec-runtime.sh" \
					"" \
					"Installs or updates the architecture-specific private FFmpeg runtime." \
					"Supported package sets are selected from the generated matrix for:" \
					"  OpenWrt 25.12.5 r33051-f5dae5ece4 (apk)" \
					"  OpenWrt 24.10.8 r29233-443ec4032a (opkg)"
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
	die "Required command is missing: id"
[ "$(id -u)" = "0" ] ||
	die "Run this installer as root."

for required_command in awk grep mktemp sed sha256sum stat tr wc; do
	command -v "$required_command" >/dev/null 2>&1 ||
		die "Required command is missing: $required_command"
done
detect_working_timeout
if [ "$HAS_WORKING_TIMEOUT" != "1" ]; then
	warn \
		"A working timeout command is unavailable; bounded file-size checks remain active, but network and FFmpeg probe deadlines cannot be enforced."
fi
if ! command -v uclient-fetch >/dev/null 2>&1 &&
	! command -v wget >/dev/null 2>&1 &&
	! command -v curl >/dev/null 2>&1; then
	die "No HTTPS downloader found (uclient-fetch, wget, or curl is required)."
fi

HAS_APK="0"
HAS_OPKG="0"
command -v apk >/dev/null 2>&1 && HAS_APK="1"
command -v opkg >/dev/null 2>&1 && HAS_OPKG="1"
if [ "$HAS_APK" = "$HAS_OPKG" ]; then
	if [ "$HAS_APK" = "1" ]; then
		die "Both apk and opkg were found; package manager selection is ambiguous."
	fi
	die "Neither apk nor opkg is installed."
fi
if [ "$HAS_APK" = "1" ]; then
	PACKAGE_FORMAT="apk"
	PACKAGE_FILE="$PACKAGE_NAME-$CODEC_VERSION-r$CODEC_RELEASE.apk"
else
	PACKAGE_FORMAT="ipk"
fi

DISTRIB_ID_VALUE="$(read_release_value DISTRIB_ID)"
DISTRIB_RELEASE_VALUE="$(read_release_value DISTRIB_RELEASE)"
DISTRIB_REVISION_VALUE="$(read_release_value DISTRIB_REVISION)"
DISTRIB_ARCH_VALUE="$(read_release_value DISTRIB_ARCH)"
[ "$DISTRIB_ID_VALUE" = "OpenWrt" ] ||
	die "Unsupported distribution '$DISTRIB_ID_VALUE'; required 'OpenWrt'."
require_safe_component "release" "$DISTRIB_RELEASE_VALUE"
require_safe_component "revision" "$DISTRIB_REVISION_VALUE"
require_safe_component "package architecture" "$DISTRIB_ARCH_VALUE"
if [ "$PACKAGE_FORMAT" = "ipk" ]; then
	PACKAGE_FILE="${PACKAGE_NAME}_${CODEC_VERSION}-r${CODEC_RELEASE}_${DISTRIB_ARCH_VALUE}.ipk"
fi

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
	die \
		"Could not resolve the published codec snapshot. Check the downloader error above and GitHub HTTPS connectivity, then retry."
fi
SNAPSHOT_COMMIT="$(read_commit_sha "$SNAPSHOT_REF_PATH")" ||
	die "GitHub returned an invalid codec snapshot commit identifier."

SNAPSHOT_RAW_URL="$RAW_BASE_URL/$SNAPSHOT_COMMIT"
SOURCE_COMMIT_PATH="$WORK_DIR/SOURCE_COMMIT"
INDEX_PATH="$WORK_DIR/INDEX.tsv"
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
	"$SNAPSHOT_RAW_URL/$INDEX_OBJECT" \
	"$INDEX_PATH" \
	"$MAX_METADATA_BLOCKS"; then
	die "Could not download the architecture package index."
fi

MATCH_COUNT="0"
CODEC_RELATIVE_PATH=""
EXPECTED_SHA256=""
while IFS='|' read -r \
	index_format index_release index_revision index_architecture \
	_application_path _application_sha256 codec_path codec_sha256 extra
do
	case "$index_format" in
		\#*|"")
			continue
			;;
	esac
	[ -z "$extra" ] ||
		die "The architecture package index has unexpected fields."
	if [ "$index_format" = "$PACKAGE_FORMAT" ] &&
		[ "$index_release" = "$DISTRIB_RELEASE_VALUE" ] &&
		[ "$index_revision" = "$DISTRIB_REVISION_VALUE" ] &&
		[ "$index_architecture" = "$DISTRIB_ARCH_VALUE" ]; then
		MATCH_COUNT=$((MATCH_COUNT + 1))
		CODEC_RELATIVE_PATH="$codec_path"
		EXPECTED_SHA256="$codec_sha256"
	fi
done < "$INDEX_PATH"

[ "$MATCH_COUNT" -eq 1 ] ||
	die \
		"No unique codec package exists for OpenWrt $DISTRIB_RELEASE_VALUE $DISTRIB_REVISION_VALUE, architecture $DISTRIB_ARCH_VALUE, format $PACKAGE_FORMAT."
EXPECTED_RELATIVE_PATH="$DISTRIB_ARCH_VALUE/openwrt-$DISTRIB_RELEASE_VALUE-$DISTRIB_REVISION_VALUE/$PACKAGE_FILE"
[ "$CODEC_RELATIVE_PATH" = "$EXPECTED_RELATIVE_PATH" ] ||
	die "The architecture package index returned an unexpected codec path."
[ "${#EXPECTED_SHA256}" -eq 64 ] ||
	die "The codec package checksum has an invalid length."
case "$EXPECTED_SHA256" in
	*[!0-9a-f]*)
		die "The codec package checksum is not lowercase hexadecimal."
		;;
esac

printf '%s\n' \
	"Verified snapshot commit: $SNAPSHOT_COMMIT" \
	"Verified source commit: $SOURCE_COMMIT"

RUNTIME_ACTION="install"
INSTALLED_RUNTIME_VERSION=""
case "$PACKAGE_FORMAT" in
	apk)
		APK_INFO_STATUS="0"
		apk info -e "$PACKAGE_NAME" >/dev/null 2>&1 ||
			APK_INFO_STATUS="$?"
		case "$APK_INFO_STATUS" in
			0)
				APK_MANIFEST="$(
					apk list --installed --manifest "$PACKAGE_NAME" 2>/dev/null
				)" ||
					die "Could not read the installed $PACKAGE_NAME version."
				case "$APK_MANIFEST" in
					"$PACKAGE_NAME "*)
						INSTALLED_RUNTIME_VERSION="${APK_MANIFEST#"$PACKAGE_NAME "}"
						;;
					*)
						die "apk returned unexpected installed-package metadata for $PACKAGE_NAME."
						;;
				esac
				require_safe_component \
					"installed codec package version" \
					"$INSTALLED_RUNTIME_VERSION"
				APK_VERSION_ORDER="$(
					apk version -t \
						"$INSTALLED_RUNTIME_VERSION" \
						"$TARGET_PACKAGE_VERSION"
				)" ||
					die "apk could not compare codec package versions."
				case "$APK_VERSION_ORDER" in
					"<"|"="|">")
						;;
					*)
						die "apk returned an unexpected codec version comparison."
						;;
				esac
				RUNTIME_METADATA_MATCHES="0"
				installed_runtime_matches_router &&
					RUNTIME_METADATA_MATCHES="1"
				RUNTIME_ACTION="$(
					select_runtime_action \
						"$APK_VERSION_ORDER" \
						"$RUNTIME_METADATA_MATCHES"
				)" ||
					die \
						"A newer $PACKAGE_NAME is installed, but its build metadata does not match this router."
				;;
			1)
				;;
			*)
				die "Could not determine whether $PACKAGE_NAME is installed."
				;;
		esac
		;;
	ipk)
		OPKG_INSTALLED="$(
			opkg list-installed "$PACKAGE_NAME" 2>/dev/null
		)" || die "Could not query the installed $PACKAGE_NAME package."
		case "$OPKG_INSTALLED" in
			"")
				;;
			"$PACKAGE_NAME - "*)
				INSTALLED_RUNTIME_VERSION="${OPKG_INSTALLED#"$PACKAGE_NAME - "}"
				require_safe_component \
					"installed codec package version" \
					"$INSTALLED_RUNTIME_VERSION"
				if opkg compare-versions \
					"$INSTALLED_RUNTIME_VERSION" \
					"<<" "$TARGET_PACKAGE_VERSION"; then
					OPKG_VERSION_ORDER="<"
				elif opkg compare-versions \
					"$INSTALLED_RUNTIME_VERSION" \
					"=" "$TARGET_PACKAGE_VERSION"; then
					OPKG_VERSION_ORDER="="
				elif opkg compare-versions \
					"$INSTALLED_RUNTIME_VERSION" \
					">>" "$TARGET_PACKAGE_VERSION"; then
					OPKG_VERSION_ORDER=">"
				else
					die "opkg could not compare codec package versions."
				fi
				RUNTIME_METADATA_MATCHES="0"
				installed_runtime_matches_router &&
					RUNTIME_METADATA_MATCHES="1"
				RUNTIME_ACTION="$(
					select_runtime_action \
						"$OPKG_VERSION_ORDER" \
						"$RUNTIME_METADATA_MATCHES"
				)" ||
					die \
						"A newer $PACKAGE_NAME is installed, but its build metadata does not match this router."
				;;
			*)
				die "opkg returned unexpected installed-package metadata for $PACKAGE_NAME."
				;;
		esac
		;;
esac

case "$RUNTIME_ACTION" in
	install)
		printf 'Installing architecture-specific FFmpeg package %s...\n' \
			"$PACKAGE_FILE"
		;;
	upgrade)
		printf 'Updating %s from %s to %s...\n' \
			"$PACKAGE_NAME" \
			"$INSTALLED_RUNTIME_VERSION" \
			"$TARGET_PACKAGE_VERSION"
		;;
	repair)
		printf 'Reinstalling the current %s because its build metadata is incomplete or incompatible...\n' \
			"$PACKAGE_NAME"
		;;
	current)
		printf '%s %s is already current; continuing.\n' \
			"$PACKAGE_NAME" "$INSTALLED_RUNTIME_VERSION"
		;;
	newer)
		printf '%s %s is newer than %s; keeping the verified matching runtime.\n' \
			"$PACKAGE_NAME" \
			"$INSTALLED_RUNTIME_VERSION" \
			"$TARGET_PACKAGE_VERSION"
		;;
esac

case "$RUNTIME_ACTION" in
	current|newer)
		printf '%s\n' \
			"No FFmpeg package download is needed."
		;;
	*)
		printf 'Downloading codecs built from source commit %s...\n' \
			"$SOURCE_COMMIT"
		if ! download_file \
			"$SNAPSHOT_RAW_URL/dist/$CODEC_RELATIVE_PATH" \
			"$PACKAGE_PATH" \
			"$MAX_PACKAGE_BLOCKS"; then
			die "Could not download the codec package."
		fi
		ACTUAL_SHA256="$(sha256sum "$PACKAGE_PATH")"
		ACTUAL_SHA256="${ACTUAL_SHA256%% *}"
		[ "$ACTUAL_SHA256" = "$EXPECTED_SHA256" ] ||
			die "The downloaded codec package failed SHA-256 verification."
		printf '%s\n' \
			"Verified codec package SHA-256: $ACTUAL_SHA256"
		;;
esac

case "$RUNTIME_ACTION:$PACKAGE_FORMAT" in
	install:apk|upgrade:apk)
		apk add --allow-untrusted "$PACKAGE_PATH"
		;;
	repair:apk)
		apk add --allow-untrusted --force-reinstall "$PACKAGE_PATH"
		;;
	install:ipk|upgrade:ipk)
		opkg install "$PACKAGE_PATH"
		;;
	repair:ipk)
		opkg --force-reinstall install "$PACKAGE_PATH"
		;;
	current:*|newer:*)
		;;
esac

case "$PACKAGE_FORMAT" in
	apk)
		apk info -e "$PACKAGE_NAME" >/dev/null 2>&1 ||
			die "apk completed without registering $PACKAGE_NAME."
		;;
	ipk)
		opkg list-installed "$PACKAGE_NAME" 2>/dev/null |
			grep -q "^$PACKAGE_NAME - " ||
			die "opkg completed without registering $PACKAGE_NAME."
		;;
esac
if [ "$RUNTIME_ACTION" != "install" ]; then
	printf '%s\n' \
		"Architecture-specific FFmpeg update check complete; continuing."
fi

installed_runtime_matches_router ||
	die "The installed codec attestation does not match the exact software-cpu-v1 runtime contract."
if [ ! -f "$PRIVATE_FFMPEG" ] ||
	[ -L "$PRIVATE_FFMPEG" ] ||
	[ ! -x "$PRIVATE_FFMPEG" ] ||
	[ "$(stat -c '%u:%a' "$PRIVATE_FFMPEG" 2>/dev/null)" != "0:755" ]; then
	die "The installed private FFmpeg is missing or unsafe: $PRIVATE_FFMPEG"
fi
if [ ! -f "$PRIVATE_RELAY" ] ||
	[ -L "$PRIVATE_RELAY" ] ||
	[ ! -x "$PRIVATE_RELAY" ] ||
	[ "$(stat -c '%u:%a' "$PRIVATE_RELAY" 2>/dev/null)" != "0:755" ]; then
	die "The installed MJPEG relay is missing or unsafe: $PRIVATE_RELAY"
fi
RELAY_PROBE_RC="0"
"$PRIVATE_RELAY" </dev/null >/dev/null 2>&1 || RELAY_PROBE_RC="$?"
[ "$RELAY_PROBE_RC" -eq 64 ] ||
	die "The installed MJPEG relay failed its executable probe."

DECODERS_REPORT="$WORK_DIR/ffmpeg-decoders"
ENCODERS_REPORT="$WORK_DIR/ffmpeg-encoders"
MUXERS_REPORT="$WORK_DIR/ffmpeg-muxers"
FILTERS_REPORT="$WORK_DIR/ffmpeg-filters"
HWACCELS_REPORT="$WORK_DIR/ffmpeg-hwaccels"
VERSION_REPORT="$WORK_DIR/ffmpeg-version"
FFMPEG_ERROR="$WORK_DIR/ffmpeg-error"

for report in decoders encoders muxers filters hwaccels version; do
	case "$report" in
		decoders)
			report_path="$DECODERS_REPORT"
			;;
		encoders)
			report_path="$ENCODERS_REPORT"
			;;
		muxers)
			report_path="$MUXERS_REPORT"
			;;
		filters)
			report_path="$FILTERS_REPORT"
			;;
		hwaccels)
			report_path="$HWACCELS_REPORT"
			;;
		version)
			report_path="$VERSION_REPORT"
			;;
	esac
	if ! run_ffmpeg_report "-$report" "$report_path" "$FFMPEG_ERROR"; then
		[ ! -s "$FFMPEG_ERROR" ] ||
			sed -n '1,8p' "$FFMPEG_ERROR" >&2
		die "The installed private FFmpeg could not report its $report."
	fi
done

grep -Fx 'Hardware acceleration methods:' "$HWACCELS_REPORT" >/dev/null ||
	die "The installed private FFmpeg returned a malformed hardware-accelerator report."
if sed -n '/^Hardware acceleration methods:$/,$p' "$HWACCELS_REPORT" |
	sed '1d' | grep -Eq '[^[:space:]]'; then
	die "The installed private FFmpeg reports a hardware accelerator."
fi
for SOFTWARE_OPTION in \
	--disable-autodetect \
	--disable-avdevice \
	--disable-network \
	--disable-indevs \
	--disable-outdevs \
	--disable-hwaccels \
	--disable-vaapi \
	--disable-vdpau \
	--disable-vulkan \
	--disable-decoders \
	--disable-encoders
do
	grep -F -- "$SOFTWARE_OPTION" "$VERSION_REPORT" >/dev/null ||
		die "The installed private FFmpeg lacks $SOFTWARE_OPTION."
done

UNEXPECTED_DECODERS="$(
	unexpected_codec_aliases "$DECODERS_REPORT" \
		"h263 h264 hevc vc1 mpeg4 vp8 vp9 av1 mjpeg aac ac3 eac3 alac dca flac mp3 opus pcm_s16le truehd vorbis"
)"
[ -z "$UNEXPECTED_DECODERS" ] ||
	die "The installed private FFmpeg exposes decoder(s) outside the software allowlist: $UNEXPECTED_DECODERS"

UNEXPECTED_ENCODERS="$(
	unexpected_codec_aliases "$ENCODERS_REPORT" "mjpeg pcm_s16le"
)"
[ -z "$UNEXPECTED_ENCODERS" ] ||
	die "The installed private FFmpeg exposes encoder(s) outside the software allowlist: $UNEXPECTED_ENCODERS"

COMPONENTS_OK="1"
for VIDEO_DECODER in h263 h264 hevc vc1 mpeg4 vp8 vp9 av1 mjpeg; do
	check_component "$DECODERS_REPORT" \
		"^[[:space:]]*V[^[:space:]]*[[:space:]]+$VIDEO_DECODER([[:space:]]|$)" \
		"the native $VIDEO_DECODER video decoder" ||
		COMPONENTS_OK="0"
done
for AUDIO_DECODER in \
	aac ac3 eac3 alac dca flac mp3 opus pcm_s16le truehd vorbis
do
	check_component "$DECODERS_REPORT" \
		"^[[:space:]]*A[^[:space:]]*[[:space:]]+$AUDIO_DECODER([[:space:]]|$)" \
		"the native $AUDIO_DECODER audio decoder" ||
		COMPONENTS_OK="0"
done
check_component "$ENCODERS_REPORT" \
	'^[[:space:]]*V[^[:space:]]*[[:space:]]+mjpeg([[:space:]]|$)' \
	"the mjpeg video encoder" ||
	COMPONENTS_OK="0"
check_component "$ENCODERS_REPORT" \
	'^[[:space:]]*A[^[:space:]]*[[:space:]]+pcm_s16le([[:space:]]|$)' \
	"the PCM S16LE audio encoder" ||
	COMPONENTS_OK="0"
for MUXER in image2 mpjpeg s16le tee; do
	check_component "$MUXERS_REPORT" \
		"^[[:space:]]*E[[:space:]]+$MUXER([[:space:]]|$)" \
		"the $MUXER muxer" ||
		COMPONENTS_OK="0"
done
for FILTER in fps scale format aresample aformat apad asetnsamples; do
	check_component "$FILTERS_REPORT" \
		"^[[:space:]]*[^[:space:]]+[[:space:]]+${FILTER}[[:space:]]" \
		"the $FILTER filter" ||
		COMPONENTS_OK="0"
done
[ "$COMPONENTS_OK" = "1" ] ||
	die "The installed private FFmpeg is incomplete."

printf '%s\n' \
	"Codec runtime installation complete." \
	"Verified execution backend: $EXECUTION_BACKEND" \
	"Verified hardware accelerators: none" \
	"Verified private FFmpeg: $PRIVATE_FFMPEG" \
	"Verified frame-aligned MJPEG relay: $PRIVATE_RELAY" \
	"Verified video decoders: h263, h264, hevc, vc1, mpeg4, vp8, vp9, av1, mjpeg" \
	"Verified audio decoders: aac, ac3, eac3, alac, dca, flac, mp3, opus, pcm_s16le, truehd, vorbis" \
	"Verified video pipeline: mjpeg encoder, mpjpeg stream, image2 compatibility, fps, scale, format" \
	"Verified audio pipeline: pcm_s16le, s16le, tee, aresample, aformat, apad, asetnsamples"
}

main "$@"
