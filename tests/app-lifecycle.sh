#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later

set -euo pipefail

root="${1:-$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)}"
[ "$(id -u)" -eq 0 ] || {
	echo 'app-lifecycle-test: run with sudo so root-owned lifecycle state is tested' >&2
	exit 1
}
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT

python3 "$root/scripts/build-packages.py" \
	--output-dir "$tmp/packages" --check-reproducible >/dev/null
python3 "$root/scripts/build-packages.py" \
	--output-dir "$tmp/packages" --verify-only >/dev/null

python3 - "$root" "$tmp" <<'PY'
import hashlib
import importlib.util
import sys
from pathlib import Path

root = Path(sys.argv[1])
target = Path(sys.argv[2])
spec = importlib.util.spec_from_file_location(
    "app_package_builder", root / "scripts/build-packages.py"
)
assert spec is not None and spec.loader is not None
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)

paths = {
    builder.RENDERER_HELPER: target / "renderer",
    builder.RENDERER_RUNTIME: target / "runtime",
    builder.RENDERER_CONTROL_LOCK: target / "control.lock",
    builder.RENDERER_WORKER_LOCK: target / "worker.lock",
    builder.RENDERER_MAINTENANCE: target / "maintenance",
    builder.RENDERER_LEGACY_BACKUP: target / "legacy-backup",
    builder.RENDERER_PRIVATE_FFMPEG: target / "private-ffmpeg",
}

def relocate(script: str) -> str:
    for source, destination in sorted(paths.items(), key=lambda item: -len(item[0])):
        script = script.replace(source, str(destination))
    return script

for name, body in (
    ("preinst", builder.preinst_script()),
    ("prerm", builder.prerm_script()),
    ("preupgrade", builder.preupgrade_script()),
):
    (target / name).write_text(relocate(body.decode()), encoding="utf-8", newline="\n")

harness = relocate(builder.renderer_maintenance_shell())
(target / "resume").write_text(
    "#!/bin/sh\n" + harness + "\nrenderer_resume_after_change\n",
    encoding="utf-8",
    newline="\n",
)

legacy = target / "legacy-fixture"
legacy.write_text(
    """#!/bin/sh
set -eu
[ "${1:-}" = cleanup ] || exit 2
exec 9< "__CONTROL_LOCK__"
flock -x 9
rm -rf -- "__RUNTIME__"
printf 'legacy-cleanup\\n' >> "__LOG__"
""".replace("__CONTROL_LOCK__", str(paths[builder.RENDERER_CONTROL_LOCK]))
    .replace("__RUNTIME__", str(paths[builder.RENDERER_RUNTIME]))
    .replace("__LOG__", str(target / "legacy.log")),
    encoding="utf-8",
    newline="\n",
)
legacy.chmod(0o755)
legacy_sha = hashlib.sha256(legacy.read_bytes()).hexdigest()
for name in ("preinst", "prerm", "preupgrade"):
    path = target / name
    text = path.read_text(encoding="utf-8")
    original_hashes = "|".join(builder.RENDERER_LEGACY_SHA256)
    text = text.replace(
        f'renderer_legacy_hashes="{original_hashes}"',
        f'renderer_legacy_hashes="{legacy_sha}"',
    )
    path.write_text(text, encoding="utf-8", newline="\n")
PY

chmod 0755 "$tmp"/preinst "$tmp"/prerm \
	"$tmp"/preupgrade "$tmp"/resume

run_case() {
	name="$1"
	script="$2"
	expected="$3"
	set +e
	IPKG_INSTROOT="${IPKG_INSTROOT:-}" timeout 35 sh "$script" \
		>"$tmp/$name.out" 2>"$tmp/$name.err"
	status=$?
	set -e
	if [ "$expected" = success ]; then
		[ "$status" -eq 0 ] || {
			cat "$tmp/$name.err" >&2
			echo "$name unexpectedly failed (rc=$status)" >&2
			exit 1
		}
	else
		[ "$status" -ne 0 ] || {
			echo "$name unexpectedly succeeded" >&2
			exit 1
		}
	fi
}

assert_marker() {
	[ -f "$tmp/maintenance" ] && [ ! -L "$tmp/maintenance" ]
	[ "$(stat -c '%u:%a:%s' "$tmp/maintenance")" = "0:600:15" ]
	[ "$(cat "$tmp/maintenance")" = maintenance-v1 ]
}

assert_lock() {
	[ -f "$1" ] && [ ! -L "$1" ]
	[ "$(stat -c '%u:%a' "$1")" = "0:600" ]
}

write_strict_helper() {
	cat >"$tmp/renderer" <<EOF
#!/bin/sh
set -eu
marker="$tmp/maintenance"
case "\${1:-}" in
	maintenance-enter)
		[ -f "\$marker" ] || printf 'maintenance-v1\\n' > "\$marker"
		chmod 0600 "\$marker"
		printf 'maintenance\\n'
		;;
	cleanup)
		[ "\$(cat "\$marker")" = maintenance-v1 ]
		printf 'cleanup\\n' >> "$tmp/strict.log"
		rm -rf -- "$tmp/runtime"
		;;
	maintenance-exit)
		[ "\$(cat "\$marker")" = maintenance-v1 ]
		rm -f -- "\$marker"
		printf 'resumed\\n'
		;;
	*) exit 2 ;;
esac
EOF
	chmod 0755 "$tmp/renderer"
}

# Fresh install publishes the gate before a helper exists and preserves both
# lock inodes across every later package transaction.
run_case fresh-preinstall "$tmp/preinst" success
assert_marker
assert_lock "$tmp/control.lock"
assert_lock "$tmp/worker.lock"
write_strict_helper
run_case fresh-resume "$tmp/resume" success
[ ! -e "$tmp/maintenance" ] && [ ! -L "$tmp/maintenance" ]

run_case strict-preinstall "$tmp/preinst" success
assert_marker
run_case strict-preinstall-retry "$tmp/preinst" success
assert_marker
run_case strict-resume "$tmp/resume" success
run_case strict-preremove "$tmp/prerm" success
assert_marker
rm -f "$tmp/renderer"
assert_marker
assert_lock "$tmp/control.lock"
assert_lock "$tmp/worker.lock"

# Legacy migration must not deadlock when old cleanup takes the same flock, and
# must also work when neither renderer lock existed before the transaction.
cp "$tmp/legacy-fixture" "$tmp/renderer"
chmod 0755 "$tmp/renderer"
rm -f "$tmp/maintenance" "$tmp/control.lock" "$tmp/worker.lock"
mkdir "$tmp/runtime"
run_case legacy-migration "$tmp/preupgrade" success
assert_marker
assert_lock "$tmp/control.lock"
assert_lock "$tmp/worker.lock"
[ -x "$tmp/legacy-backup" ]
[ "$(wc -l <"$tmp/legacy.log")" -eq 1 ]
write_strict_helper
run_case legacy-resume "$tmp/resume" success
[ ! -e "$tmp/legacy-backup" ] && [ ! -L "$tmp/legacy-backup" ]

printf '%s\n' '#!/bin/sh' 'exit 73' >"$tmp/renderer"
chmod 0755 "$tmp/renderer"
run_case unknown-helper "$tmp/preinst" failure

rm -f "$tmp/renderer"
cat >"$tmp/target" <<EOF
#!/bin/sh
printf 'executed\\n' > "$tmp/symlink-executed"
exit 0
EOF
chmod 0755 "$tmp/target"
ln -s "$tmp/target" "$tmp/renderer"
run_case symlink "$tmp/preinst" failure
[ ! -e "$tmp/symlink-executed" ]

rm -f "$tmp/renderer"
cat >"$tmp/renderer" <<EOF
#!/bin/sh
case "\${1:-}" in
	maintenance-enter) printf 'maintenance-v1\\n' > "$tmp/maintenance"; chmod 0600 "$tmp/maintenance"; printf 'maintenance\\n' ;;
	cleanup) exit 74 ;;
	*) exit 2 ;;
esac
EOF
chmod 0755 "$tmp/renderer"
run_case cleanup-failure "$tmp/preinst" failure
assert_marker

cat >"$tmp/renderer" <<EOF
#!/bin/sh
case "\${1:-}" in
	maintenance-enter) printf 'maintenance-v1\\n' > "$tmp/maintenance"; chmod 0600 "$tmp/maintenance"; printf 'maintenance\\n\\n' ;;
	cleanup) exit 0 ;;
	*) exit 2 ;;
esac
EOF
chmod 0755 "$tmp/renderer"
run_case nonexact-enter-ack "$tmp/preinst" failure
assert_marker

cat >"$tmp/renderer" <<EOF
#!/bin/sh
case "\${1:-}" in
	maintenance-enter) printf 'maintenance-v1\\n' > "$tmp/maintenance"; chmod 0600 "$tmp/maintenance"; printf 'maintenance\\n' ;;
	cleanup) exit 0 ;;
	maintenance-exit) printf 'resumed\\n\\n'; rm -f "$tmp/maintenance" ;;
	*) exit 2 ;;
esac
EOF
chmod 0755 "$tmp/renderer"
run_case nonexact-exit-ack "$tmp/resume" failure

IPKG_INSTROOT=/offline run_case offline-root "$tmp/preinst" success

makefile="$root/luci-app-videoplayer/Makefile"
for hook in preinst postinst prerm postrm; do
	grep -Fq "define Package/luci-app-videoplayer/$hook" "$makefile"
done
grep -Fq 'maintenance-enter' "$makefile"
grep -Fq 'maintenance-exit' "$makefile"
grep -Fq "option router_max_threads '0'" \
	"$root/luci-app-videoplayer/root/etc/config/videoplayer"
grep -Fq 'ensure_option router_max_threads 0' \
	"$root/luci-app-videoplayer/root/etc/uci-defaults/80_luci-videoplayer"
if grep -Eq 'videoplayer-renderer cleanup.*\|\| true|rm -f /tmp/videoplayer-render-v1(\.worker)?\.lock|flock .* -w' \
	"$makefile" "$root/luci-app-videoplayer/root/etc/uci-defaults/80_luci-videoplayer"
then
	echo 'official package lifecycle bypasses or destroys renderer maintenance' >&2
	exit 1
fi

dev_installer="$root/scripts/install-to-router.sh"
[ "$(grep -Fc 'enter_renderer_maintenance() {' "$dev_installer")" -eq 2 ]
grep -Fq 'resume_renderer_after_change() {' "$dev_installer"
if grep -Eq 'videoplayer-renderer cleanup.*\|\| true|rm -f /tmp/videoplayer-render-v1(\.worker)?\.lock|flock .* -w' \
	"$dev_installer"
then
	echo 'development installer bypasses or destroys renderer maintenance' >&2
	exit 1
fi

printf '%s\n' 'app-lifecycle-test: ok'
