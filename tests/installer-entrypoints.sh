#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later

set -euo pipefail

if [[ $# -ne 1 ]]; then
	printf 'Usage: %s REPOSITORY_ROOT\n' "$0" >&2
	exit 2
fi

root="$1"
tmp="$(mktemp -d)"
fail() {
	printf '%s\n' "$*" >&2
	exit 1
}
cleanup() {
	rm -rf -- "$tmp"
}
trap cleanup EXIT

broken_timeout_bin="$tmp/broken-timeout-bin"
mkdir "$broken_timeout_bin"
cat > "$broken_timeout_bin/timeout" <<'EOF'
#!/bin/sh
: "${TIMEOUT_PROBE_LOG:?}"
printf x >> "$TIMEOUT_PROBE_LOG"
printf '%s\n' 'timeout: applet not found' >&2
exit 127
EOF
chmod 0755 "$broken_timeout_bin/timeout"

working_timeout_bin="$tmp/working-timeout-bin"
mkdir "$working_timeout_bin"
cat > "$working_timeout_bin/timeout" <<'EOF'
#!/bin/sh
: "${TIMEOUT_PROBE_LOG:?}"
printf x >> "$TIMEOUT_PROBE_LOG"
shift
exec "$@"
EOF
chmod 0755 "$working_timeout_bin/timeout"

cat > "$tmp/probe-timeout-fallback.sh" <<'EOF'
#!/bin/sh
set -eu

installer_without_main="$1"
fallback_marker="$2"

# shellcheck disable=SC1090
. "$installer_without_main"
detect_working_timeout
[ "$HAS_WORKING_TIMEOUT" = "0" ]
run_with_download_deadline \
	/bin/sh -c 'printf fallback > "$1"' sh "$fallback_marker"
EOF

cat > "$tmp/probe-working-timeout.sh" <<'EOF'
#!/bin/sh
set -eu

installer_without_main="$1"
deadline_marker="$2"

# shellcheck disable=SC1090
. "$installer_without_main"
detect_working_timeout
[ "$HAS_WORKING_TIMEOUT" = "1" ]
run_with_download_deadline \
	/bin/sh -c 'printf deadline > "$1"' sh "$deadline_marker"
EOF

mapfile -t bootstrap_commands < <(
	grep -E '^\(set -eu; .*installer=' "$root/README.md"
)
if ((${#bootstrap_commands[@]} != 2)); then
	printf 'README.md must contain exactly two one-line app installers.\n' >&2
	exit 1
fi
for bootstrap_command in "${bootstrap_commands[@]}"; do
	sh -n -c "$bootstrap_command"
done

grep -Fq \
	'apk add --allow-untrusted --force-reinstall /tmp/luci-app-videoplayer-1.1.0.apk' \
	"$root/README.md" || {
	printf '%s\n' \
		'README.md must force-reinstall the current local APK.' >&2
	exit 1
}
grep -Fq \
	'opkg --force-downgrade --force-reinstall install /tmp/luci-app-videoplayer_1.1.0_all.ipk' \
	"$root/README.md" || {
	printf '%s\n' \
		'README.md must force-downgrade and force-reinstall the current local IPK.' >&2
	exit 1
}

codec_installer_sha="$(
	sha256sum "$root/scripts/install-codec-runtime.sh" |
		awk '{ print $1 }'
)"
app_installer="scripts/install-main-apk.sh"
grep -Fx \
	"CODEC_INSTALLER_SHA256=\"$codec_installer_sha\"" \
	"$root/$app_installer" >/dev/null || {
	printf '%s does not pin the current codec installer SHA-256.\n' \
		"$app_installer" >&2
	exit 1
}
grep -F "if ! /bin/sh \"\$CODEC_INSTALLER_PATH\"; then" \
		"$root/$app_installer" >/dev/null || {
	printf '%s does not run the verified codec installer.\n' \
		"$app_installer" >&2
	exit 1
}
codec_call_line="$(
	grep -nF \
		"if ! /bin/sh \"\$CODEC_INSTALLER_PATH\"; then" \
		"$root/$app_installer" |
		awk -F: 'NR == 1 { print $1 }'
)"
app_install_marker="install_apk_package \"\$APK_INSTALL_MODE\" \"\$APK_PATH\""
app_install_line="$(
	grep -nF "$app_install_marker" "$root/$app_installer" |
		awk -F: 'NR == 1 { print $1 }'
)"
if [[ ! "$codec_call_line" =~ ^[0-9]+$ ]] ||
	[[ ! "$app_install_line" =~ ^[0-9]+$ ]] ||
	((app_install_line >= codec_call_line)); then
	printf '%s does not install the strict application maintenance helper before FFmpeg.\n' \
		"$app_installer" >&2
	exit 1
fi

python3 "$root/tests/release-installer.py" "$root"

release_installer="$root/scripts/install-from-github.sh"
release_installer_without_main="$tmp/install-from-github.without-main"
sed '$d' "$release_installer" > "$release_installer_without_main"

release_help="$(sh "$release_installer" --help)"
grep -Fq 'Release 1.1.0' <<<"$release_help" ||
	fail 'The release installer help does not identify Release 1.1.0.'
grep -Fq '6.1.4-r5 software-CPU runtime' <<<"$release_help" ||
	fail 'The release installer help does not identify the strict codec runtime.'
grep -Fq 'OpenWrt 25.12.5 r33051-f5dae5ece4 (apk)' <<<"$release_help" ||
	fail 'The release installer help omits its exact APK platform.'
grep -Fq 'OpenWrt 24.10.8 r29233-443ec4032a (opkg)' <<<"$release_help" ||
	fail 'The release installer help omits its exact IPK platform.'

selected_apk="$tmp/selected-apk"
sh -s -- "$release_installer_without_main" \
	"$root/scripts/release-1.1.0-codecs.tsv" > "$selected_apk" <<'EOF'
set -eu
installer="$1"
manifest="$2"
# shellcheck disable=SC1090
. "$installer"
select_release_codec \
	"$manifest" apk 25.12.5 r33051-f5dae5ece4 aarch64_cortex-a53
printf '%s|%s|%s\n' \
	"$CODEC_ASSET_FILE" "$CODEC_SHA256" "$CODEC_PACKAGE_FILE"
EOF
grep -Fx \
	'luci-videoplayer-codec-runtime-6.1.4-r5_aarch64_cortex-a53.apk|2b04eeb65a9cece7dc4268ff6bccae0ae78bff783d355b37818096d8816d3436|luci-videoplayer-codec-runtime-6.1.4-r5.apk' \
	"$selected_apk" >/dev/null ||
	fail 'The release installer selected the wrong APK codec mapping.'

selected_ipk="$tmp/selected-ipk"
sh -s -- "$release_installer_without_main" \
	"$root/scripts/release-1.1.0-codecs.tsv" > "$selected_ipk" <<'EOF'
set -eu
installer="$1"
manifest="$2"
# shellcheck disable=SC1090
. "$installer"
select_release_codec \
	"$manifest" ipk 24.10.8 r29233-443ec4032a x86_64
printf '%s|%s|%s\n' \
	"$CODEC_ASSET_FILE" "$CODEC_SHA256" "$CODEC_PACKAGE_FILE"
EOF
grep -Fx \
	'luci-videoplayer-codec-runtime_6.1.4-r5_x86_64.ipk|af21e9eab4761b2fb40ac043f0b60f5f1c727519f4cc61aa679bce3e9f7ca08b|luci-videoplayer-codec-runtime_6.1.4-r5_x86_64.ipk' \
	"$selected_ipk" >/dev/null ||
	fail 'The release installer selected the wrong IPK codec mapping.'

duplicate_manifest="$tmp/duplicate-codec-manifest.tsv"
{
	grep '^#' "$root/scripts/release-1.1.0-codecs.tsv"
	grep -F \
		'apk|25.12.5|r33051-f5dae5ece4|aarch64_cortex-a53|' \
		"$root/scripts/release-1.1.0-codecs.tsv"
	grep -F \
		'apk|25.12.5|r33051-f5dae5ece4|aarch64_cortex-a53|' \
		"$root/scripts/release-1.1.0-codecs.tsv"
} > "$duplicate_manifest"
if sh -s -- "$release_installer_without_main" "$duplicate_manifest" \
	>"$tmp/duplicate.stdout" 2>"$tmp/duplicate.stderr" <<'EOF'
set -eu
installer="$1"
manifest="$2"
# shellcheck disable=SC1090
. "$installer"
select_release_codec \
	"$manifest" apk 25.12.5 r33051-f5dae5ece4 aarch64_cortex-a53
EOF
then
	fail 'The release installer accepted an ambiguous codec mapping.'
fi
grep -F 'No unique Release 1.1.0 codec exists' \
	"$tmp/duplicate.stderr" >/dev/null ||
	fail 'The ambiguous codec mapping returned the wrong error.'

if sh -s -- "$release_installer_without_main" \
	"$root/scripts/release-1.1.0-codecs.tsv" \
	>"$tmp/unsupported.stdout" 2>"$tmp/unsupported.stderr" <<'EOF'
set -eu
installer="$1"
manifest="$2"
# shellcheck disable=SC1090
. "$installer"
select_release_codec \
	"$manifest" apk 25.12.5 r33051-f5dae5ece4 unsupported_arch
EOF
then
	fail 'The release installer accepted an unsupported architecture.'
fi
grep -F 'No unique Release 1.1.0 codec exists' \
	"$tmp/unsupported.stderr" >/dev/null ||
	fail 'The unsupported architecture returned the wrong error.'

unsupported_format_manifest="$tmp/unsupported-format-manifest.tsv"
cat > "$unsupported_format_manifest" <<'EOF'
# test-only manifest
tar|25.12.5|r33051-f5dae5ece4|x86_64|codec.tar|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|codec.tar
EOF
if sh -s -- "$release_installer_without_main" \
	"$unsupported_format_manifest" \
	>"$tmp/format.stdout" 2>"$tmp/format.stderr" <<'EOF'
set -eu
installer="$1"
manifest="$2"
# shellcheck disable=SC1090
. "$installer"
select_release_codec \
	"$manifest" tar 25.12.5 r33051-f5dae5ece4 x86_64
EOF
then
	fail 'The release installer accepted an unsupported package format.'
fi
grep -F 'Internal error: unsupported package format.' \
	"$tmp/format.stderr" >/dev/null ||
	fail 'The unsupported package format returned the wrong error.'

main_installer="$root/scripts/install-main-apk.sh"
main_installer_without_main="$tmp/install-main-apk.without-main"
sed '$d' "$main_installer" > "$main_installer_without_main"
current_commit="1111111111111111111111111111111111111111"
stale_commit="2222222222222222222222222222222222222222"
sh -s -- "$main_installer_without_main" "$current_commit" <<'EOF'
set -eu
installer="$1"
current_commit="$2"
# shellcheck disable=SC1090
. "$installer"
require_current_snapshot "$current_commit" "$current_commit"
EOF
if sh -s -- \
	"$main_installer_without_main" \
	"$stale_commit" \
	"$current_commit" \
	>"$tmp/stale-main.stdout" 2>"$tmp/stale-main.stderr" <<'EOF'
set -eu
installer="$1"
stale_commit="$2"
current_commit="$3"
# shellcheck disable=SC1090
. "$installer"
require_current_snapshot "$stale_commit" "$current_commit"
EOF
then
	printf '%s\n' 'The current-main installer accepted a stale snapshot.' >&2
	exit 1
fi
grep -F 'The verified APK does not match current main.' \
	"$tmp/stale-main.stderr" >/dev/null || {
	printf '%s\n' 'The current-main installer returned the wrong stale-snapshot error.' >&2
	exit 1
}

initial_freshness_line="$(
	grep -nFx \
		"require_current_snapshot \"\$SOURCE_COMMIT\" \"\$MAIN_COMMIT\"" \
		"$main_installer" |
		awk -F: 'NR == 1 { print $1 }'
)"
final_freshness_line="$(
	grep -nFx \
		"require_current_snapshot \"\$SOURCE_COMMIT\" \"\$FINAL_MAIN_COMMIT\"" \
		"$main_installer" |
		awk -F: 'NR == 1 { print $1 }'
)"
codec_call_line="$(
	grep -nF "if ! /bin/sh \"\$CODEC_INSTALLER_PATH\"; then" "$main_installer" |
		awk -F: 'NR == 1 { print $1 }'
)"
app_install_line="$(
	grep -nFx "install_apk_package \"\$APK_INSTALL_MODE\" \"\$APK_PATH\"" \
		"$main_installer" |
		awk -F: 'NR == 1 { print $1 }'
)"
if [[ ! "$initial_freshness_line" =~ ^[0-9]+$ ]] ||
	[[ ! "$final_freshness_line" =~ ^[0-9]+$ ]] ||
	[[ ! "$codec_call_line" =~ ^[0-9]+$ ]] ||
	[[ ! "$app_install_line" =~ ^[0-9]+$ ]] ||
		((initial_freshness_line >= final_freshness_line)) ||
		((final_freshness_line >= app_install_line)) ||
		((app_install_line >= codec_call_line)); then
	printf '%s\n' \
		'The current-main freshness checks do not guard both installation stages.' >&2
	exit 1
fi
grep -Fx "FINAL_MAIN_COMMIT=\"\$(read_commit_sha \"\$FINAL_MAIN_REF_PATH\")\" ||" \
	"$main_installer" >/dev/null || {
	printf '%s\n' 'The final main check does not read its independently downloaded reference.' >&2
	exit 1
}
for cache_header in 'Cache-Control: no-cache' 'Pragma: no-cache'; do
	cache_header_count="$(grep -Fc "$cache_header" "$main_installer")"
	if [[ "$cache_header_count" != 3 ]]; then
		printf 'The current-main installer does not send %s through every downloader.\n' \
			"$cache_header" >&2
		exit 1
	fi
done

fake_apk_bin="$tmp/fake-apk-bin"
mkdir "$fake_apk_bin"
cat > "$fake_apk_bin/apk" <<'EOF'
#!/bin/sh
set -u
: "${APK_TEST_LOG:?}"
printf '%s\n' "$*" >> "$APK_TEST_LOG"

if [ "$#" -eq 3 ] && [ "$1" = "add" ] &&
	[ "$2" = "--force-reinstall" ] && [ "$3" = "--help" ]; then
	[ "${APK_TEST_FORCE_SUPPORTED:-0}" = "1" ]
	exit
fi
if [ "$#" -eq 3 ] && [ "$1" = "info" ] && [ "$2" = "-e" ] &&
	[ "$3" = "luci-app-videoplayer" ]; then
	case "${APK_TEST_INSTALLED:-0}" in
		0) exit 1 ;;
		1) exit 0 ;;
		*) exit 2 ;;
	esac
fi
if [ "${1:-}" = "add" ]; then
	exit "${APK_TEST_ADD_STATUS:-0}"
fi
exit 99
EOF
chmod 0755 "$fake_apk_bin/apk"

cat > "$tmp/probe-apk-install.sh" <<'EOF'
#!/bin/sh
set -eu
installer="$1"
package_path="$2"
# shellcheck disable=SC1090
. "$installer"
install_mode="$(select_apk_install_mode)"
printf 'mode=%s\n' "$install_mode"
install_apk_package "$install_mode" "$package_path"
printf '%s\n' "completed"
EOF
chmod 0755 "$tmp/probe-apk-install.sh"

test_package_path="/tmp/luci-app-videoplayer-current.apk"
force_log="$tmp/apk-force.log"
force_output="$(
	env PATH="$fake_apk_bin:$PATH" \
		APK_TEST_LOG="$force_log" \
		APK_TEST_FORCE_SUPPORTED="1" \
		APK_TEST_ADD_STATUS="0" \
		sh "$tmp/probe-apk-install.sh" \
		"$main_installer_without_main" "$test_package_path"
)"
mapfile -t force_calls < "$force_log"
if [[ "$force_output" != $'mode=force\ncompleted' ]] ||
	((${#force_calls[@]} != 2)) ||
	[[ "${force_calls[0]:-}" != "add --force-reinstall --help" ]] ||
	[[ "${force_calls[1]:-}" != \
		"add --allow-untrusted --force-reinstall $test_package_path" ]]; then
	printf '%s\n' 'The current-main installer did not force a same-version replacement.' >&2
	exit 1
fi

plain_log="$tmp/apk-plain.log"
plain_output="$(
	env PATH="$fake_apk_bin:$PATH" \
		APK_TEST_LOG="$plain_log" \
		APK_TEST_FORCE_SUPPORTED="0" \
		APK_TEST_INSTALLED="0" \
		APK_TEST_ADD_STATUS="0" \
		sh "$tmp/probe-apk-install.sh" \
		"$main_installer_without_main" "$test_package_path"
)"
mapfile -t plain_calls < "$plain_log"
if [[ "$plain_output" != $'mode=plain\ncompleted' ]] ||
	((${#plain_calls[@]} != 3)) ||
	[[ "${plain_calls[1]:-}" != "info -e luci-app-videoplayer" ]] ||
	[[ "${plain_calls[2]:-}" != "add --allow-untrusted $test_package_path" ]]; then
	printf '%s\n' 'The current-main installer broke first installation on legacy apk.' >&2
	exit 1
fi

installed_log="$tmp/apk-installed.log"
if env PATH="$fake_apk_bin:$PATH" \
	APK_TEST_LOG="$installed_log" \
	APK_TEST_FORCE_SUPPORTED="0" \
	APK_TEST_INSTALLED="1" \
	sh "$tmp/probe-apk-install.sh" \
	"$main_installer_without_main" "$test_package_path" \
	>"$tmp/apk-installed.stdout" 2>"$tmp/apk-installed.stderr"; then
	printf '%s\n' 'The installer accepted unsafe same-version replacement on legacy apk.' >&2
	exit 1
fi
grep -F 'cannot safely reinstall an existing snapshot' \
	"$tmp/apk-installed.stderr" >/dev/null || {
	printf '%s\n' 'The legacy-apk refusal returned the wrong error.' >&2
	exit 1
}
if grep -F 'add --allow-untrusted' "$installed_log" >/dev/null; then
	printf '%s\n' 'The legacy-apk refusal attempted to install the package.' >&2
	exit 1
fi

failed_add_log="$tmp/apk-failed-add.log"
if env PATH="$fake_apk_bin:$PATH" \
	APK_TEST_LOG="$failed_add_log" \
	APK_TEST_FORCE_SUPPORTED="1" \
	APK_TEST_ADD_STATUS="23" \
	sh "$tmp/probe-apk-install.sh" \
	"$main_installer_without_main" "$test_package_path" \
	>"$tmp/apk-failed-add.stdout" 2>"$tmp/apk-failed-add.stderr"; then
	printf '%s\n' 'The installer ignored an apk installation failure.' >&2
	exit 1
fi
if grep -Fx 'completed' "$tmp/apk-failed-add.stdout" >/dev/null; then
	printf '%s\n' 'The installer reported completion after apk failed.' >&2
	exit 1
fi

# These are literal source snippets; their dollar signs must not expand here.
# shellcheck disable=SC2016
release_app_apk_line="$(
	grep -nF \
		'if ! install_apk_package "$APP_INSTALL_MODE" "$APP_PACKAGE_PATH"; then' \
		"$release_installer" | awk -F: 'NR == 1 { print $1 }'
)"
# shellcheck disable=SC2016
release_codec_apk_line="$(
	grep -nF \
		'if ! install_apk_package "$CODEC_INSTALL_MODE" "$CODEC_PACKAGE_PATH"; then' \
		"$release_installer" | awk -F: 'NR == 1 { print $1 }'
)"
# shellcheck disable=SC2016
release_app_ipk_line="$(
	grep -nF \
		'opkg --force-downgrade --force-reinstall install "$APP_PACKAGE_PATH"' \
		"$release_installer" | awk -F: 'NR == 1 { print $1 }'
)"
# shellcheck disable=SC2016
release_codec_ipk_line="$(
	grep -nF \
		'opkg --force-downgrade --force-reinstall install "$CODEC_PACKAGE_PATH"' \
		"$release_installer" | awk -F: 'NR == 1 { print $1 }'
)"
# shellcheck disable=SC2016
mapfile -t release_app_registration_lines < <(
	grep -nFx '		verify_registered_package "$APP_PACKAGE_NAME"' \
		"$release_installer" | awk -F: '{ print $1 }'
)
# shellcheck disable=SC2016
release_codec_registration_line="$(
	grep -nFx 'verify_registered_package "$CODEC_PACKAGE_NAME"' \
		"$release_installer" | awk -F: 'NR == 1 { print $1 }'
)"
release_attestation_line="$(
	grep -nFx 'verify_installed_runtime' "$release_installer" |
		awk -F: 'NR == 1 { print $1 }'
)"
if [[ ! "$release_app_apk_line" =~ ^[0-9]+$ ]] ||
	[[ ! "$release_codec_apk_line" =~ ^[0-9]+$ ]] ||
	[[ ! "$release_app_ipk_line" =~ ^[0-9]+$ ]] ||
	[[ ! "$release_codec_ipk_line" =~ ^[0-9]+$ ]] ||
	((${#release_app_registration_lines[@]} != 2)) ||
	[[ ! "$release_codec_registration_line" =~ ^[0-9]+$ ]] ||
	[[ ! "$release_attestation_line" =~ ^[0-9]+$ ]] ||
	((release_app_apk_line >= release_app_registration_lines[0])) ||
	((release_app_registration_lines[0] >= release_codec_apk_line)) ||
	((release_app_ipk_line >= release_app_registration_lines[1])) ||
	((release_app_registration_lines[1] >= release_codec_ipk_line)) ||
	((release_codec_apk_line >= release_codec_registration_line)) ||
	((release_codec_ipk_line >= release_codec_registration_line)) ||
	((release_codec_registration_line >= release_attestation_line)); then
	fail 'The release installer no longer installs and registers the application before the codec runtime and final attestation.'
fi

release_fake_apk_bin="$tmp/release-fake-apk-bin"
mkdir "$release_fake_apk_bin"
cat > "$release_fake_apk_bin/apk" <<'EOF'
#!/bin/sh
set -u
: "${APK_TEST_LOG:?}"
printf '%s\n' "$*" >> "$APK_TEST_LOG"

if [ "$#" -eq 3 ] && [ "$1" = add ] &&
	[ "$2" = --force-reinstall ] && [ "$3" = --help ]; then
	[ "${APK_TEST_FORCE_SUPPORTED:-0}" = "1" ]
	exit
fi
if [ "$#" -eq 3 ] && [ "$1" = info ] && [ "$2" = -e ]; then
	case ",${APK_TEST_INSTALLED_NAMES:-}," in
		*,"$3",*) exit 0 ;;
		*) exit 1 ;;
	esac
fi
if [ "${1:-}" = add ]; then
	exit "${APK_TEST_ADD_STATUS:-0}"
fi
exit 99
EOF
chmod 0755 "$release_fake_apk_bin/apk"

cat > "$tmp/probe-release-apk-install.sh" <<'EOF'
#!/bin/sh
set -eu
installer="$1"
# shellcheck disable=SC1090
. "$installer"
APK_FORCE_REINSTALL_SUPPORTED="${APK_TEST_FORCE_SUPPORTED:-0}"
app_mode="$(select_apk_install_mode luci-app-videoplayer)"
codec_mode="$(select_apk_install_mode luci-videoplayer-codec-runtime)"
printf 'modes=%s,%s\n' "$app_mode" "$codec_mode"
install_apk_package "$app_mode" /tmp/release-app.apk
install_apk_package "$codec_mode" /tmp/release-codec.apk
printf '%s\n' completed
EOF
chmod 0755 "$tmp/probe-release-apk-install.sh"

release_force_log="$tmp/release-apk-force.log"
release_force_output="$(
	env PATH="$release_fake_apk_bin:$PATH" \
		APK_TEST_LOG="$release_force_log" \
		APK_TEST_FORCE_SUPPORTED=1 \
		sh "$tmp/probe-release-apk-install.sh" \
		"$release_installer_without_main"
)"
mapfile -t release_force_calls < "$release_force_log"
if [[ "$release_force_output" != $'modes=force,force\ncompleted' ]] ||
	((${#release_force_calls[@]} != 2)) ||
	[[ "${release_force_calls[0]:-}" != \
		'add --allow-untrusted --force-reinstall /tmp/release-app.apk' ]] ||
	[[ "${release_force_calls[1]:-}" != \
		'add --allow-untrusted --force-reinstall /tmp/release-codec.apk' ]]; then
	fail 'The release installer does not force-reinstall both APK packages in application-first order.'
fi

release_plain_log="$tmp/release-apk-plain.log"
release_plain_output="$(
	env PATH="$release_fake_apk_bin:$PATH" \
		APK_TEST_LOG="$release_plain_log" \
		APK_TEST_FORCE_SUPPORTED=0 \
		APK_TEST_INSTALLED_NAMES= \
		sh "$tmp/probe-release-apk-install.sh" \
		"$release_installer_without_main"
)"
mapfile -t release_plain_calls < "$release_plain_log"
if [[ "$release_plain_output" != $'modes=plain,plain\ncompleted' ]] ||
	((${#release_plain_calls[@]} != 4)) ||
	[[ "${release_plain_calls[0]:-}" != 'info -e luci-app-videoplayer' ]] ||
	[[ "${release_plain_calls[1]:-}" != \
		'info -e luci-videoplayer-codec-runtime' ]] ||
	[[ "${release_plain_calls[2]:-}" != \
		'add --allow-untrusted /tmp/release-app.apk' ]] ||
	[[ "${release_plain_calls[3]:-}" != \
		'add --allow-untrusted /tmp/release-codec.apk' ]]; then
	fail 'The release installer broke first installation with legacy apk.'
fi

for installed_package in \
	luci-app-videoplayer \
	luci-videoplayer-codec-runtime
do
	installed_package_log="$tmp/release-${installed_package}.log"
	if env PATH="$release_fake_apk_bin:$PATH" \
		APK_TEST_LOG="$installed_package_log" \
		APK_TEST_FORCE_SUPPORTED=0 \
		APK_TEST_INSTALLED_NAMES="$installed_package" \
		sh "$tmp/probe-release-apk-install.sh" \
		"$release_installer_without_main" \
		>"$tmp/release-installed.stdout" \
		2>"$tmp/release-installed.stderr"; then
		fail "The release installer accepted unsafe legacy-apk replacement of $installed_package."
	fi
	grep -F "cannot safely reinstall $installed_package" \
		"$tmp/release-installed.stderr" >/dev/null ||
		fail "The legacy-apk refusal for $installed_package returned the wrong error."
	if grep -F 'add --allow-untrusted' "$installed_package_log" >/dev/null; then
		fail "The legacy-apk refusal attempted to install before rejecting $installed_package."
	fi
done

# `stat` is supplied by the application's coreutils-stat dependency on minimal
# supported OpenWrt images, so the installer must not require it before the
# application transaction. It must require it before installing the codec.
initial_command_loop="$(
	sed -n '/^for required_command in /,/^done$/p' "$release_installer"
)"
if grep -Eq '(^|[[:space:]])stat([[:space:]]|$)' <<<"$initial_command_loop"; then
	fail 'The release installer requires coreutils-stat before dependencies can be installed.'
fi
mapfile -t release_post_app_lines < <(
	grep -nFx $'\t\trequire_post_app_commands' "$release_installer" |
		awk -F: '{ print $1 }'
)
if ((${#release_post_app_lines[@]} != 2)) ||
	((release_post_app_lines[0] <= release_app_registration_lines[0])) ||
	((release_post_app_lines[0] >= release_codec_apk_line)) ||
	((release_post_app_lines[1] <= release_app_registration_lines[1])) ||
	((release_post_app_lines[1] >= release_codec_ipk_line)); then
	fail 'The release installer does not validate coreutils-stat between the application and codec transactions.'
fi

missing_stat_bin="$tmp/release-missing-stat-bin"
mkdir "$missing_stat_bin"
if env PATH="$missing_stat_bin" /bin/sh -s -- \
	"$release_installer_without_main" \
	>"$tmp/missing-stat.stdout" 2>"$tmp/missing-stat.stderr" <<'EOF'
set -eu
installer="$1"
# shellcheck disable=SC1090
. "$installer"
require_post_app_commands
EOF
then
	fail 'The release installer accepted a missing post-application stat dependency.'
fi
grep -F 'did not provide its required coreutils-stat dependency' \
	"$tmp/missing-stat.stderr" >/dev/null ||
	fail 'The missing coreutils-stat dependency returned the wrong error.'
cat > "$missing_stat_bin/stat" <<'EOF'
#!/bin/sh
exit 0
EOF
chmod 0755 "$missing_stat_bin/stat"
env PATH="$missing_stat_bin" /bin/sh -s -- \
	"$release_installer_without_main" <<'EOF'
set -eu
installer="$1"
# shellcheck disable=SC1090
. "$installer"
require_post_app_commands
EOF

for specification in \
	"scripts/install-from-github.sh|Usage: sh install-from-github.sh" \
	"scripts/install-main-apk.sh|Usage: sh install-main-apk.sh" \
	"scripts/install-codec-runtime.sh|Usage: sh install-codec-runtime.sh"
do
	IFS='|' read -r relative_path expected_usage <<< "$specification"
	installer="$root/$relative_path"
	[[ -f "$installer" ]] || {
		printf 'Missing installer: %s\n' "$installer" >&2
		exit 1
	}

	last_statement="$(awk 'NF { statement = $0 } END { print statement }' "$installer")"
	[[ "$last_statement" == 'main "$@"' ]] || {
		printf '%s does not end with its guarded main entry point.\n' \
			"$relative_path" >&2
		exit 1
	}

	byte_count="$(wc -c < "$installer" | tr -d '[:space:]')"
	if [[ ! "$byte_count" =~ ^[0-9]+$ ]] ||
		((byte_count <= 0 || byte_count > 524288)); then
		printf '%s exceeds the one-line bootstrap size limit.\n' \
			"$relative_path" >&2
		exit 1
	fi

	help_output="$(sh -s -- --help < "$installer")"
	grep -F "$expected_usage" <<< "$help_output" >/dev/null || {
		printf '%s did not run correctly from standard input.\n' \
			"$relative_path" >&2
		exit 1
	}

	loaded_installer="$tmp/${relative_path##*/}.without-main"
	sed '$d' "$installer" > "$loaded_installer"
	: > "$tmp/truncated.stdout"
	: > "$tmp/truncated.stderr"
	sh "$loaded_installer" \
		>"$tmp/truncated.stdout" 2>"$tmp/truncated.stderr"
	[[ ! -s "$tmp/truncated.stdout" && ! -s "$tmp/truncated.stderr" ]] || {
		printf '%s performed work without its final entry point.\n' \
			"$relative_path" >&2
		exit 1
	}

	timeout_probe_log="$tmp/${relative_path##*/}.timeout-probe"
	fallback_marker="$tmp/${relative_path##*/}.fallback"
	PATH="$broken_timeout_bin:$PATH" \
		TIMEOUT_PROBE_LOG="$timeout_probe_log" \
		sh "$tmp/probe-timeout-fallback.sh" \
		"$loaded_installer" "$fallback_marker"
	[[ "$(cat "$timeout_probe_log")" == "x" ]] || {
		printf '%s retried an unusable timeout command.\n' \
			"$relative_path" >&2
		exit 1
	}
	[[ "$(cat "$fallback_marker")" == "fallback" ]] || {
		printf '%s did not bypass an unusable timeout command.\n' \
			"$relative_path" >&2
		exit 1
	}

	working_timeout_log="$tmp/${relative_path##*/}.working-timeout"
	deadline_marker="$tmp/${relative_path##*/}.deadline"
	PATH="$working_timeout_bin:$PATH" \
		TIMEOUT_PROBE_LOG="$working_timeout_log" \
		sh "$tmp/probe-working-timeout.sh" \
		"$loaded_installer" "$deadline_marker"
	[[ "$(cat "$working_timeout_log")" == "xx" ]] || {
		printf '%s did not reuse a validated timeout command.\n' \
			"$relative_path" >&2
		exit 1
	}
	[[ "$(cat "$deadline_marker")" == "deadline" ]] || {
		printf '%s did not use a validated timeout command.\n' \
			"$relative_path" >&2
		exit 1
	}

	for first_argument in --help ""; do
		if sh -s -- "$first_argument" unexpected < "$installer" \
			>"$tmp/arguments.stdout" 2>"$tmp/arguments.stderr"; then
			printf '%s accepted extra arguments.\n' "$relative_path" >&2
			exit 1
		fi
		grep -F 'This installer does not accept arguments.' \
			"$tmp/arguments.stderr" >/dev/null || {
			printf '%s returned the wrong extra-argument error.\n' \
				"$relative_path" >&2
			exit 1
		}
	done
done

main_help="$(sh "$root/scripts/install-main-apk.sh" --help)"
printf '%s\n' "$main_help" | grep -Fq 'current main branch first' ||
	fail "current-main installer help does not document app-first ordering"

codec_installer_without_main="$tmp/install-codec-runtime.without-main"
sed '$d' "$root/scripts/install-codec-runtime.sh" \
	> "$codec_installer_without_main"
for action_case in \
	"<|0|upgrade" \
	"<|1|upgrade" \
	"=|0|repair" \
	"=|1|current" \
	">|1|newer"
do
	IFS='|' read -r version_order metadata_matches expected_action \
		<<< "$action_case"
	actual_action="$(
		sh -s -- \
			"$codec_installer_without_main" \
			"$version_order" \
			"$metadata_matches" <<'EOF'
set -eu
installer="$1"
version_order="$2"
metadata_matches="$3"
# shellcheck disable=SC1090
. "$installer"
select_runtime_action "$version_order" "$metadata_matches"
EOF
	)"
	[[ "$actual_action" == "$expected_action" ]] || {
		printf 'Wrong codec action for version=%s metadata=%s: %s\n' \
			"$version_order" "$metadata_matches" "$actual_action" >&2
		exit 1
	}
done
if sh -s -- "$codec_installer_without_main" <<'EOF'
set -eu
installer="$1"
# shellcheck disable=SC1090
. "$installer"
select_runtime_action ">" "0"
EOF
then
	printf '%s\n' \
		'A newer codec runtime with incompatible metadata was accepted.' >&2
	exit 1
fi
if sh -s -- "$codec_installer_without_main" <<'EOF'
set -eu
installer="$1"
# shellcheck disable=SC1090
. "$installer"
select_runtime_action "<" "invalid"
EOF
then
	printf '%s\n' 'Invalid codec metadata state was accepted.' >&2
	exit 1
fi

# Codec packages built before the software-cpu-v1 attestation must turn their
# legacy metadata into a repair action without executing the incomplete binary.
codec_build_info="$tmp/codec-build-info"
codec_ffmpeg="$tmp/codec-ffmpeg"
codec_relay="$tmp/codec-relay"
printf '%s\n' '#!/bin/sh' 'exit 0' > "$codec_ffmpeg"
chmod 0755 "$codec_ffmpeg"
cat > "$codec_build_info" <<'EOF'
openwrt_release=25.12.5
openwrt_revision=r33051-f5dae5ece4
compatible_arch=aarch64_cortex-a53
package_format=apk
EOF
if sh -s -- \
	"$codec_installer_without_main" "$codec_build_info" "$codec_ffmpeg" \
	"$codec_relay" <<'EOF'
set -eu
installer="$1"
build_info="$2"
ffmpeg="$3"
relay="$4"
# shellcheck disable=SC1090
. "$installer"
PRIVATE_BUILD_INFO="$build_info"
PRIVATE_FFMPEG="$ffmpeg"
PRIVATE_RELAY="$relay"
DISTRIB_RELEASE_VALUE=25.12.5
DISTRIB_REVISION_VALUE=r33051-f5dae5ece4
DISTRIB_ARCH_VALUE=aarch64_cortex-a53
PACKAGE_FORMAT=apk
installed_runtime_matches_router
EOF
then
	printf '%s\n' \
		'Legacy same-version codec metadata unexpectedly skipped repair.' >&2
	exit 1
fi
printf '%s\n' 'renderer_profile=software-cpu-v1' >> "$codec_build_info"
if sh -s -- \
	"$codec_installer_without_main" "$codec_build_info" "$codec_ffmpeg" \
	"$codec_relay" <<'EOF'
set -eu
installer="$1"
build_info="$2"
ffmpeg="$3"
relay="$4"
# shellcheck disable=SC1090
. "$installer"
PRIVATE_BUILD_INFO="$build_info"
PRIVATE_FFMPEG="$ffmpeg"
PRIVATE_RELAY="$relay"
DISTRIB_RELEASE_VALUE=25.12.5
DISTRIB_REVISION_VALUE=r33051-f5dae5ece4
DISTRIB_ARCH_VALUE=aarch64_cortex-a53
PACKAGE_FORMAT=apk
installed_runtime_matches_router
EOF
then
	printf '%s\n' \
		'Same-version codec metadata without the MJPEG relay skipped repair.' >&2
	exit 1
fi
printf '%s\n' '#!/bin/sh' 'exit 64' > "$codec_relay"
chmod 0755 "$codec_relay"
printf '%s\n' \
	'format=4' \
	'build_target=test-target' \
	'build_subtarget=test-subtarget' \
	'sdk_sha256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
	'packages_feed_commit=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' \
	'ffmpeg_version=6.1.4' \
	'validation_mode=qemu' \
	'execution_backend=software-cpu-v1' \
	'software_cpu_only=1' \
	'build_patented=y' \
	'network_enabled=n' \
	'avdevice_enabled=n' \
	'swresample_enabled=y' \
	'audio_output=pcm_s16le' \
	'audio_sample_rate=48000' \
	'audio_channels=2' \
	'audio_chunk_frames=48000' \
	'audio_chunk_bytes=192000' \
	"private_binary=$codec_ffmpeg" >> "$codec_build_info"
sh -s -- \
	"$codec_installer_without_main" "$codec_build_info" "$codec_ffmpeg" \
	"$codec_relay" <<'EOF'
set -eu
installer="$1"
build_info="$2"
ffmpeg="$3"
relay="$4"
# shellcheck disable=SC1090
. "$installer"
PRIVATE_BUILD_INFO="$build_info"
PRIVATE_FFMPEG="$ffmpeg"
PRIVATE_RELAY="$relay"
DISTRIB_RELEASE_VALUE=25.12.5
DISTRIB_REVISION_VALUE=r33051-f5dae5ece4
DISTRIB_ARCH_VALUE=aarch64_cortex-a53
PACKAGE_FORMAT=apk
# GitHub-hosted runners execute this fixture as an unprivileged user, while an
# installed OpenWrt package is necessarily root-owned. Narrowly emulate only
# the package manager's ownership result; every unrelated stat call stays real.
stat() {
	if [ "$#" -eq 3 ] && [ "$1" = -c ] && [ "$2" = '%u:%a' ] &&
	   { [ "$3" = "$PRIVATE_BUILD_INFO" ] ||
	     [ "$3" = "$PRIVATE_FFMPEG" ] ||
	     [ "$3" = "$PRIVATE_RELAY" ]; }; then
		case "$3" in
			"$PRIVATE_BUILD_INFO") printf '%s\n' '0:644' ;;
			*) printf '%s\n' '0:755' ;;
		esac
		return 0
	fi
	command stat "$@"
}
installed_runtime_matches_router
[ "$(select_runtime_action = 0)" = repair ]
[ "$(select_runtime_action = 1)" = current ]
EOF

printf '%s\n' "Remote installer entry-point checks passed."
