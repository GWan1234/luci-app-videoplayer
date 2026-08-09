#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later

set -euo pipefail

if [[ $# -ne 1 ]]; then
	printf 'Usage: %s REPOSITORY_ROOT\n' "$0" >&2
	exit 2
fi

root="$1"
tmp="$(mktemp -d)"
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
	grep -E '^\(set -eu; installer=' "$root/README.md"
)
if ((${#bootstrap_commands[@]} != 2)); then
	printf 'README.md must contain exactly two one-line app installers.\n' >&2
	exit 1
fi
for bootstrap_command in "${bootstrap_commands[@]}"; do
	sh -n -c "$bootstrap_command"
done

codec_installer_sha="$(
	sha256sum "$root/scripts/install-codec-runtime.sh" |
		awk '{ print $1 }'
)"
for app_installer in \
	scripts/install-from-github.sh \
	scripts/install-main-apk.sh
do
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
	case "$app_installer" in
		scripts/install-from-github.sh)
			app_install_marker="printf 'Installing %s with %s..."
			;;
		scripts/install-main-apk.sh)
			app_install_marker="install_apk_package \"\$APK_INSTALL_MODE\" \"\$APK_PATH\""
			;;
	esac
	app_install_line="$(
		grep -nF "$app_install_marker" "$root/$app_installer" |
			awk -F: 'NR == 1 { print $1 }'
	)"
	if [[ ! "$codec_call_line" =~ ^[0-9]+$ ]] ||
		[[ ! "$app_install_line" =~ ^[0-9]+$ ]] ||
		((codec_call_line >= app_install_line)); then
		printf '%s does not install FFmpeg before the application package.\n' \
			"$app_installer" >&2
		exit 1
	fi
done

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
	((initial_freshness_line >= codec_call_line)) ||
	((final_freshness_line <= codec_call_line)) ||
	((final_freshness_line >= app_install_line)); then
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

# Same-version codec packages built before the unified tee/apad renderer have
# the same r3 package version. The capability profile must turn that legacy
# metadata into a repair action without executing the incomplete binary.
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
printf '%s\n' 'renderer_profile=buffered-tee-v1' >> "$codec_build_info"
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
	   [ "$3" = "$PRIVATE_RELAY" ]; then
		printf '%s\n' '0:755'
		return 0
	fi
	command stat "$@"
}
installed_runtime_matches_router
[ "$(select_runtime_action = 0)" = repair ]
[ "$(select_runtime_action = 1)" = current ]
EOF

printf '%s\n' "Remote installer entry-point checks passed."
