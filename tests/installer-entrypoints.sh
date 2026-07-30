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
			app_install_marker="printf 'Installing %s with apk..."
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

printf '%s\n' "Remote installer entry-point checks passed."
