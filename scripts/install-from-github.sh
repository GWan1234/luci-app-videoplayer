#!/bin/sh
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Install luci-app-videoplayer 1.1.0 and its exact architecture-specific
# software-CPU codec runtime directly from GitHub Release 1.1.0.

set -eu

REPOSITORY="communism420/luci-app-videoplayer"
RELEASE_VERSION="1.1.0"
RELEASE_SOURCE_COMMIT="80a4045b8fedc431467de9ad60416314b789fa79"
RELEASE_BASE_URL="https://github.com/$REPOSITORY/releases/download/$RELEASE_VERSION"

APK_FILE="luci-app-videoplayer-$RELEASE_VERSION.apk"
APK_SHA256="d695b52241ba5391f637ae4f09d0cc8a4f1e4d7f3f2d537b99bdfbd645f26da9"
IPK_FILE="luci-app-videoplayer_${RELEASE_VERSION}_all.ipk"
IPK_SHA256="f037d5c34acc27b4c70903ad6d2ea6e49dd2b41b81b8778e8a678a70735ad582"

CODEC_VERSION="6.1.4-r5"
CODEC_PACKAGE_NAME="luci-videoplayer-codec-runtime"
CODEC_MANIFEST_FILE="release-1.1.0-codecs.tsv"
# Updated after the release manifest is generated; tests require an exact
# match with scripts/release-1.1.0-codecs.tsv.
CODEC_MANIFEST_SHA256="91e77695cb7262053d4722b825c603dc207ad98a2368a39e4bc35f6cad1e2d89"

PRIVATE_BUILD_INFO="/usr/share/luci-videoplayer-codec-runtime/build-info"
PRIVATE_FFMPEG="/usr/libexec/videoplayer-ffmpeg/ffmpeg"
PRIVATE_RELAY="/usr/libexec/videoplayer-ffmpeg/videoplayer-mjpeg-relay"
RENDERER_HELPER="/usr/libexec/videoplayer-renderer"
EXPECTED_ATTESTATION="private-software-cpu	software-cpu-v1	none"

# POSIX ulimit -f counts 512-byte blocks.
MAX_METADATA_BLOCKS="128"
MAX_APP_PACKAGE_BLOCKS="8192"
# The largest frozen Release 1.1.0 codec is below 4.6 MiB. Keep enough headroom
# for the verified asset without allowing an oversized response to fill /tmp.
MAX_CODEC_PACKAGE_BLOCKS="16384"
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
		/tmp/luci-app-videoplayer-release.*)
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
	sed -n "s/^${release_key}='\([^']*\)'$/\1/p" /etc/openwrt_release
}

require_safe_component() {
	component_name="$1"
	component_value="$2"
	case "$component_value" in
		''|*[!a-zA-Z0-9._+-]*)
			die "OpenWrt returned an unsafe or empty $component_name value."
			;;
	esac
}

validate_sha256() {
	sha_value="$1"
	[ "${#sha_value}" -eq 64 ] || return 1
	case "$sha_value" in
		*[!0-9a-f]*) return 1 ;;
	esac
	return 0
}

select_release_codec() {
	manifest_path="$1"
	wanted_format="$2"
	wanted_release="$3"
	wanted_revision="$4"
	wanted_arch="$5"

	MATCH_COUNT="0"
	CODEC_ASSET_FILE=""
	CODEC_SHA256=""
	CODEC_PACKAGE_FILE=""
	while IFS='|' read -r \
		row_format row_release row_revision row_arch \
		row_asset row_sha256 row_package extra
	do
		case "$row_format" in
			\#*|"")
				continue
				;;
		esac
		[ -z "$extra" ] ||
			die "The release codec manifest has unexpected fields."
		if [ "$row_format" = "$wanted_format" ] &&
			[ "$row_release" = "$wanted_release" ] &&
			[ "$row_revision" = "$wanted_revision" ] &&
			[ "$row_arch" = "$wanted_arch" ]; then
			MATCH_COUNT=$((MATCH_COUNT + 1))
			CODEC_ASSET_FILE="$row_asset"
			CODEC_SHA256="$row_sha256"
			CODEC_PACKAGE_FILE="$row_package"
		fi
	done < "$manifest_path"

	[ "$MATCH_COUNT" -eq 1 ] ||
		die \
			"No unique Release $RELEASE_VERSION codec exists for OpenWrt $wanted_release $wanted_revision, architecture $wanted_arch, format $wanted_format."
	validate_sha256 "$CODEC_SHA256" ||
		die "The selected codec checksum is invalid."

	case "$wanted_format" in
		apk)
			expected_asset="${CODEC_PACKAGE_NAME}-${CODEC_VERSION}_${wanted_arch}.apk"
			expected_package="${CODEC_PACKAGE_NAME}-${CODEC_VERSION}.apk"
			;;
		ipk)
			expected_asset="${CODEC_PACKAGE_NAME}_${CODEC_VERSION}_${wanted_arch}.ipk"
			expected_package="$expected_asset"
			;;
		*)
			die "Internal error: unsupported package format."
			;;
	esac
	[ "$CODEC_ASSET_FILE" = "$expected_asset" ] &&
		[ "$CODEC_PACKAGE_FILE" = "$expected_package" ] ||
		die "The release codec manifest returned an unexpected package name."
}

apk_force_reinstall_supported() {
	apk add --force-reinstall --help >/dev/null 2>&1
}

select_apk_install_mode() {
	package_name="$1"
	if [ "$APK_FORCE_REINSTALL_SUPPORTED" = "1" ]; then
		printf '%s\n' "force"
		return 0
	fi

	apk_info_status="0"
	apk info -e "$package_name" >/dev/null 2>&1 ||
		apk_info_status="$?"
	case "$apk_info_status" in
		0)
		die \
			"This apk version cannot safely reinstall $package_name. Upgrade OpenWrt or remove the package before retrying."
			;;
		1)
			printf '%s\n' "plain"
			;;
		*)
			die "Could not determine whether $package_name is installed."
			;;
	esac
}

install_apk_package() {
	install_mode="$1"
	package_path="$2"
	case "$install_mode" in
		force)
			apk add --allow-untrusted --force-reinstall "$package_path"
			;;
		plain)
			apk add --allow-untrusted "$package_path"
			;;
		*)
			die "Internal error: unknown apk installation mode."
			;;
	esac
}

verify_registered_package() {
	package_name="$1"
	case "$PACKAGE_FORMAT" in
		apk)
			apk info -e "$package_name" >/dev/null 2>&1 ||
				die "apk completed without registering $package_name."
			;;
		ipk)
			opkg list-installed "$package_name" 2>/dev/null |
				grep -q "^$package_name - " ||
				die "opkg completed without registering $package_name."
			;;
	esac
}

require_post_app_commands() {
	# coreutils-stat is an application dependency and is not part of a minimal
	# BusyBox installation on every supported OpenWrt release.  Check it only
	# after the package manager has installed the application dependencies.
	command -v stat >/dev/null 2>&1 ||
		die "The application transaction did not provide its required coreutils-stat dependency."
}

require_build_info_field() {
	field_name="$1"
	expected_value="$2"
	field_value="$(
		sed -n "s/^${field_name}=//p" "$PRIVATE_BUILD_INFO"
	)"
	field_count="$(
		sed -n "s/^${field_name}=//p" "$PRIVATE_BUILD_INFO" |
			wc -l | tr -d '[:space:]'
	)"
	[ "$field_count" = "1" ] && [ "$field_value" = "$expected_value" ] ||
		die "The installed codec metadata has an invalid $field_name value."
}

verify_installed_runtime() {
	[ -f "$PRIVATE_BUILD_INFO" ] && [ ! -L "$PRIVATE_BUILD_INFO" ] &&
		[ "$(stat -c '%u:%a' "$PRIVATE_BUILD_INFO" 2>/dev/null)" = "0:644" ] ||
		die "The installed codec metadata is missing or unsafe."
	[ "$(wc -l < "$PRIVATE_BUILD_INFO" | tr -d '[:space:]')" = "24" ] ||
		die "The installed codec metadata has an unexpected schema."

	require_build_info_field format 4
	require_build_info_field openwrt_release "$DISTRIB_RELEASE_VALUE"
	require_build_info_field openwrt_revision "$DISTRIB_REVISION_VALUE"
	require_build_info_field compatible_arch "$DISTRIB_ARCH_VALUE"
	require_build_info_field ffmpeg_version 6.1.4
	require_build_info_field package_format "$PACKAGE_FORMAT"
	require_build_info_field renderer_profile software-cpu-v1
	require_build_info_field execution_backend software-cpu-v1
	require_build_info_field software_cpu_only 1
	require_build_info_field network_enabled n
	require_build_info_field avdevice_enabled n
	require_build_info_field swresample_enabled y
	require_build_info_field audio_output pcm_s16le
	require_build_info_field audio_sample_rate 48000
	require_build_info_field audio_channels 2
	require_build_info_field audio_chunk_frames 48000
	require_build_info_field audio_chunk_bytes 192000
	require_build_info_field private_binary "$PRIVATE_FFMPEG"

	for executable_path in "$PRIVATE_FFMPEG" "$PRIVATE_RELAY" "$RENDERER_HELPER"; do
		[ -f "$executable_path" ] && [ ! -L "$executable_path" ] &&
			[ -x "$executable_path" ] &&
			[ "$(stat -c '%u:%a' "$executable_path" 2>/dev/null)" = "0:755" ] ||
			die "The installed executable is missing or unsafe: $executable_path"
	done

	relay_status="0"
	"$PRIVATE_RELAY" </dev/null >/dev/null 2>&1 || relay_status="$?"
	[ "$relay_status" -eq 64 ] ||
		die "The installed MJPEG relay failed its executable probe."

	attestation_output="$("$RENDERER_HELPER" attest)" ||
		die "The installed Router CPU runtime failed software-only attestation."
	[ "$attestation_output" = "$EXPECTED_ATTESTATION" ] ||
		die "The installed Router CPU runtime returned an unexpected attestation."
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
					"Usage: sh install-from-github.sh" \
					"" \
					"Downloads, verifies, and installs luci-app-videoplayer Release $RELEASE_VERSION" \
					"and its exact architecture-specific $CODEC_VERSION software-CPU runtime." \
					"Supported: OpenWrt 25.12.5 r33051-f5dae5ece4 (apk) and" \
					"OpenWrt 24.10.8 r29233-443ec4032a (opkg)."
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
for required_command in grep mktemp sed sha256sum tr wc; do
	command -v "$required_command" >/dev/null 2>&1 ||
		die "Required command is missing: $required_command"
done
detect_working_timeout
if [ "$HAS_WORKING_TIMEOUT" != "1" ]; then
	warn \
		"A working timeout command is unavailable; bounded file-size checks remain active, but network deadlines cannot be enforced."
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
	die "Neither apk nor opkg was found."
fi

if [ "$HAS_APK" = "1" ]; then
	PACKAGE_FORMAT="apk"
	APP_PACKAGE_FILE="$APK_FILE"
	APP_SHA256="$APK_SHA256"
	APP_PACKAGE_NAME="luci-app-videoplayer"
else
	PACKAGE_FORMAT="ipk"
	APP_PACKAGE_FILE="$IPK_FILE"
	APP_SHA256="$IPK_SHA256"
	APP_PACKAGE_NAME="luci-app-videoplayer"
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

umask 077
WORK_DIR="$(mktemp -d /tmp/luci-app-videoplayer-release.XXXXXX)" ||
	die "Could not create a temporary directory."
trap cleanup 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

MANIFEST_PATH="$WORK_DIR/$CODEC_MANIFEST_FILE"
MANIFEST_URL="$RELEASE_BASE_URL/$CODEC_MANIFEST_FILE"
printf 'Downloading the pinned Release %s codec manifest...\n' \
	"$RELEASE_VERSION"
if ! download_file \
	"$MANIFEST_URL" "$MANIFEST_PATH" "$MAX_METADATA_BLOCKS"; then
	die "Could not download the Release $RELEASE_VERSION codec manifest."
fi
verify_sha256 \
	"$CODEC_MANIFEST_SHA256" "$MANIFEST_PATH" "codec manifest"
[ "$(grep -Fxc "# source_commit=$RELEASE_SOURCE_COMMIT" "$MANIFEST_PATH")" = "1" ] ||
	die "The release codec manifest has unexpected source provenance."

select_release_codec \
	"$MANIFEST_PATH" \
	"$PACKAGE_FORMAT" \
	"$DISTRIB_RELEASE_VALUE" \
	"$DISTRIB_REVISION_VALUE" \
	"$DISTRIB_ARCH_VALUE"

APK_FORCE_REINSTALL_SUPPORTED="0"
if [ "$PACKAGE_FORMAT" = "apk" ] && apk_force_reinstall_supported; then
	APK_FORCE_REINSTALL_SUPPORTED="1"
fi
if [ "$PACKAGE_FORMAT" = "apk" ]; then
	APP_INSTALL_MODE="$(select_apk_install_mode "$APP_PACKAGE_NAME")"
	CODEC_INSTALL_MODE="$(select_apk_install_mode "$CODEC_PACKAGE_NAME")"
fi

APP_PACKAGE_PATH="$WORK_DIR/$APP_PACKAGE_FILE"
CODEC_PACKAGE_PATH="$WORK_DIR/$CODEC_PACKAGE_FILE"

printf 'Downloading %s from GitHub Release %s...\n' \
	"$APP_PACKAGE_FILE" "$RELEASE_VERSION"
if ! download_file \
	"$RELEASE_BASE_URL/$APP_PACKAGE_FILE" \
	"$APP_PACKAGE_PATH" \
	"$MAX_APP_PACKAGE_BLOCKS"; then
	die "Could not download the Release $RELEASE_VERSION application package."
fi
verify_sha256 "$APP_SHA256" "$APP_PACKAGE_PATH" "application package"

printf 'Downloading %s for %s...\n' \
	"$CODEC_ASSET_FILE" "$DISTRIB_ARCH_VALUE"
if ! download_file \
	"$RELEASE_BASE_URL/$CODEC_ASSET_FILE" \
	"$CODEC_PACKAGE_PATH" \
	"$MAX_CODEC_PACKAGE_BLOCKS"; then
	die "Could not download the Release $RELEASE_VERSION codec package."
fi
verify_sha256 "$CODEC_SHA256" "$CODEC_PACKAGE_PATH" "codec package"

printf '%s\n' \
	"Verified release source commit: $RELEASE_SOURCE_COMMIT" \
	"Verified application SHA-256: $APP_SHA256" \
	"Verified codec SHA-256: $CODEC_SHA256"

case "$PACKAGE_FORMAT" in
	apk)
		if ! apk update; then
			warn "Could not refresh apk indexes; continuing with the current indexes."
		fi
		printf 'Installing %s before the codec runtime...\n' "$APP_PACKAGE_FILE"
		if ! install_apk_package "$APP_INSTALL_MODE" "$APP_PACKAGE_PATH"; then
			die "The Release $RELEASE_VERSION application installation failed; the codec runtime was not changed."
		fi
		verify_registered_package "$APP_PACKAGE_NAME"
		require_post_app_commands
		printf 'Installing %s after the strict maintenance helper...\n' \
			"$CODEC_ASSET_FILE"
		if ! install_apk_package "$CODEC_INSTALL_MODE" "$CODEC_PACKAGE_PATH"; then
			die "The application was installed, but the matching codec runtime failed. Browser mode remains available; retry this installer before using Router CPU mode."
		fi
		;;
	ipk)
		if ! opkg update; then
			warn "Could not refresh opkg indexes; continuing with the current indexes."
		fi
		printf 'Installing %s before the codec runtime...\n' "$APP_PACKAGE_FILE"
		if ! opkg --force-downgrade --force-reinstall install "$APP_PACKAGE_PATH"; then
			die "The Release $RELEASE_VERSION application installation failed; the codec runtime was not changed."
		fi
		verify_registered_package "$APP_PACKAGE_NAME"
		require_post_app_commands
		printf 'Installing %s after the strict maintenance helper...\n' \
			"$CODEC_ASSET_FILE"
		if ! opkg --force-downgrade --force-reinstall install "$CODEC_PACKAGE_PATH"; then
			die "The application was installed, but the matching codec runtime failed. Browser mode remains available; retry this installer before using Router CPU mode."
		fi
		;;
esac

verify_registered_package "$CODEC_PACKAGE_NAME"
verify_installed_runtime

printf '%s\n' \
	"Installation and software-CPU attestation complete." \
	"Sign out of LuCI and sign in again if the menu item is not visible." \
	"Open LuCI -> Services -> Video Player."
}

main "$@"
