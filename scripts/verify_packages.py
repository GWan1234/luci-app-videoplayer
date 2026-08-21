#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Verify locally built OpenWrt IPK and APK v3 packages."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import io
import os
import stat
import struct
import tarfile
import zlib
from collections.abc import Collection
from functools import lru_cache
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[1]
PKG_DIR = ROOT / "luci-app-videoplayer"
DIST = ROOT / ".staging" / "app"

PKG_NAME = "luci-app-videoplayer"
PKG_VERSION = "1.1.1"
PKG_ARCH_IPK = "all"
PKG_ARCH_APK = "noarch"
PKG_LICENSE = "GPL-2.0-or-later"
PKG_DESCRIPTION = "LuCI video player with browser and strict router CPU rendering"
PKG_MAINTAINER = "openwrt-video-player contributors"
PKG_ORIGIN = f"feeds/luci/applications/{PKG_NAME}"
PKG_URL = "https://github.com/communism420/luci-app-videoplayer"
DEPENDENCIES = (
    "luci-base",
    "uhttpd",
    "jshn",
    "coreutils-stat",
    "coreutils-timeout",
)
REQUIRED_DEPENDS = set(DEPENDENCIES)
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

MODE_FILE = 0o644
MODE_EXEC = 0o755
APK_SCHEMA_PACKAGE = 0x676B6370
APK_UID_SIZE = 20
MAX_PACKAGE_FILE_BYTES = 32 * 1024 * 1024
MAX_IPK_OUTER_TAR_BYTES = 64 * 1024 * 1024
MAX_IPK_CONTROL_TAR_BYTES = 8 * 1024 * 1024
MAX_IPK_DATA_TAR_BYTES = 128 * 1024 * 1024
MAX_APK_STREAM_BYTES = 128 * 1024 * 1024
MAX_OUTER_TAR_MEMBERS = 8
MAX_CONTROL_TAR_MEMBERS = 32
MAX_DATA_TAR_MEMBERS = 256
MAX_SOURCE_TREE_ENTRIES = 1024
MAX_PACKAGE_FILES = 256
MAX_SOURCE_FILE_BYTES = 24 * 1024 * 1024
MAX_SOURCE_PAYLOAD_BYTES = 24 * 1024 * 1024
MAX_APK_BLOCKS = 1024
MAX_ADB_COLLECTION_ITEMS = 4096


class PackageVerificationError(RuntimeError):
    """Raised when a package does not match the expected project contents."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise PackageVerificationError(message)


def verify_lifecycle_contract(name: str, script: bytes) -> None:
    """Independently enforce the fail-closed renderer transaction invariants."""
    require(script.startswith(b"#!/bin/sh\n"), f"{name} has no canonical shell header")
    require(
        b"videoplayer-renderer cleanup" not in script
        and b"renderer_helper\" cleanup 2>/dev/null || true" not in script,
        f"{name} bypasses renderer maintenance before cleanup",
    )
    require(
        b"rm -f /tmp/videoplayer-render-v1.lock" not in script
        and b"rm -f /tmp/videoplayer-render-v1.worker.lock" not in script,
        f"{name} deletes a persistent renderer lock inode",
    )
    if name in {"preinst", "prerm", "preupgrade"}:
        for token in (
            b"maintenance-enter",
            b"renderer_enter_for_change",
            b"maintenance-v1",
            b"renderer_helper\" cleanup",
        ):
            require(token in script, f"{name} lacks {token.decode()} enforcement")
        require(
            script.count(b"renderer_enter_for_change") >= 2
            and script.count(b"renderer_resume_after_change") == 1,
            f"{name} does not end with the maintenance-enter phase only",
        )
    elif name in {"postinst", "postupgrade"}:
        for token in (
            b"maintenance-enter",
            b"maintenance-exit",
            b"renderer_resume_after_change",
            b"maintenance-v1",
        ):
            require(token in script, f"{name} lacks {token.decode()} enforcement")
        require(
            script.count(b"renderer_resume_after_change") >= 2,
            f"{name} does not execute the maintenance-exit phase",
        )
    elif name == "postrm":
        require(
            b"maintenance-enter" not in script
            and b"maintenance-exit" not in script
            and b"renderer_helper" not in script,
            "postrm must preserve the durable maintenance gate after app removal",
        )


def read_limited_file(path: Path, limit: int, label: str) -> bytes:
    require(not path.is_symlink(), f"{label} must not be a symlink")
    with path.open("rb") as stream:
        before = os.fstat(stream.fileno())
        require(stat.S_ISREG(before.st_mode), f"{label} is not a regular file")
        require(before.st_size <= limit, f"{label} exceeds the {limit}-byte safety limit")
        data = stream.read(limit + 1)
        require(len(data) <= limit, f"{label} exceeds the {limit}-byte safety limit")
        require(not stream.read(1), f"{label} grew while it was being read")
        after = os.fstat(stream.fileno())
    require(
        (
            before.st_dev,
            before.st_ino,
            before.st_size,
            before.st_mtime_ns,
        )
        == (
            after.st_dev,
            after.st_ino,
            after.st_size,
            after.st_mtime_ns,
        )
        and len(data) == after.st_size,
        f"{label} changed while it was being read",
    )
    require(not path.is_symlink(), f"{label} became a symlink while it was being read")
    return data


def source_payload() -> dict[str, tuple[bytes, int]]:
    payload: dict[str, tuple[bytes, int]] = {}
    source_bytes = 0
    source_entries = 0
    mappings = (
        (PKG_DIR / "root", ""),
        (PKG_DIR / "htdocs", "www"),
    )

    for source_root, prefix in mappings:
        require(
            not source_root.is_symlink(),
            f"Package source root must not be a symlink: {source_root}",
        )
        require(source_root.is_dir(), f"Missing source directory: {source_root}")
        for source in source_root.rglob("*"):
            source_entries += 1
            require(
                source_entries <= MAX_SOURCE_TREE_ENTRIES,
                "Package source tree contains too many entries",
            )
            require(
                not source.is_symlink(),
                f"Package source tree contains a symlink: {source}",
            )
            try:
                source_stat = source.stat()
            except OSError as exc:
                raise PackageVerificationError(
                    f"Cannot inspect package source {source}: {exc}"
                ) from exc
            if stat.S_ISDIR(source_stat.st_mode):
                continue
            require(
                stat.S_ISREG(source_stat.st_mode),
                f"Package source is not a regular file: {source}",
            )

            relative = source.relative_to(source_root).as_posix()
            install_path = f"{prefix}/{relative}" if prefix else relative
            install_path = install_path.lstrip("/")

            mode = MODE_FILE
            if install_path.startswith(
                ("etc/uci-defaults/", "usr/libexec/", "www/cgi-bin/")
            ):
                mode = MODE_EXEC

            require(
                len(payload) < MAX_PACKAGE_FILES,
                "Package source tree contains too many files",
            )
            remaining = MAX_SOURCE_PAYLOAD_BYTES - source_bytes
            require(remaining >= 0, "Package source payload exceeds its safety limit")
            data = read_limited_file(
                source,
                min(MAX_SOURCE_FILE_BYTES, remaining),
                f"Source file {source}",
            )
            source_bytes += len(data)
            if mode == MODE_EXEC:
                data = data.replace(b"\r\n", b"\n")
            require(
                install_path not in payload,
                f"Duplicate package install path: /{install_path}",
            )
            payload[install_path] = (data, mode)

    require(payload, "No package source files found")
    missing = REQUIRED_PACKAGE_FILES.difference(payload)
    require(
        not missing,
        "Required package files are missing: " + ", ".join(sorted(missing)),
    )
    require(
        len(payload) + len(expected_archive_directories(payload))
        <= MAX_DATA_TAR_MEMBERS,
        "Package data archive would contain too many file and directory members",
    )
    return payload


def apk_expected_payload(
    package_payload: dict[str, tuple[bytes, int]],
) -> dict[str, tuple[bytes, int]]:
    payload = dict(package_payload)
    package_list = "".join(f"/{path}\n" for path in sorted(package_payload))
    metadata_base = f"lib/apk/packages/{PKG_NAME}"
    payload[f"{metadata_base}.list"] = (package_list.encode("utf-8"), MODE_FILE)

    conffiles = ("\n".join(CONFFILES) + "\n").encode("utf-8")
    static_lines: list[str] = []
    for conffile in CONFFILES:
        source_path = conffile.lstrip("/")
        require(source_path in package_payload, f"Missing conffile payload: {conffile}")
        data, _ = package_payload[source_path]
        static_lines.append(f"{conffile} {hashlib.sha256(data).hexdigest()}")

    payload[f"{metadata_base}.conffiles"] = (conffiles, MODE_FILE)
    payload[f"{metadata_base}.conffiles_static"] = (
        ("\n".join(static_lines) + "\n").encode("utf-8"),
        MODE_FILE,
    )
    return payload


def normalize_archive_name(name: str) -> str:
    while name.startswith("./"):
        name = name[2:]
    path = PurePosixPath(name)
    require(not path.is_absolute(), f"Archive contains an absolute path: {name}")
    require(".." not in path.parts, f"Archive contains parent traversal: {name}")
    return path.as_posix()


def decompress_limited(
    data: bytes,
    *,
    wbits: int,
    max_output_bytes: int,
    label: str,
) -> bytes:
    decompressor = zlib.decompressobj(wbits=wbits)
    try:
        raw = bytearray(decompressor.decompress(data, max_output_bytes + 1))
        require(
            len(raw) <= max_output_bytes,
            f"{label} exceeds the {max_output_bytes}-byte decompression limit",
        )
        raw.extend(decompressor.flush(max_output_bytes - len(raw) + 1))
    except zlib.error as exc:
        raise PackageVerificationError(f"Cannot decompress {label}: {exc}") from exc
    require(
        len(raw) <= max_output_bytes,
        f"{label} exceeds the {max_output_bytes}-byte decompression limit",
    )
    require(decompressor.eof, f"Truncated {label} compressed payload")
    require(not decompressor.unused_data, f"Trailing data after {label} compressed stream")
    require(not decompressor.unconsumed_tail, f"Unconsumed data in {label} compressed stream")
    return bytes(raw)


def decompress_gzip(data: bytes, label: str, max_output_bytes: int) -> bytes:
    require(len(data) >= 10, f"Truncated {label} gzip stream")
    require(data[:3] == b"\x1f\x8b\x08", f"{label} is not gzip-compressed")
    require(data[3] == 0, f"{label} gzip header contains non-reproducible metadata")
    require(
        struct.unpack_from("<I", data, 4)[0] == 0,
        f"{label} gzip header timestamp is not zero",
    )

    return decompress_limited(
        data,
        wbits=16 + zlib.MAX_WBITS,
        max_output_bytes=max_output_bytes,
        label=label,
    )


def parse_tar_gz(
    data: bytes,
    label: str,
    *,
    allow_directories: bool,
    max_output_bytes: int,
    max_members: int,
) -> tuple[
    dict[str, tuple[bytes, int, int]],
    dict[str, tuple[int, int]],
    int,
]:
    raw_tar = decompress_gzip(data, label, max_output_bytes)
    members: dict[str, tuple[bytes, int, int]] = {}
    directories: dict[str, tuple[int, int]] = {}
    extracted_bytes = 0
    try:
        with tarfile.open(fileobj=io.BytesIO(raw_tar), mode="r:") as archive:
            for member_count, info in enumerate(archive, start=1):
                require(
                    member_count <= max_members,
                    f"{label} contains more than {max_members} members",
                )
                name = normalize_archive_name(info.name)
                require(
                    name not in members and name not in directories,
                    f"Duplicate {label} member: {name}",
                )
                require(
                    info.uid == 0 and info.gid == 0,
                    f"Non-root owner on {label} member: {name}",
                )
                require(
                    not info.uname and not info.gname,
                    f"Textual owner metadata in {label} member: {name}",
                )
                mode = info.mode & 0o7777
                mtime = int(info.mtime)
                if info.isdir():
                    require(
                        allow_directories,
                        f"Unexpected directory in {label}: {info.name}",
                    )
                    require(mode == 0o755, f"Wrong directory mode in {label}: {name}")
                    directories[name] = (mode, mtime)
                    continue

                require(info.isfile(), f"Unexpected non-file {label} member: {info.name}")
                require(name != ".", f"Invalid file path in {label}: {info.name}")
                require(
                    not info.sparse and info.type != tarfile.GNUTYPE_SPARSE,
                    f"Sparse files are not allowed in {label}: {name}",
                )
                require(
                    0 <= info.size <= max_output_bytes - extracted_bytes,
                    f"Extracted {label} payload exceeds its safety limit",
                )
                extracted = archive.extractfile(info)
                require(extracted is not None, f"Cannot read {label} member: {name}")
                body = extracted.read(info.size + 1)
                require(
                    len(body) == info.size and not extracted.read(1),
                    f"Wrong extracted size for {label} member: {name}",
                )
                extracted_bytes += len(body)
                members[name] = (body, mode, mtime)
    except (tarfile.TarError, OSError) as exc:
        raise PackageVerificationError(f"Cannot read {label} tarball: {exc}") from exc
    return members, directories, len(raw_tar)


def expected_archive_directories(paths: Collection[str]) -> set[str]:
    directories = {"."}
    for name in paths:
        parent = PurePosixPath(name).parent
        while parent.as_posix() != ".":
            directories.add(parent.as_posix())
            parent = parent.parent
    return directories


def parse_control_fields(control: bytes) -> dict[str, str]:
    try:
        text = control.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise PackageVerificationError("IPK control file is not UTF-8") from exc

    fields: dict[str, str] = {}
    current = ""
    for line_number, line in enumerate(text.splitlines(), start=1):
        require(line != "", f"Unexpected blank line in IPK control at line {line_number}")
        require(
            not line.startswith("\t"),
            f"Tab continuation in IPK control at line {line_number}",
        )
        if line.startswith(" "):
            require(
                bool(current),
                f"Orphan continuation in IPK control at line {line_number}",
            )
            fields[current] += "\n" + line.strip()
            continue
        require(":" in line, f"Malformed IPK control line {line_number}")
        raw_field, value = line.split(":", 1)
        require(
            raw_field == raw_field.strip(),
            f"Whitespace before ':' in IPK control at line {line_number}",
        )
        current = raw_field
        require(
            bool(current)
            and all(character.isascii() and (character.isalnum() or character == "-")
                    for character in current),
            f"Invalid IPK control field name at line {line_number}",
        )
        require(
            current not in fields,
            f"Duplicate IPK control field: {current}",
        )
        fields[current] = value.strip()
    return fields


def expected_ipk_control(package_mtime: int, installed_size: int) -> bytes:
    return f"""Package: {PKG_NAME}
Version: {PKG_VERSION}
Depends: {", ".join(DEPENDENCIES)}
Source: {PKG_ORIGIN}
SourceName: {PKG_NAME}
License: {PKG_LICENSE}
Section: luci
SourceDateEpoch: {package_mtime}
URL: {PKG_URL}
Maintainer: {PKG_MAINTAINER}
Architecture: {PKG_ARCH_IPK}
Installed-Size: {installed_size}
Description:  {PKG_DESCRIPTION}
 Browser playback and attested fail-closed software CPU rendering for local media.
 Remote HTTP(S) URLs are browser-only. Application files are architecture-independent.
""".encode()


def verify_script(
    members: dict[str, tuple[bytes, int, int]],
    name: str,
    expected_data: bytes,
) -> None:
    require(name in members, f"IPK control archive is missing {name}")
    data, mode, _ = members[name]
    require(mode == MODE_EXEC, f"IPK lifecycle script mode must be 0755: {name}")
    require(data == expected_data, f"IPK lifecycle script differs from builder: {name}")


def verify_ipk(ipk_path: Path, expected: dict[str, tuple[bytes, int]]) -> int:
    require(ipk_path.is_file(), f"IPK does not exist: {ipk_path}")
    outer_members, outer_directories, _ = parse_tar_gz(
        read_limited_file(ipk_path, MAX_PACKAGE_FILE_BYTES, "IPK"),
        "IPK outer archive",
        allow_directories=False,
        max_output_bytes=MAX_IPK_OUTER_TAR_BYTES,
        max_members=MAX_OUTER_TAR_MEMBERS,
    )
    required_outer = {"debian-binary", "control.tar.gz", "data.tar.gz"}
    require(set(outer_members) == required_outer, "IPK outer member set is incorrect")
    require(not outer_directories, "IPK outer archive contains directories")
    require(outer_members["debian-binary"][0] == b"2.0\n", "Invalid debian-binary")

    outer_mtimes = {mtime for _, _, mtime in outer_members.values()}
    require(len(outer_mtimes) == 1, "IPK outer member timestamps differ")
    package_mtime = outer_mtimes.pop()
    for name, (_, mode, _) in outer_members.items():
        require(mode == MODE_FILE, f"Wrong IPK outer mode for {name}")

    control_gz = outer_members["control.tar.gz"][0]
    data_gz = outer_members["data.tar.gz"][0]
    control_members, control_directories, _ = parse_tar_gz(
        control_gz,
        "control.tar.gz",
        allow_directories=True,
        max_output_bytes=MAX_IPK_CONTROL_TAR_BYTES,
        max_members=MAX_CONTROL_TAR_MEMBERS,
    )
    data_members, data_directories, data_tar_size = parse_tar_gz(
        data_gz,
        "data.tar.gz",
        allow_directories=True,
        max_output_bytes=MAX_IPK_DATA_TAR_BYTES,
        max_members=MAX_DATA_TAR_MEMBERS,
    )
    require(
        set(control_members)
        == {"control", "conffiles", "preinst", "postinst", "prerm", "postrm"},
        "IPK control archive member set is incorrect",
    )
    require(
        set(control_directories) == {"."},
        "IPK control archive directory set is incorrect",
    )
    for name, (_, _, member_mtime) in control_members.items():
        require(member_mtime == package_mtime, f"Wrong IPK control mtime for {name}")
    for name, (_, member_mtime) in control_directories.items():
        require(member_mtime == package_mtime, f"Wrong IPK control mtime for {name}")

    control, control_mode, _ = control_members["control"]
    require(control_mode == MODE_FILE, "IPK control file mode must be 0644")
    require(
        control == expected_ipk_control(package_mtime, data_tar_size),
        "IPK control file differs from the expected canonical metadata",
    )
    fields = parse_control_fields(control)
    expected_fields = {
        "Package": PKG_NAME,
        "Version": PKG_VERSION,
        "Depends": ", ".join(DEPENDENCIES),
        "Source": PKG_ORIGIN,
        "SourceName": PKG_NAME,
        "License": PKG_LICENSE,
        "Section": "luci",
        "SourceDateEpoch": str(package_mtime),
        "URL": PKG_URL,
        "Maintainer": PKG_MAINTAINER,
        "Architecture": PKG_ARCH_IPK,
        "Description": (
            f"{PKG_DESCRIPTION}\n"
            "Browser playback and attested fail-closed software CPU rendering for local media.\n"
            "Remote HTTP(S) URLs are browser-only. Application files are "
            "architecture-independent."
        ),
    }
    require(
        set(fields) == set(expected_fields) | {"Installed-Size"},
        "IPK control field set is incorrect",
    )
    for field, expected_value in expected_fields.items():
        require(
            fields.get(field) == expected_value,
            f"Wrong IPK {field} metadata",
        )
    try:
        installed_size = int(fields.get("Installed-Size", ""), 10)
    except ValueError as exc:
        raise PackageVerificationError("IPK Installed-Size is not an integer") from exc
    require(
        fields["Installed-Size"] == str(installed_size),
        "IPK Installed-Size is not in canonical decimal form",
    )
    require(
        installed_size == data_tar_size,
        "IPK Installed-Size does not match the uncompressed data tar",
    )

    require("conffiles" in control_members, "IPK has no conffiles metadata")
    conffiles, conffiles_mode, _ = control_members["conffiles"]
    require(conffiles_mode == MODE_FILE, "IPK conffiles mode must be 0644")
    require(
        conffiles.decode("utf-8").splitlines() == CONFFILES,
        "IPK conffiles metadata is incorrect",
    )

    build_packages = load_builder_module()
    expected_scripts = {
        "preinst": build_packages.preinst_script(),
        "postinst": build_packages.postinst_script(),
        "prerm": build_packages.prerm_script(),
        "postrm": build_packages.postrm_script(),
    }
    for name, expected_script in expected_scripts.items():
        verify_script(control_members, name, expected_script)
        verify_lifecycle_contract(name, expected_script)

    require(
        set(data_members) == set(expected),
        "IPK payload paths differ from package sources",
    )
    require(
        set(data_directories) == expected_archive_directories(expected),
        "IPK payload directory tree differs from package sources",
    )
    for name, (_, member_mtime) in data_directories.items():
        require(member_mtime == package_mtime, f"Wrong IPK directory mtime for /{name}")
    for path, (expected_data, expected_mode) in expected.items():
        actual_data, actual_mode, member_mtime = data_members[path]
        require(actual_data == expected_data, f"IPK payload differs: /{path}")
        require(actual_mode == expected_mode, f"Wrong IPK mode for /{path}")
        require(member_mtime == package_mtime, f"Wrong IPK mtime for /{path}")
    return package_mtime


class AdbReader:
    TYPE_INT = 0x10000000
    TYPE_INT32 = 0x20000000
    TYPE_BLOB8 = 0x80000000
    TYPE_BLOB16 = 0x90000000
    TYPE_BLOB32 = 0xA0000000
    TYPE_ARRAY = 0xD0000000
    TYPE_OBJECT = 0xE0000000

    def __init__(self, data: bytes):
        self.data = data
        require(len(data) >= 8, "ADB metadata block is too short")

    @staticmethod
    def value_type(value: int) -> int:
        return value & 0xF0000000

    @staticmethod
    def value_offset(value: int) -> int:
        return value & 0x0FFFFFFF

    def _u32(self, offset: int) -> int:
        require(offset + 4 <= len(self.data), "ADB offset is outside metadata")
        return struct.unpack_from("<I", self.data, offset)[0]

    def root(self) -> int:
        return self._u32(4)

    def integer(self, value: int) -> int:
        kind = self.value_type(value)
        if kind == self.TYPE_INT:
            return self.value_offset(value)
        require(kind == self.TYPE_INT32, "ADB value is not an integer")
        return self._u32(self.value_offset(value))

    def blob(self, value: int) -> bytes:
        kind = self.value_type(value)
        offset = self.value_offset(value)
        if kind == self.TYPE_BLOB8:
            require(offset + 1 <= len(self.data), "Truncated ADB blob8")
            size = self.data[offset]
            offset += 1
        elif kind == self.TYPE_BLOB16:
            require(offset + 2 <= len(self.data), "Truncated ADB blob16")
            size = struct.unpack_from("<H", self.data, offset)[0]
            offset += 2
        elif kind == self.TYPE_BLOB32:
            size = self._u32(offset)
            offset += 4
        else:
            raise PackageVerificationError("ADB value is not a blob")
        require(offset + size <= len(self.data), "ADB blob exceeds metadata bounds")
        return self.data[offset : offset + size]

    def string(self, value: int) -> str:
        try:
            return self.blob(value).decode("utf-8")
        except UnicodeDecodeError as exc:
            raise PackageVerificationError("ADB string is not UTF-8") from exc

    def collection(self, value: int, expected_type: int) -> dict[int, int]:
        require(self.value_type(value) == expected_type, "Wrong ADB collection type")
        offset = self.value_offset(value)
        count = self._u32(offset)
        require(count >= 1, "ADB collection has an invalid count")
        require(
            count <= MAX_ADB_COLLECTION_ITEMS,
            "ADB collection count is unreasonable",
        )
        require(offset + count * 4 <= len(self.data), "Truncated ADB collection")
        return {
            index: self._u32(offset + index * 4)
            for index in range(1, count)
        }

    def object(self, value: int) -> dict[int, int]:
        fields = self.collection(value, self.TYPE_OBJECT)
        return {index: field for index, field in fields.items() if field != 0}

    def array(self, value: int) -> list[int]:
        fields = self.collection(value, self.TYPE_ARRAY)
        return [fields[index] for index in sorted(fields)]


def parse_apk_blocks(apk: bytes) -> tuple[bytes, list[tuple[int, int, bytes]]]:
    require(apk.startswith(b"ADBd"), "APK does not use the ADBd envelope")
    stream = decompress_limited(
        apk[4:],
        wbits=-15,
        max_output_bytes=MAX_APK_STREAM_BYTES,
        label="APK",
    )
    require(stream.startswith(b"ADB."), "APK has no inner ADB header")
    require(len(stream) >= 8, "APK inner stream is too short")
    require(struct.unpack_from("<I", stream, 4)[0] == APK_SCHEMA_PACKAGE, "Wrong APK schema")

    metadata_blocks: list[bytes] = []
    data_blocks: list[tuple[int, int, bytes]] = []
    position = 8
    block_count = 0
    while position < len(stream):
        block_count += 1
        require(block_count <= MAX_APK_BLOCKS, "APK contains too many blocks")
        require(position + 4 <= len(stream), "Truncated APK block header")
        type_size = struct.unpack_from("<I", stream, position)[0]
        block_type = type_size >> 30
        block_size = type_size & 0x3FFFFFFF
        require(block_size >= 4, "APK block size is invalid")
        block_end = position + block_size
        require(block_end <= len(stream), "APK block exceeds stream bounds")
        payload = stream[position + 4 : block_end]

        if block_type == 0:
            metadata_blocks.append(payload)
        elif block_type == 2:
            require(len(payload) >= 8, "APK DATA block is too short")
            directory_index, file_index = struct.unpack_from("<II", payload, 0)
            require(directory_index > 0 and file_index > 0, "APK DATA index is zero")
            data_blocks.append((directory_index, file_index, payload[8:]))
        else:
            raise PackageVerificationError(f"Unexpected unsigned APK block type: {block_type}")

        aligned_end = (block_end + 7) & ~7
        require(aligned_end <= len(stream), "APK alignment exceeds stream")
        require(
            not any(stream[block_end:aligned_end]),
            "APK block padding contains non-zero bytes",
        )
        position = aligned_end

    require(position == len(stream), "APK block parser did not consume the stream")
    require(len(metadata_blocks) == 1, "APK must contain exactly one metadata block")
    return metadata_blocks[0], data_blocks


@lru_cache(maxsize=1)
def load_builder_module():
    builder_path = ROOT / "scripts" / "build-packages.py"
    spec = importlib.util.spec_from_file_location("_videoplayer_package_builder", builder_path)
    require(spec is not None and spec.loader is not None, "Cannot load package builder")
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    except (ImportError, OSError) as exc:
        raise PackageVerificationError(f"Cannot load package builder: {exc}") from exc
    return module


def expected_apk_scripts() -> dict[int, bytes]:
    build_packages = load_builder_module()
    return {
        2: build_packages.preinst_script(),
        3: build_packages.postinst_script(),
        4: build_packages.prerm_script(),
        5: build_packages.postrm_script(),
        6: build_packages.preupgrade_script(),
        7: build_packages.postupgrade_script(),
    }


def expected_apk_uid(payload: dict[str, tuple[bytes, int]]) -> bytes:
    script_fields = expected_apk_scripts()
    scripts = [
        ("pre-install", script_fields[2]),
        ("post-install", script_fields[3]),
        ("pre-deinstall", script_fields[4]),
        ("post-deinstall", script_fields[5]),
        ("pre-upgrade", script_fields[6]),
        ("post-upgrade", script_fields[7]),
    ]
    digest = hashlib.sha256()
    for value in (
        PKG_NAME,
        PKG_VERSION,
        PKG_DESCRIPTION,
        PKG_ARCH_APK,
        PKG_LICENSE,
        PKG_MAINTAINER,
        PKG_URL,
        *DEPENDENCIES,
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


def verify_apk_acl(
    reader: AdbReader,
    value: int,
    expected_mode: int,
    label: str,
) -> None:
    acl = reader.object(value)
    require(set(acl) == {1, 2, 3}, f"APK {label} ACL is incomplete")
    require(reader.integer(acl[1]) == expected_mode, f"Wrong APK mode for {label}")
    require(reader.string(acl[2]) == "root", f"Wrong APK owner for {label}")
    require(reader.string(acl[3]) == "root", f"Wrong APK group for {label}")


def verify_apk_paths(
    reader: AdbReader,
    paths_value: int,
    expected: dict[str, tuple[bytes, int]],
    expected_mtime: int,
    data_blocks: list[tuple[int, int, bytes]],
) -> None:
    paths = reader.object(paths_value)
    require(paths, "APK paths object is empty")
    require(
        sorted(paths) == list(range(1, len(paths) + 1)),
        "APK directory indices are not contiguous",
    )

    expected_dirs = {""}
    expected_names_by_dir: dict[str, list[str]] = {}
    for path in expected:
        parts = path.split("/")
        require(all(parts), f"Expected APK path contains an empty component: {path}")
        for index in range(len(parts)):
            expected_dirs.add("/".join(parts[:index]))
        parent = "/".join(parts[:-1])
        expected_names_by_dir.setdefault(parent, []).append(parts[-1])

    expected_dir_order = sorted(expected_dirs, key=lambda path: (path.count("/"), path))
    actual_dir_order: list[str] = []
    indexed_files: dict[tuple[int, int], tuple[str, bytes]] = {}
    actual_paths: set[str] = set()

    for directory_index in sorted(paths):
        directory = reader.object(paths[directory_index])
        require(2 in directory, f"APK directory {directory_index} has no ACL")
        require(
            set(directory) <= {1, 2, 3},
            f"APK directory {directory_index} has unexpected fields",
        )

        if 1 in directory:
            directory_name = reader.string(directory[1])
            require(directory_name, f"APK directory {directory_index} has an empty name")
            require(
                normalize_archive_name(directory_name) == directory_name,
                f"APK directory path is not normalized: {directory_name}",
            )
        else:
            directory_name = ""
            require(directory_index == 1, "APK root directory has the wrong index")

        actual_dir_order.append(directory_name)
        verify_apk_acl(reader, directory[2], 0o755, f"directory /{directory_name}")

        file_values = reader.array(directory[3]) if 3 in directory else []
        actual_names: list[str] = []
        for file_index, file_value in enumerate(file_values, start=1):
            file_info = reader.object(file_value)
            require(
                set(file_info) == {1, 2, 3, 4, 5},
                f"APK file metadata is incomplete in /{directory_name}",
            )
            file_name = reader.string(file_info[1])
            require(
                file_name not in {"", ".", ".."} and "/" not in file_name,
                f"APK has an invalid filename: {file_name!r}",
            )
            path = f"{directory_name}/{file_name}" if directory_name else file_name
            require(
                normalize_archive_name(path) == path,
                f"APK file path is not normalized: {path}",
            )
            require(path not in actual_paths, f"Duplicate APK payload path: /{path}")
            require(path in expected, f"Unexpected APK payload path: /{path}")

            expected_data, expected_mode = expected[path]
            verify_apk_acl(reader, file_info[2], expected_mode, f"file /{path}")
            require(
                reader.integer(file_info[3]) == len(expected_data),
                f"Wrong APK size for /{path}",
            )
            require(
                reader.integer(file_info[4]) == expected_mtime,
                f"Wrong APK mtime for /{path}",
            )
            require(
                reader.blob(file_info[5]) == hashlib.sha256(expected_data).digest(),
                f"Wrong APK file hash for /{path}",
            )

            key = (directory_index, file_index)
            require(key not in indexed_files, f"Duplicate APK DATA index: {key}")
            indexed_files[key] = (path, expected_data)
            actual_paths.add(path)
            actual_names.append(file_name)

        require(
            actual_names == sorted(expected_names_by_dir.get(directory_name, [])),
            f"APK file order or set is wrong in /{directory_name}",
        )

    require(actual_dir_order == expected_dir_order, "APK directory tree is incorrect")
    require(actual_paths == set(expected), "APK payload path set differs from sources")

    actual_data: dict[tuple[int, int], bytes] = {}
    for directory_index, file_index, data in data_blocks:
        key = (directory_index, file_index)
        require(key not in actual_data, f"Duplicate APK DATA block index: {key}")
        actual_data[key] = data
    require(
        set(actual_data) == set(indexed_files),
        "APK DATA block indices differ from file metadata",
    )
    for key, (path, expected_data) in indexed_files.items():
        require(actual_data[key] == expected_data, f"APK DATA differs for /{path}")


def verify_apk(
    apk_path: Path,
    expected: dict[str, tuple[bytes, int]],
    expected_uid: bytes | None,
    expected_mtime: int,
) -> None:
    require(apk_path.is_file(), f"APK does not exist: {apk_path}")
    adb_data, data_blocks = parse_apk_blocks(
        read_limited_file(apk_path, MAX_PACKAGE_FILE_BYTES, "APK")
    )
    reader = AdbReader(adb_data)

    root = reader.object(reader.root())
    require(set(root) == {1, 2, 3}, "APK root object is incorrect")
    info = reader.object(root[1])
    scripts = reader.object(root[3])
    expected_info_fields = {1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 15, 16, 21}
    require(set(info) == expected_info_fields, "APK package metadata fields are incorrect")

    require(reader.string(info[1]) == PKG_NAME, "Wrong APK package name")
    require(reader.string(info[2]) == PKG_VERSION, "Wrong APK version")
    require(reader.string(info[4]) == PKG_DESCRIPTION, "Wrong APK description")
    require(reader.string(info[5]) == PKG_ARCH_APK, "Wrong APK architecture")
    require(reader.string(info[6]) == PKG_LICENSE, "Wrong APK license")
    require(reader.string(info[7]) == PKG_ORIGIN, "Wrong APK origin")
    require(reader.string(info[8]) == PKG_MAINTAINER, "Wrong APK maintainer")
    require(reader.string(info[9]) == PKG_URL, "Wrong APK project URL")

    apk_depends: set[str] = set()
    for item in reader.array(info[15]):
        dependency = reader.object(item)
        require(set(dependency) == {1}, "APK dependency metadata is malformed")
        apk_depends.add(reader.string(dependency[1]))
    require(
        apk_depends == REQUIRED_DEPENDS | {"libc"},
        "APK runtime dependency set is incorrect",
    )

    apk_provides: set[str] = set()
    for item in reader.array(info[16]):
        provided = reader.object(item)
        require(set(provided) == {1}, "APK provides metadata is malformed")
        apk_provides.add(reader.string(provided[1]))
    require(apk_provides == {f"{PKG_NAME}-any"}, "APK provides metadata is wrong")
    require(
        [reader.string(item) for item in reader.array(info[21])]
        == ["openwrt:section=luci"],
        "APK tags metadata is wrong",
    )

    computed_hash = expected_apk_uid(expected)
    if expected_uid is not None:
        require(expected_uid == computed_hash, "Builder and verifier APK UIDs differ")
    require(
        len(computed_hash) == APK_UID_SIZE,
        "Expected APK UID is not the 20-byte SHA-256 prefix used by apk v3",
    )
    require(
        reader.blob(info[3]) == computed_hash,
        "APK SHA-256 content UID prefix is wrong",
    )
    require(
        reader.integer(info[12]) == sum(len(data) for data, _ in expected.values()),
        "APK installed-size is wrong",
    )

    expected_scripts = expected_apk_scripts()
    require(set(scripts) == set(expected_scripts), "APK lifecycle script set is incomplete")
    for field, expected_script in expected_scripts.items():
        lifecycle_name = {
            2: "preinst",
            3: "postinst",
            4: "prerm",
            5: "postrm",
            6: "preupgrade",
            7: "postupgrade",
        }[field]
        verify_lifecycle_contract(lifecycle_name, expected_script)
        require(
            reader.blob(scripts[field]) == expected_script,
            f"APK lifecycle script {field} differs from the builder",
        )

    verify_apk_paths(reader, root[2], expected, expected_mtime, data_blocks)


def verify_packages(
    ipk_path: Path,
    apk_path: Path,
    *,
    expected_apk_uid: bytes | None = None,
) -> None:
    package_payload = source_payload()
    source_epoch = verify_ipk(ipk_path, package_payload)
    verify_apk(
        apk_path,
        apk_expected_payload(package_payload),
        expected_apk_uid,
        source_epoch,
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "ipk",
        nargs="?",
        type=Path,
        default=DIST / f"{PKG_NAME}_{PKG_VERSION}_{PKG_ARCH_IPK}.ipk",
    )
    parser.add_argument(
        "apk",
        nargs="?",
        type=Path,
        default=DIST / f"{PKG_NAME}-{PKG_VERSION}.apk",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    verify_packages(args.ipk.resolve(), args.apk.resolve())
    print(f"IPK verified: {args.ipk}")
    print(f"APK verified: {args.apk}")
    print("ALL PACKAGE CHECKS PASSED")


if __name__ == "__main__":
    try:
        main()
    except (OSError, PackageVerificationError) as exc:
        raise SystemExit(f"ERROR: {exc}") from exc
