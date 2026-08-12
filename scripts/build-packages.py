#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""
Build installable OpenWrt packages for luci-app-videoplayer:

  - .ipk  - opkg (OpenWrt 24.10 and compatible opkg releases)
  - .apk  - apk v3 / ADB (OpenWrt 25.12+, snapshots)

Architecture-independent (noarch/all): works on any router CPU.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import os
import re
import stat
import struct
import tarfile
import tempfile
import zlib
from collections import defaultdict
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[1]
PKG_DIR = ROOT / "luci-app-videoplayer"
DEFAULT_DIST = ROOT / ".staging" / "app"

PKG_NAME = "luci-app-videoplayer"
PKG_VERSION = "1.2.0"
PKG_DESC = "LuCI video player with browser and strict router CPU rendering"
PKG_LICENSE = "GPL-2.0-or-later"
PKG_MAINTAINER = "openwrt-video-player contributors"
PKG_URL = "https://github.com/communism420/luci-app-videoplayer"
PKG_ARCH_IPK = "all"
PKG_ARCH_APK = "noarch"
DEPENDS = [
    "luci-base",
    "uhttpd",
    "jshn",
    "coreutils-stat",
    "coreutils-timeout",
]
CONFFILES = ["/etc/config/videoplayer"]
REQUIRED_PACKAGE_FILES = {
    "etc/config/videoplayer",
    "etc/uci-defaults/80_luci-videoplayer",
    "usr/libexec/rpcd/luci.videoplayer",
    "usr/libexec/videoplayer-renderer",
    "usr/share/luci/menu.d/luci-app-videoplayer.json",
    "usr/share/rpcd/acl.d/luci-app-videoplayer.json",
    "www/cgi-bin/videoplayer-stream",
    "www/cgi-bin/videoplayer-frame",
    "www/cgi-bin/videoplayer-audio",
    "www/luci-static/resources/view/videoplayer/main.js",
}

MODE_DIR = 0o755
MODE_FILE = 0o644
MODE_EXEC = 0o755
APK_UID_SIZE = 20
MAX_SOURCE_TREE_ENTRIES = 1024
MAX_PACKAGE_FILES = 256
MAX_SOURCE_FILE_BYTES = 24 * 1024 * 1024
MAX_SOURCE_PAYLOAD_BYTES = 24 * 1024 * 1024
MAX_DATA_TAR_MEMBERS = 256
MAX_BUILT_PACKAGE_BYTES = 32 * 1024 * 1024

RENDERER_HELPER = "/usr/libexec/videoplayer-renderer"
RENDERER_RUNTIME = "/tmp/videoplayer-render-v1"
RENDERER_CONTROL_LOCK = "/tmp/videoplayer-render-v1.lock"
RENDERER_WORKER_LOCK = "/tmp/videoplayer-render-v1.worker.lock"
RENDERER_MAINTENANCE = "/tmp/videoplayer-render-v1.maintenance"
RENDERER_LEGACY_BACKUP = "/usr/libexec/.videoplayer-renderer.legacy-v1"
RENDERER_PRIVATE_FFMPEG = "/usr/libexec/videoplayer-ffmpeg/ffmpeg"
RENDERER_MAINTENANCE_LAYOUT = "maintenance-v1"
RENDERER_GATE_SHA256 = (
    "0b727bf9b8d5f7a092f3a20e6b632323667e554c10bf9e7fbaadcc0818fbe30c"
)
# Canonical renderer helpers published before the strict maintenance protocol.
# An unknown executable is never migrated or invoked with legacy semantics.
RENDERER_LEGACY_SHA256 = (
    "4feefb96c192aabddb4937e0c844e61af2c526cc0fd6a816c43733b701431da1",
    "84b24fc3c96bb8588d8d7d3750e0d152290398a48b4401cd3c9c6704745b16f7",
    "51079dcddfe92a904bd44c5b82075ca31bc88a1b3224c68c3d145b1e6693cd5b",
    "5d3d64435b4967547bd6e8cefa587acbcf536951da7d6f305d4f29db57ea6579",
    "032741dea0d77f76ddd81c0c37fd056fb96796afd267799d590eba1566c94b52",
    "4ef4fa6870423c1ffbdc53412bf25b3a6691d82b162a7b47efca75ce4c251e16",
    "b13921f99df6888c2689d7f6d2b47d5df3bde0693294bb406cf950a0f94340e6",
    "39641754d2de11e336d675171d2de79c872acadd01622d2aa7eb5e29a71cf235",
    "94c496a0f68271af8db299dfbbe91ea5c3954e875eec7f0d6c43e49df2bbfd62",
    "e000524117e4786c87d720d64ae7165fdb57115eb32c0d4eb6d83267ecf7f426",
)


class PackageBuildError(RuntimeError):
    """Raised when package construction or verification fails."""


def validate_source_metadata() -> None:
    """Fail early if the OpenWrt and standalone package manifests drift apart."""
    makefile_path = PKG_DIR / "Makefile"
    try:
        makefile = read_source_file(makefile_path, 1024 * 1024).decode("utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        raise PackageBuildError(f"Cannot read package Makefile: {exc}") from exc

    version_match = re.search(r"^PKG_VERSION:=(\S+)\s*$", makefile, re.MULTILINE)
    release_match = re.search(r"^PKG_RELEASE:=(.*)$", makefile, re.MULTILINE)
    depends_match = re.search(r"^LUCI_DEPENDS:=(.*)$", makefile, re.MULTILINE)
    if not version_match or not release_match or not depends_match:
        raise PackageBuildError("Makefile package metadata is incomplete")

    makefile_depends = {
        token.removeprefix("+")
        for token in depends_match.group(1).split()
        if token.startswith("+")
    }
    if version_match.group(1) != PKG_VERSION:
        raise PackageBuildError(
            f"Makefile version {version_match.group(1)!r} does not match "
            f"builder version {PKG_VERSION!r}"
        )
    if release_match.group(1).strip():
        raise PackageBuildError("PKG_RELEASE must stay empty for a suffix-free version")
    if makefile_depends != set(DEPENDS):
        raise PackageBuildError(
            "Makefile dependencies do not match the standalone builder: "
            f"{sorted(makefile_depends)!r} != {sorted(DEPENDS)!r}"
        )

    try:
        import verify_packages as verifier
    except ImportError as exc:
        raise PackageBuildError(
            "Cannot import scripts/verify_packages.py"
        ) from exc

    verifier_values = {
        "version": (verifier.PKG_VERSION, PKG_VERSION),
        "IPK architecture": (verifier.PKG_ARCH_IPK, PKG_ARCH_IPK),
        "APK architecture": (verifier.PKG_ARCH_APK, PKG_ARCH_APK),
        "license": (verifier.PKG_LICENSE, PKG_LICENSE),
        "description": (verifier.PKG_DESCRIPTION, PKG_DESC),
        "maintainer": (verifier.PKG_MAINTAINER, PKG_MAINTAINER),
        "URL": (verifier.PKG_URL, PKG_URL),
        "dependencies": (set(verifier.DEPENDENCIES), set(DEPENDS)),
        "conffiles": (set(verifier.CONFFILES), set(CONFFILES)),
        "required files": (
            set(verifier.REQUIRED_PACKAGE_FILES),
            set(REQUIRED_PACKAGE_FILES),
        ),
    }
    for label, (actual, expected) in verifier_values.items():
        if actual != expected:
            raise PackageBuildError(
                f"Verifier {label} metadata does not match the builder: "
                f"{actual!r} != {expected!r}"
            )

    extension_sources = (
        PKG_DIR / "root/usr/libexec/rpcd/luci.videoplayer",
        PKG_DIR / "root/www/cgi-bin/videoplayer-stream",
    )
    extension_values: list[tuple[Path, str]] = []
    for source in extension_sources:
        try:
            text = read_source_file(source, 1024 * 1024).decode("utf-8")
        except (OSError, UnicodeDecodeError) as exc:
            raise PackageBuildError(
                f"Cannot read extension manifest from {source}: {exc}"
            ) from exc
        match = re.search(r'^VIDEO_EXTS="([^"]+)"\s*$', text, re.MULTILINE)
        if not match:
            raise PackageBuildError(f"VIDEO_EXTS is missing from {source}")
        extension_values.append((source, match.group(1)))

    if extension_values[0][1] != extension_values[1][1]:
        raise PackageBuildError(
            "RPC and streaming backends have different VIDEO_EXTS manifests"
        )


def read_source_file(path: Path, remaining_payload_bytes: int) -> bytes:
    """Read one regular source file without following links or growing unbounded."""
    if path.is_symlink():
        raise PackageBuildError(f"Package source must not be a symlink: {path}")

    limit = min(MAX_SOURCE_FILE_BYTES, max(remaining_payload_bytes, 0))
    try:
        with path.open("rb") as stream:
            before = os.fstat(stream.fileno())
            if not stat.S_ISREG(before.st_mode):
                raise PackageBuildError(
                    f"Package source is not a regular file: {path}"
                )
            if before.st_size > MAX_SOURCE_FILE_BYTES:
                raise PackageBuildError(
                    f"Package source exceeds the {MAX_SOURCE_FILE_BYTES}-byte "
                    f"per-file limit: {path}"
                )
            if before.st_size > remaining_payload_bytes:
                raise PackageBuildError(
                    f"Package sources exceed the {MAX_SOURCE_PAYLOAD_BYTES}-byte "
                    "payload limit"
                )

            data = stream.read(limit + 1)
            if len(data) > limit:
                raise PackageBuildError(
                    f"Package source grew beyond its safety limit: {path}"
                )
            if stream.read(1):
                raise PackageBuildError(
                    f"Package source grew while it was being read: {path}"
                )
            after = os.fstat(stream.fileno())
    except PackageBuildError:
        raise
    except OSError as exc:
        raise PackageBuildError(f"Cannot read package source {path}: {exc}") from exc

    if (
        before.st_dev,
        before.st_ino,
        before.st_size,
        before.st_mtime_ns,
    ) != (
        after.st_dev,
        after.st_ino,
        after.st_size,
        after.st_mtime_ns,
    ) or len(data) != after.st_size:
        raise PackageBuildError(f"Package source changed while being read: {path}")
    if path.is_symlink():
        raise PackageBuildError(f"Package source became a symlink: {path}")
    return data


def archive_directory_paths(paths: list[str]) -> set[str]:
    directories = {"."}
    for name in paths:
        parent = PurePosixPath(name).parent
        while parent.as_posix() != ".":
            directories.add(parent.as_posix())
            parent = parent.parent
    return directories


# ── collect package files ─────────────────────────────────────────────

def collect_files() -> list[tuple[str, Path, int]]:
    """Return list of (install_path_no_leading_slash, source_path, mode)."""
    files: list[tuple[str, Path, int]] = []
    source_entries = 0
    source_bytes = 0

    mapping = [
        # (source relative to PKG_DIR, install dir, mode for files)
        (PKG_DIR / "root", "", None),
        (PKG_DIR / "htdocs", "www", None),
    ]

    for src_root, prefix, _ in mapping:
        if src_root.is_symlink():
            raise PackageBuildError(
                f"Package source root must not be a symlink: {src_root}"
            )
        if not src_root.is_dir():
            continue
        for path in src_root.rglob("*"):
            source_entries += 1
            if source_entries > MAX_SOURCE_TREE_ENTRIES:
                raise PackageBuildError(
                    "Package source tree contains more than "
                    f"{MAX_SOURCE_TREE_ENTRIES} entries"
                )
            if path.is_symlink():
                raise PackageBuildError(
                    f"Package source tree contains a symlink: {path}"
                )
            try:
                path_stat = path.stat()
            except OSError as exc:
                raise PackageBuildError(
                    f"Cannot inspect package source {path}: {exc}"
                ) from exc
            if stat.S_ISDIR(path_stat.st_mode):
                continue
            if not stat.S_ISREG(path_stat.st_mode):
                raise PackageBuildError(
                    f"Package source is not a regular file: {path}"
                )
            if len(files) >= MAX_PACKAGE_FILES:
                raise PackageBuildError(
                    f"Package source tree contains more than {MAX_PACKAGE_FILES} files"
                )
            if path_stat.st_size > MAX_SOURCE_FILE_BYTES:
                raise PackageBuildError(
                    f"Package source exceeds the {MAX_SOURCE_FILE_BYTES}-byte "
                    f"per-file limit: {path}"
                )
            source_bytes += path_stat.st_size
            if source_bytes > MAX_SOURCE_PAYLOAD_BYTES:
                raise PackageBuildError(
                    f"Package sources exceed the {MAX_SOURCE_PAYLOAD_BYTES}-byte "
                    "payload limit"
                )

            rel = path.relative_to(src_root).as_posix()
            install = f"{prefix}/{rel}" if prefix else rel
            install = install.lstrip("/")

            mode = MODE_FILE
            if path.suffix == "" and (
                "cgi-bin" in install
                or "/rpcd/" in install
                or install.startswith("usr/libexec/")
                or "uci-defaults" in install
            ):
                mode = MODE_EXEC
            # shell scripts without extension
            if path.name in (
                "videoplayer-stream",
                "videoplayer-frame",
                "videoplayer-audio",
                "videoplayer-renderer",
                "luci.videoplayer",
            ) or "uci-defaults" in install:
                mode = MODE_EXEC

            files.append((install, path, mode))

    # Ensure executables
    out: list[tuple[str, Path, int]] = []
    for install, path, mode in files:
        if install.endswith(
            (
                "videoplayer-stream",
                "videoplayer-frame",
                "videoplayer-audio",
                "videoplayer-renderer",
                "luci.videoplayer",
            )
        ):
            mode = MODE_EXEC
        if "/uci-defaults/" in install or install.startswith("etc/uci-defaults/"):
            mode = MODE_EXEC
        out.append((install, path, mode))
    out.sort(key=lambda item: item[0].encode("utf-8"))

    if not out:
        raise PackageBuildError(f"No package files found under {PKG_DIR}")
    install_paths = [install for install, _, _ in out]
    if len(install_paths) != len(set(install_paths)):
        raise PackageBuildError("Package sources contain duplicate install paths")
    missing = REQUIRED_PACKAGE_FILES.difference(install_paths)
    if missing:
        raise PackageBuildError(
            "Package sources are incomplete: " + ", ".join(sorted(missing))
        )
    data_member_count = len(out) + len(archive_directory_paths(install_paths))
    if data_member_count > MAX_DATA_TAR_MEMBERS:
        raise PackageBuildError(
            "Package data archive would contain more than "
            f"{MAX_DATA_TAR_MEMBERS} file and directory members"
        )
    return out


def build_file_list_content(files: list[tuple[str, Path, int]]) -> bytes:
    lines = [f"/{p}" for p, _, _ in sorted(files, key=lambda x: x[0])]
    return ("\n".join(lines) + "\n").encode("utf-8")


def renderer_maintenance_shell() -> str:
    legacy_hashes = "|".join(RENDERER_LEGACY_SHA256)
    return f"""renderer_helper=\"{RENDERER_HELPER}\"
renderer_runtime=\"{RENDERER_RUNTIME}\"
renderer_control_lock=\"{RENDERER_CONTROL_LOCK}\"
renderer_worker_lock=\"{RENDERER_WORKER_LOCK}\"
renderer_maintenance=\"{RENDERER_MAINTENANCE}\"
renderer_legacy_backup=\"{RENDERER_LEGACY_BACKUP}\"
renderer_private_ffmpeg=\"{RENDERER_PRIVATE_FFMPEG}\"
renderer_gate_sha256=\"{RENDERER_GATE_SHA256}\"
renderer_legacy_hashes=\"{legacy_hashes}\"

safe_root_executable() {{
	[ -f \"$1\" ] && [ ! -L \"$1\" ] && [ -x \"$1\" ] &&
		[ \"$(readlink -f -- \"$1\" 2>/dev/null)\" = \"$1\" ] &&
		[ \"$(stat -c '%u:%a' -- \"$1\" 2>/dev/null)\" = \"0:755\" ]
}}

ensure_renderer_lock() {{
	lock_path=\"$1\"
	if [ ! -e \"$lock_path\" ] && [ ! -L \"$lock_path\" ]; then
		(umask 077; set -C; : > \"$lock_path\") 2>/dev/null || :
	fi
	[ -f \"$lock_path\" ] && [ ! -L \"$lock_path\" ] &&
		[ \"$(readlink -f -- \"$lock_path\" 2>/dev/null)\" = \"$lock_path\" ] || return 1
	chmod 0600 \"$lock_path\" 2>/dev/null || return 1
	[ \"$(stat -c '%u:%a' -- \"$lock_path\" 2>/dev/null)\" = \"0:600\" ]
}}

lock_renderer_fd() {{
	lock_fd=\"$1\"
	lock_round=0
	while ! flock -xn \"$lock_fd\" 2>/dev/null; do
		lock_round=$((lock_round + 1))
		[ \"$lock_round\" -lt 15 ] || return 1
		sleep 1
	done
}}

maintenance_marker_state() {{
	[ -e \"$renderer_maintenance\" ] || [ -L \"$renderer_maintenance\" ] || return 1
	[ -f \"$renderer_maintenance\" ] && [ ! -L \"$renderer_maintenance\" ] &&
		[ \"$(readlink -f -- \"$renderer_maintenance\" 2>/dev/null)\" = \"$renderer_maintenance\" ] &&
		[ \"$(stat -c '%u:%a:%s' -- \"$renderer_maintenance\" 2>/dev/null)\" = \"0:600:15\" ] &&
		[ \"$(cat \"$renderer_maintenance\" 2>/dev/null)\" = \"{RENDERER_MAINTENANCE_LAYOUT}\" ] || return 2
	return 0
}}

create_maintenance_marker() {{
	state=0
	maintenance_marker_state || state=$?
	case \"$state\" in
		0) return 0 ;;
		1) ;;
		*) return 1 ;;
	esac
	(umask 077; set -C; printf '%s\\n' '{RENDERER_MAINTENANCE_LAYOUT}' > \"$renderer_maintenance\") 2>/dev/null || {{
		maintenance_marker_state
		return
	}}
	chmod 0600 \"$renderer_maintenance\" 2>/dev/null && maintenance_marker_state
}}

renderer_process_is_related() {{
	process_pid=\"$1\"
	[ -r \"/proc/$process_pid/status\" ] && [ -r \"/proc/$process_pid/cmdline\" ] || return 1
	[ \"$(sed -n 's/^Uid:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p' \"/proc/$process_pid/status\" 2>/dev/null)\" = 0 ] || return 1
	process_exe=\"$(readlink -f -- \"/proc/$process_pid/exe\" 2>/dev/null)\" || process_exe=\"\"
	[ \"$process_exe\" = \"$renderer_private_ffmpeg\" ] && return 0
	process_cmdline=\"$(tr '\\000' '\\n' < \"/proc/$process_pid/cmdline\" 2>/dev/null)\" || return 1
	printf '%s\\n' \"$process_cmdline\" | grep -Fqx \"$renderer_helper\" && return 0
	printf '%s\\n' \"$process_cmdline\" | grep -Fqx \"$renderer_legacy_backup\" && return 0
	case \"$process_cmdline\" in
		*\"$renderer_runtime/\"*) return 0 ;;
	esac
	return 1
}}

renderer_related_pids() {{
	for process_dir in /proc/[0-9]*; do
		process_pid=${{process_dir##*/}}
		[ \"$process_pid\" = \"$$\" ] && continue
		renderer_process_is_related \"$process_pid\" && printf '%s\\n' \"$process_pid\"
	done
}}

terminate_renderer_processes() {{
	for signal in TERM KILL; do
		processes=\"$(renderer_related_pids)\"
		[ -n \"$processes\" ] || return 0
		for process_pid in $processes; do
			kill -\"$signal\" \"$process_pid\" 2>/dev/null || :
		done
		for wait_round in 1 2 3 4 5; do
			sleep 1
			[ -z \"$(renderer_related_pids)\" ] && return 0
		done
	done
	[ -z \"$(renderer_related_pids)\" ]
}}

legacy_helper_hash_is_allowed() {{
	case \"|$renderer_legacy_hashes|\" in
		*\"|$1|\"*) return 0 ;;
	esac
	return 1
}}

install_renderer_gate() {{
	gate_tmp=\"${{renderer_helper}}.gate.$$\"
	rm -f -- \"$gate_tmp\" 2>/dev/null || return 1
	(
		umask 077
		set -C
		printf '%s\\n' '#!/bin/sh' \
			\"printf '%s\\n' 'Renderer maintenance migration is active' >&2\" \
			'exit 1' > \"$gate_tmp\"
	) 2>/dev/null || return 1
	chmod 0755 \"$gate_tmp\" || return 1
	[ \"$(sha256sum \"$gate_tmp\" | awk '{{print $1}}')\" = \"$renderer_gate_sha256\" ] || return 1
	mv -f -- \"$gate_tmp\" \"$renderer_helper\" || return 1
	safe_root_executable \"$renderer_helper\" &&
		[ \"$(sha256sum \"$renderer_helper\" | awk '{{print $1}}')\" = \"$renderer_gate_sha256\" ]
}}

renderer_enter_legacy() {{
	if [ -e \"$renderer_legacy_backup\" ] || [ -L \"$renderer_legacy_backup\" ]; then
		safe_root_executable \"$renderer_legacy_backup\" || return 1
		legacy_sha=\"$(sha256sum \"$renderer_legacy_backup\" | awk '{{print $1}}')\"
		legacy_helper_hash_is_allowed \"$legacy_sha\" || return 2
		if [ ! -e \"$renderer_helper\" ] && [ ! -L \"$renderer_helper\" ]; then
			install_renderer_gate || return 1
		else
			safe_root_executable \"$renderer_helper\" || return 1
			[ \"$(sha256sum \"$renderer_helper\" | awk '{{print $1}}')\" = \"$renderer_gate_sha256\" ] || return 1
		fi
	else
		safe_root_executable \"$renderer_helper\" || return 1
		legacy_sha=\"$(sha256sum \"$renderer_helper\" | awk '{{print $1}}')\"
		legacy_helper_hash_is_allowed \"$legacy_sha\" || return 2
		[ ! -e \"$renderer_legacy_backup\" ] && [ ! -L \"$renderer_legacy_backup\" ] || return 1
		mv \"$renderer_helper\" \"$renderer_legacy_backup\" || return 1
		install_renderer_gate || return 1
	fi
	create_maintenance_marker || return 1
	ensure_renderer_lock \"$renderer_control_lock\" || return 1
	ensure_renderer_lock \"$renderer_worker_lock\" || return 1
	terminate_renderer_processes || return 1
	\"$renderer_legacy_backup\" cleanup || return 1
	terminate_renderer_processes || return 1
	exec 9< \"$renderer_control_lock\" || return 1
	lock_renderer_fd 9 || return 1
	exec 8< \"$renderer_worker_lock\" || return 1
	lock_renderer_fd 8 || return 1
	[ ! -e \"$renderer_runtime\" ] && [ ! -L \"$renderer_runtime\" ] || return 1
	[ -z \"$(renderer_related_pids)\" ] || return 1
	return 0
}}

renderer_enter_without_helper() {{
	create_maintenance_marker || return 1
	ensure_renderer_lock \"$renderer_control_lock\" || return 1
	ensure_renderer_lock \"$renderer_worker_lock\" || return 1
	terminate_renderer_processes || return 1
	exec 9< \"$renderer_control_lock\" || return 1
	lock_renderer_fd 9 || return 1
	exec 8< \"$renderer_worker_lock\" || return 1
	lock_renderer_fd 8 || return 1
	[ ! -e \"$renderer_runtime\" ] && [ ! -L \"$renderer_runtime\" ] &&
		[ -z \"$(renderer_related_pids)\" ]
}}

renderer_enter_for_change() {{
	if [ -e \"$renderer_legacy_backup\" ] || [ -L \"$renderer_legacy_backup\" ]; then
		renderer_enter_legacy
		return
	fi
	[ -e \"$renderer_helper\" ] || [ -L \"$renderer_helper\" ] || {{
		renderer_enter_without_helper
		return
	}}
	safe_root_executable \"$renderer_helper\" || return 1
	output=\"$(
		\"$renderer_helper\" maintenance-enter 2>/dev/null
		output_status=$?
		printf '__VIDEOPLAYER_RC__%s' \"$output_status\"
	)\"
	if [ \"$output\" = \"$(printf 'maintenance\\n__VIDEOPLAYER_RC__0')\" ]; then
		maintenance_marker_state &&
			\"$renderer_helper\" cleanup &&
			maintenance_marker_state
		return
	fi
	renderer_enter_legacy
}}

renderer_resume_after_change() {{
	safe_root_executable \"$renderer_helper\" || return 1
	state=0
	maintenance_marker_state || state=$?
	case \"$state\" in
		1)
			[ ! -e \"$renderer_legacy_backup\" ] && [ ! -L \"$renderer_legacy_backup\" ]
			return
			;;
		0) ;;
		*) return 1 ;;
	esac
	output=\"$(
		\"$renderer_helper\" maintenance-enter
		output_status=$?
		printf '__VIDEOPLAYER_RC__%s' \"$output_status\"
	)\"
	[ \"$output\" = \"$(printf 'maintenance\\n__VIDEOPLAYER_RC__0')\" ] &&
		maintenance_marker_state &&
		\"$renderer_helper\" cleanup && maintenance_marker_state || return 1
	rm -f -- \"$renderer_legacy_backup\" 2>/dev/null || return 1
	output=\"$(
		\"$renderer_helper\" maintenance-exit
		output_status=$?
		printf '__VIDEOPLAYER_RC__%s' \"$output_status\"
	)\"
	[ \"$output\" = \"$(printf 'resumed\\n__VIDEOPLAYER_RC__0')\" ] || return 1
	state=0
	maintenance_marker_state || state=$?
	[ \"$state\" -eq 1 ] || return 1
	return 0
}}
"""


def postinst_script() -> bytes:
    return f"""#!/bin/sh
[ "${{IPKG_NO_SCRIPT}}" = "1" ] && exit 0
[ -s ${{IPKG_INSTROOT}}/lib/functions.sh ] || exit 0
. ${{IPKG_INSTROOT}}/lib/functions.sh
export root="${{IPKG_INSTROOT}}"
export pkgname="{PKG_NAME}"
add_group_and_user || exit 1
default_postinst || exit 1
[ -n "${{IPKG_INSTROOT}}" ] || {{
	chmod 0755 \
		/www/cgi-bin/videoplayer-stream \
		/www/cgi-bin/videoplayer-frame \
		/www/cgi-bin/videoplayer-audio \
		/usr/libexec/rpcd/luci.videoplayer \
		/usr/libexec/videoplayer-renderer 2>/dev/null || true
	{renderer_maintenance_shell()}
	renderer_resume_after_change || {{
		echo "The renderer remains safely disabled because maintenance could not be completed." >&2
		exit 1
	}}
	rm -f /tmp/luci-indexcache /tmp/luci-indexcache.* 2>/dev/null || true
	rm -rf /tmp/luci-modulecache 2>/dev/null || true
	/etc/init.d/rpcd reload 2>/dev/null || true
	exit 0
}}
exit 0
""".encode()


def renderer_cleanup_body(action: str) -> bytes:
    if action not in {"replacing", "removing"}:
        raise PackageBuildError("Invalid renderer cleanup action")
    return f"""[ -n "${{IPKG_INSTROOT:-}}" ] || {{
{renderer_maintenance_shell()}
	renderer_enter_for_change || {{
		echo "Could not enter safe renderer maintenance before {action} the application." >&2
		exit 1
	}}
}}
""".encode()


def preinst_script() -> bytes:
    return b"#!/bin/sh\n" + renderer_cleanup_body("replacing") + b"exit 0\n"


def prerm_script() -> bytes:
    return b"#!/bin/sh\n" + renderer_cleanup_body("removing") + f"""\
[ -s ${{IPKG_INSTROOT}}/lib/functions.sh ] || exit 0
. ${{IPKG_INSTROOT}}/lib/functions.sh
export root="${{IPKG_INSTROOT}}"
export pkgname="{PKG_NAME}"
default_prerm || exit 1
exit 0
""".encode()


def preupgrade_script() -> bytes:
    return (
        b"#!/bin/sh\nexport PKG_UPGRADE=1\n"
        + renderer_cleanup_body("replacing")
        + b"exit 0\n"
    )


def postupgrade_script() -> bytes:
    return b"#!/bin/sh\nexport PKG_UPGRADE=1\n" + postinst_script().split(b"\n", 1)[1]


def postrm_script() -> bytes:
    return b"""#!/bin/sh
[ -n "${IPKG_INSTROOT}" ] || {
	cleanup_token_store() (
		lock_file="/tmp/videoplayer-tokens.lock"
		token_dir="/tmp/videoplayer-tokens"
		marker="$token_dir/.bucket-v1"
		if [ ! -e "$lock_file" ] && [ ! -L "$lock_file" ]; then
			(umask 077; set -C; : > "$lock_file") 2>/dev/null || :
		fi
		[ -f "$lock_file" ] && [ ! -L "$lock_file" ] || return 1
		[ "$(stat -c '%u' -- "$lock_file" 2>/dev/null)" = "0" ] || return 1
		[ "$(readlink -f -- "$lock_file" 2>/dev/null)" = "$lock_file" ] || return 1
		chmod 0600 "$lock_file" 2>/dev/null || return 1
		exec 9< "$lock_file" || return 1
		flock -x 9 || return 1
		if [ ! -e "$token_dir" ] && [ ! -L "$token_dir" ]; then
			(umask 077; mkdir "$token_dir") || return 1
		fi
		[ -d "$token_dir" ] && [ ! -L "$token_dir" ] || return 1
		[ "$(stat -c '%u' -- "$token_dir" 2>/dev/null)" = "0" ] || return 1
		[ "$(readlink -f -- "$token_dir" 2>/dev/null)" = "$token_dir" ] || return 1
		chmod 0700 "$token_dir" 2>/dev/null || return 1
		if [ ! -e "$marker" ] && [ ! -L "$marker" ]; then
			marker_tmp="$token_dir/.cleanup-marker.$$"
			rm -f -- "$marker_tmp" || return 1
			(umask 077; set -C; printf 'bucket-v1\n' > "$marker_tmp") 2>/dev/null || {
				rm -f -- "$marker_tmp"
				return 1
			}
			if ! ln "$marker_tmp" "$marker" 2>/dev/null; then
				if [ ! -f "$marker" ] || [ -L "$marker" ]; then
					rm -f -- "$marker_tmp"
					return 1
				fi
			fi
			rm -f -- "$marker_tmp"
		fi
		[ -f "$marker" ] && [ ! -L "$marker" ] || return 1
		exec 8< "$marker" || return 1
		flock -x 8 || return 1
		find "$token_dir" -mindepth 1 -maxdepth 1 ! -name '.bucket-v1' -exec rm -rf -- '{}' \\;
	)
	rm -f /tmp/luci-indexcache /tmp/luci-indexcache.* 2>/dev/null || true
	rm -rf /tmp/luci-modulecache 2>/dev/null || true
	cleanup_token_store 2>/dev/null || true
	/etc/init.d/rpcd reload 2>/dev/null || true
}
exit 0
"""


# ── IPK (opkg) ────────────────────────────────────────────────────────

def tar_bytes(
    members: list[tuple[str, bytes, int]],
    mtime: int,
    *,
    include_directories: bool,
) -> bytes:
    """Create the deterministic GNU tar layout used by OpenWrt ipkg-build."""
    files: dict[str, tuple[bytes, int]] = {}
    input_order: list[str] = []

    for archive_name, data, mode in members:
        name = archive_name
        while name.startswith("./"):
            name = name[2:]
        path = PurePosixPath(name)
        if (
            not name
            or path.is_absolute()
            or ".." in path.parts
            or path.as_posix() in {"", "."}
        ):
            raise PackageBuildError(f"Invalid tar member path: {archive_name!r}")
        normalized = path.as_posix()
        if normalized in files:
            raise PackageBuildError(f"Duplicate tar member path: {archive_name!r}")
        files[normalized] = (data, mode)
        input_order.append(normalized)

    entries: list[tuple[str, bytes | None, int]]
    if include_directories:
        directories = {"."}
        for name in files:
            parent = PurePosixPath(name).parent
            while parent.as_posix() != ".":
                directories.add(parent.as_posix())
                parent = parent.parent
        entries = [
            (name, None, MODE_DIR)
            for name in directories
        ] + [
            (name, files[name][0], files[name][1])
            for name in files
        ]
        entries.sort(key=lambda entry: entry[0])
    else:
        entries = [
            (name, files[name][0], files[name][1])
            for name in input_order
        ]

    tar_buf = io.BytesIO()
    with tarfile.open(fileobj=tar_buf, mode="w", format=tarfile.GNU_FORMAT) as tf:
        for name, data, mode in entries:
            archive_name = "." if name == "." else f"./{name}"
            info = tarfile.TarInfo(name=archive_name)
            info.mode = mode
            info.uid = 0
            info.gid = 0
            # OpenWrt passes --numeric-owner to tar, so textual owner names
            # are intentionally empty.
            info.uname = ""
            info.gname = ""
            info.mtime = mtime
            if data is None:
                info.type = tarfile.DIRTYPE
                info.size = 0
                tf.addfile(info)
            else:
                info.size = len(data)
                tf.addfile(info, io.BytesIO(data))
    return tar_buf.getvalue()


def gzip_bytes(data: bytes) -> bytes:
    """Match gzip -n: omit filename and use a zero gzip-header timestamp."""
    gzip_buf = io.BytesIO()
    with gzip.GzipFile(
        filename="",
        mode="wb",
        compresslevel=9,
        fileobj=gzip_buf,
        mtime=0,
    ) as gz:
        gz.write(data)
    return gzip_buf.getvalue()


def tar_gz_bytes(
    members: list[tuple[str, bytes, int]],
    mtime: int,
    *,
    include_directories: bool,
) -> tuple[bytes, int]:
    raw_tar = tar_bytes(
        members,
        mtime,
        include_directories=include_directories,
    )
    return gzip_bytes(raw_tar), len(raw_tar)


def build_ipk(
    files: list[tuple[str, Path, int]],
    mtime: int,
    output_dir: Path,
) -> Path:
    data_members: list[tuple[str, bytes, int]] = []
    source_bytes = 0
    for install, src, mode in files:
        data = read_source_file(src, MAX_SOURCE_PAYLOAD_BYTES - source_bytes)
        source_bytes += len(data)
        # Normalize shell scripts for execution on the router.
        if mode == MODE_EXEC or install.endswith(".sh") or "uci-defaults" in install:
            data = data.replace(b"\r\n", b"\n")
        archive_path = "." + (install if install.startswith("/") else "/" + install)
        data_members.append((archive_path, data, mode))

    data_tar, installed_size = tar_gz_bytes(
        data_members,
        mtime,
        include_directories=True,
    )

    control = f"""Package: {PKG_NAME}
Version: {PKG_VERSION}
Depends: {", ".join(DEPENDS)}
Source: feeds/luci/applications/{PKG_NAME}
SourceName: {PKG_NAME}
License: {PKG_LICENSE}
Section: luci
SourceDateEpoch: {mtime}
URL: {PKG_URL}
Maintainer: {PKG_MAINTAINER}
Architecture: {PKG_ARCH_IPK}
Installed-Size: {installed_size}
Description:  {PKG_DESC}
 Browser playback and attested fail-closed software CPU rendering for local media.
 Remote HTTP(S) URLs are browser-only. Application files are architecture-independent.
""".encode()

    conffiles = ("\n".join(CONFFILES) + "\n").encode("utf-8")
    control_members = [
        ("./control", control, 0o644),
        ("./conffiles", conffiles, 0o644),
        ("./preinst", preinst_script(), 0o755),
        ("./postinst", postinst_script(), 0o755),
        ("./prerm", prerm_script(), 0o755),
        ("./postrm", postrm_script(), 0o755),
    ]
    control_tar, _ = tar_gz_bytes(
        control_members,
        mtime,
        include_directories=True,
    )

    # OpenWrt 24.10's ipkg-build emits a gzip-compressed GNU tar, not a
    # Debian System V ar container.
    ipk, _ = tar_gz_bytes(
        [
            ("./debian-binary", b"2.0\n", MODE_FILE),
            ("./data.tar.gz", data_tar, MODE_FILE),
            ("./control.tar.gz", control_tar, MODE_FILE),
        ],
        mtime,
        include_directories=False,
    )
    if len(ipk) > MAX_BUILT_PACKAGE_BYTES:
        raise PackageBuildError(
            f"IPK exceeds the {MAX_BUILT_PACKAGE_BYTES}-byte package limit"
        )

    output_dir.mkdir(parents=True, exist_ok=True)
    out = output_dir / f"{PKG_NAME}_{PKG_VERSION}_{PKG_ARCH_IPK}.ipk"
    out.write_bytes(ipk)
    return out


# ── APK v3 (ADB) ──────────────────────────────────────────────────────

class AdbBuilder:
    """Minimal APK v3 ADB writer (no signature; install with --allow-untrusted)."""

    TYPE_INT = 0x10000000
    TYPE_INT32 = 0x20000000
    TYPE_BLOB8 = 0x80000000
    TYPE_BLOB16 = 0x90000000
    TYPE_BLOB32 = 0xA0000000
    TYPE_ARRAY = 0xD0000000
    TYPE_OBJECT = 0xE0000000

    def __init__(self) -> None:
        # first 8 bytes: reserved + root
        self.buf = bytearray(8)

    def _align(self) -> None:
        while len(self.buf) & 3:
            self.buf.append(0)

    def put_int(self, value: int) -> int:
        if 0 <= value <= 0x0FFFFFFF:
            return self.TYPE_INT | value
        self._align()
        off = len(self.buf)
        self.buf += struct.pack("<I", value & 0xFFFFFFFF)
        return self.TYPE_INT32 | off

    def put_blob(self, data: bytes) -> int:
        n = len(data)
        self._align()
        off = len(self.buf)
        if n <= 0xFF:
            self.buf.append(n & 0xFF)
            self.buf += data
            return self.TYPE_BLOB8 | off
        if n <= 0xFFFF:
            self.buf += struct.pack("<H", n)
            self.buf += data
            return self.TYPE_BLOB16 | off
        self.buf += struct.pack("<I", n)
        self.buf += data
        return self.TYPE_BLOB32 | off

    def put_string(self, s: str) -> int:
        return self.put_blob(s.encode("utf-8"))

    def put_object(self, fields: dict[int, int]) -> int:
        """fields: 1-based index -> adb_val (0 = NULL)."""
        if not fields:
            max_i = 0
        else:
            max_i = max(fields)
        count = max_i + 1  # includes count slot
        self._align()
        off = len(self.buf)
        self.buf += struct.pack("<I", count)
        for i in range(1, count):
            self.buf += struct.pack("<I", fields.get(i, 0))
        return self.TYPE_OBJECT | off

    def put_array(self, values: list[int]) -> int:
        count = len(values) + 1
        self._align()
        off = len(self.buf)
        self.buf += struct.pack("<I", count)
        for v in values:
            self.buf += struct.pack("<I", v)
        return self.TYPE_ARRAY | off

    def set_root(self, root_val: int) -> None:
        struct.pack_into("<I", self.buf, 4, root_val)

    def finalize(self) -> bytes:
        return bytes(self.buf)


def build_content_uid(
    payload: dict[str, tuple[bytes, int]],
    scripts: list[tuple[str, bytes]],
) -> bytes:
    """Return the APK v3 20-byte prefix of a deterministic SHA-256 digest.

    Official apk v3 package hashes use a 20-byte value even when generated
    from SHA-256. This is not a signature; releases should still be built and
    signed by the OpenWrt SDK with apk mkpkg.
    """
    digest = hashlib.sha256()

    for value in (
        PKG_NAME,
        PKG_VERSION,
        PKG_DESC,
        PKG_ARCH_APK,
        PKG_LICENSE,
        PKG_MAINTAINER,
        PKG_URL,
        *DEPENDS,
    ):
        encoded = value.encode("utf-8")
        digest.update(struct.pack("<I", len(encoded)))
        digest.update(encoded)

    for path in sorted(payload):
        data, mode = payload[path]
        encoded_path = path.encode("utf-8")
        digest.update(struct.pack("<I", len(encoded_path)))
        digest.update(encoded_path)
        digest.update(struct.pack("<I", mode))
        digest.update(struct.pack("<Q", len(data)))
        digest.update(hashlib.sha256(data).digest())

    for name, data in scripts:
        encoded_name = name.encode("ascii")
        digest.update(struct.pack("<I", len(encoded_name)))
        digest.update(encoded_name)
        digest.update(struct.pack("<Q", len(data)))
        digest.update(hashlib.sha256(data).digest())

    return digest.digest()[:APK_UID_SIZE]


def build_apk(
    files: list[tuple[str, Path, int]],
    mtime: int,
    output_dir: Path,
) -> tuple[Path, bytes]:
    # Prepare file payloads (path -> (data, mode))
    payload: dict[str, tuple[bytes, int]] = {}
    source_bytes = 0
    for install, src, mode in files:
        data = read_source_file(src, MAX_SOURCE_PAYLOAD_BYTES - source_bytes)
        source_bytes += len(data)
        if mode == MODE_EXEC or "uci-defaults" in install:
            data = data.replace(b"\r\n", b"\n")
        payload[install.lstrip("/")] = (data, mode)

    # OpenWrt package list file
    list_body = build_file_list_content(files)
    list_path = f"lib/apk/packages/{PKG_NAME}.list"
    payload[list_path] = (list_body, MODE_FILE)

    conffiles_body = ("\n".join(CONFFILES) + "\n").encode("utf-8")
    conffiles_static_lines: list[str] = []
    for conffile in CONFFILES:
        payload_path = conffile.lstrip("/")
        if payload_path not in payload:
            raise PackageBuildError(f"Conffile is absent from payload: {conffile}")
        conffile_data, _ = payload[payload_path]
        conffiles_static_lines.append(
            f"{conffile} {hashlib.sha256(conffile_data).hexdigest()}"
        )

    metadata_dir = f"lib/apk/packages/{PKG_NAME}"
    payload[f"{metadata_dir}.conffiles"] = (conffiles_body, MODE_FILE)
    payload[f"{metadata_dir}.conffiles_static"] = (
        ("\n".join(conffiles_static_lines) + "\n").encode("utf-8"),
        MODE_FILE,
    )

    script_payloads = [
        ("pre-install", preinst_script()),
        ("post-install", postinst_script()),
        ("pre-deinstall", prerm_script()),
        ("post-deinstall", postrm_script()),
        ("pre-upgrade", preupgrade_script()),
        ("post-upgrade", postupgrade_script()),
    ]
    pkg_hash = build_content_uid(payload, script_payloads)

    # Build directory tree: dirpath -> list of (filename, fullpath)
    dirs: dict[str, list[str]] = defaultdict(list)
    # ensure intermediate dirs
    all_dirs: set[str] = {""}
    for fpath in payload:
        parts = fpath.split("/")
        for i in range(len(parts)):
            d = "/".join(parts[:i])
            all_dirs.add(d)
        parent = "/".join(parts[:-1])
        dirs[parent].append(parts[-1])

    # stable ordered dir list: parent before child, root first
    def dir_key(d: str) -> tuple:
        return (d.count("/"), d)

    dir_list = sorted(all_dirs, key=dir_key)

    adb = AdbBuilder()

    # shared ACLs
    acl_dir = adb.put_object(
        {
            1: adb.put_int(MODE_DIR),  # 0755 = 493
            2: adb.put_string("root"),
            3: adb.put_string("root"),
        }
    )
    acl_file = adb.put_object(
        {
            1: adb.put_int(MODE_FILE),  # 0644 = 420
            2: adb.put_string("root"),
            3: adb.put_string("root"),
        }
    )
    acl_exec = adb.put_object(
        {
            1: adb.put_int(MODE_EXEC),
            2: adb.put_string("root"),
            3: adb.put_string("root"),
        }
    )

    # file entries and dir objects; track 1-based indices for DATA blocks
    # dir_index is 1-based position in paths object
    file_data_order: list[tuple[int, int, bytes]] = []  # dir_idx, file_idx, data
    dir_vals: list[int] = []

    for d_i, dpath in enumerate(dir_list, start=1):
        names = sorted(dirs.get(dpath, []))
        file_vals: list[int] = []
        for f_i, fname in enumerate(names, start=1):
            full = f"{dpath}/{fname}" if dpath else fname
            data, mode = payload[full]
            h = hashlib.sha256(data).digest()
            acl = acl_exec if mode & 0o111 else acl_file
            fobj = adb.put_object(
                {
                    1: adb.put_string(fname),
                    2: acl,
                    3: adb.put_int(len(data)),
                    4: adb.put_int(mtime),
                    5: adb.put_blob(h),
                }
            )
            file_vals.append(fobj)
            file_data_order.append((d_i, f_i, data))

        fields: dict[int, int] = {}
        if dpath:
            fields[1] = adb.put_string(dpath)
        else:
            fields[1] = 0  # root dir name NULL
        fields[2] = acl_dir
        if file_vals:
            fields[3] = adb.put_array(file_vals)
        dir_vals.append(adb.put_object(fields))

    paths_obj = adb.put_object({i + 1: v for i, v in enumerate(dir_vals)})

    # depends
    dep_vals = []
    for dep in DEPENDS:
        dep_vals.append(adb.put_object({1: adb.put_string(dep)}))
    # also soft depend nothing; OpenWrt sample had libc too
    dep_vals.insert(0, adb.put_object({1: adb.put_string("libc")}))
    depends = adb.put_array(dep_vals)

    provides = adb.put_array([adb.put_object({1: adb.put_string(f"{PKG_NAME}-any")})])
    tags = adb.put_array([adb.put_string("openwrt:section=luci")])

    installed_size = sum(len(d) for d, _ in payload.values())

    pkginfo = adb.put_object(
        {
            1: adb.put_string(PKG_NAME),
            2: adb.put_string(PKG_VERSION),
            3: adb.put_blob(pkg_hash),
            4: adb.put_string(PKG_DESC),
            5: adb.put_string(PKG_ARCH_APK),
            6: adb.put_string(PKG_LICENSE),
            7: adb.put_string(f"feeds/luci/applications/{PKG_NAME}"),
            8: adb.put_string(PKG_MAINTAINER),
            9: adb.put_string(PKG_URL),
            12: adb.put_int(installed_size),
            15: depends,
            16: provides,
            21: tags,
        }
    )

    scripts = adb.put_object(
        {
            2: adb.put_blob(dict(script_payloads)["pre-install"]),
            3: adb.put_blob(dict(script_payloads)["post-install"]),
            4: adb.put_blob(dict(script_payloads)["pre-deinstall"]),
            5: adb.put_blob(dict(script_payloads)["post-deinstall"]),
            6: adb.put_blob(dict(script_payloads)["pre-upgrade"]),
            7: adb.put_blob(dict(script_payloads)["post-upgrade"]),
        }
    )

    root = adb.put_object(
        {
            1: pkginfo,
            2: paths_obj,
            3: scripts,
        }
    )
    adb.set_root(root)
    adb_blob = adb.finalize()

    # Build block stream: ADB. + schema + blocks
    SCHEMA_PACKAGE = 0x676B6370  # pckg
    stream = bytearray()
    stream += b"ADB."
    stream += struct.pack("<I", SCHEMA_PACKAGE)

    def append_block(btype: int, payload_bytes: bytes) -> None:
        # type_size includes header (4) + payload
        rawsize = 4 + len(payload_bytes)
        if rawsize > 0x3FFFFFFF:
            raise ValueError("block too large")
        stream.extend(struct.pack("<I", (btype << 30) | rawsize))
        stream.extend(payload_bytes)
        # pad to 8
        while len(stream) & 7:
            stream.append(0)

    append_block(0, adb_blob)  # ADB_BLOCK_ADB

    for d_i, f_i, data in file_data_order:
        # DATA: path_idx, file_idx, then bytes
        payload_bytes = struct.pack("<II", d_i, f_i) + data
        append_block(2, payload_bytes)

    # Outer wrap: ADBd + raw deflate of stream
    compressor = zlib.compressobj(level=9, wbits=-15)  # raw deflate
    compressed = compressor.compress(bytes(stream)) + compressor.flush()
    apk = b"ADBd" + compressed
    if len(apk) > MAX_BUILT_PACKAGE_BYTES:
        raise PackageBuildError(
            f"APK exceeds the {MAX_BUILT_PACKAGE_BYTES}-byte package limit"
        )

    output_dir.mkdir(parents=True, exist_ok=True)
    out = output_dir / f"{PKG_NAME}-{PKG_VERSION}.apk"
    out.write_bytes(apk)
    return out, pkg_hash


def source_date_epoch() -> int:
    raw = os.environ.get("SOURCE_DATE_EPOCH", "0")
    try:
        value = int(raw, 10)
    except ValueError as exc:
        raise PackageBuildError(
            f"SOURCE_DATE_EPOCH must be a non-negative integer, got {raw!r}"
        ) from exc

    if not 0 <= value <= 0xFFFFFFFF:
        raise PackageBuildError(
            f"SOURCE_DATE_EPOCH is outside the supported 32-bit range: {value}"
        )
    return value


def build_all(
    files: list[tuple[str, Path, int]],
    mtime: int,
    output_dir: Path,
) -> tuple[Path, Path, bytes]:
    ipk = build_ipk(files, mtime, output_dir)
    apk, apk_uid = build_apk(files, mtime, output_dir)
    return ipk, apk, apk_uid


def verify_outputs(ipk: Path, apk: Path, expected_uid: bytes | None = None) -> None:
    try:
        from verify_packages import PackageVerificationError, verify_packages
    except ImportError as exc:
        raise PackageBuildError(
            "Cannot import scripts/verify_packages.py"
        ) from exc

    try:
        verify_packages(ipk, apk, expected_apk_uid=expected_uid)
    except PackageVerificationError as exc:
        raise PackageBuildError(f"Package verification failed: {exc}") from exc


def check_reproducible(
    files: list[tuple[str, Path, int]],
    mtime: int,
    reference_ipk: Path,
    reference_apk: Path,
) -> None:
    with tempfile.TemporaryDirectory(prefix="videoplayer-repro-") as temp_dir:
        second_dir = Path(temp_dir)
        second_ipk, second_apk, _ = build_all(files, mtime, second_dir)

        comparisons = (
            ("IPK", reference_ipk, second_ipk),
            ("APK", reference_apk, second_apk),
        )
        for label, first, second in comparisons:
            first_data = first.read_bytes()
            second_data = second.read_bytes()
            if first_data != second_data:
                raise PackageBuildError(
                    f"{label} build is not reproducible for SOURCE_DATE_EPOCH={mtime}"
                )
    print("Reproducibility check passed")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build and verify local OpenWrt IPK/APK packages."
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=DEFAULT_DIST,
        help="artifact directory (default: repository .staging/app/)",
    )
    parser.add_argument(
        "--verify-only",
        action="store_true",
        help="verify existing artifacts without rebuilding them",
    )
    parser.add_argument(
        "--check-reproducible",
        action="store_true",
        help="build a second copy and require byte-identical artifacts",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    validate_source_metadata()
    output_dir = args.output_dir.resolve()
    ipk_path = output_dir / f"{PKG_NAME}_{PKG_VERSION}_{PKG_ARCH_IPK}.ipk"
    apk_path = output_dir / f"{PKG_NAME}-{PKG_VERSION}.apk"

    if args.verify_only:
        verify_outputs(ipk_path, apk_path)
        print("Existing package verification passed")
        return

    mtime = source_date_epoch()
    files = collect_files()
    print(f"Collected {len(files)} files")
    for p, _, m in files:
        print(f"  {oct(m)} /{p}")

    ipk, apk, apk_uid = build_all(files, mtime, output_dir)
    print(f"Built IPK: {ipk} ({ipk.stat().st_size} bytes)")
    print(f"Built APK: {apk} ({apk.stat().st_size} bytes)")

    verify_outputs(ipk, apk, expected_uid=apk_uid)
    print("Package structure, metadata, scripts, modes, and payloads verified")

    if args.check_reproducible:
        check_reproducible(files, mtime, ipk, apk)

    print()
    print("Install on OpenWrt:")
    print("  # OpenWrt 25.12+ / snapshot (unsigned local APK):")
    print(f"  apk add --allow-untrusted ./{apk.name}")
    print("  # OpenWrt 24.10 (opkg):")
    print(f"  opkg install ./{ipk.name}")
    print("  Then: log out of LuCI and log in again -> Services -> Video Player")
    print()
    print("For published releases, build and sign packages with the official OpenWrt SDK.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, PackageBuildError) as exc:
        raise SystemExit(f"ERROR: {exc}") from exc
