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

for specification in \
	"scripts/install-from-github.sh|Usage: sh install-from-github.sh" \
	"scripts/install-main-apk.sh|Usage: sh install-main-apk.sh"
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

	: > "$tmp/truncated.stdout"
	: > "$tmp/truncated.stderr"
	sed '$d' "$installer" |
		sh >"$tmp/truncated.stdout" 2>"$tmp/truncated.stderr"
	[[ ! -s "$tmp/truncated.stdout" && ! -s "$tmp/truncated.stderr" ]] || {
		printf '%s performed work without its final entry point.\n' \
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

printf '%s\n' "Remote installer entry-point checks passed."
