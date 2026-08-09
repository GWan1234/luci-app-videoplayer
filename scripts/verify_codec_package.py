#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Verify one architecture-specific OpenWrt codec runtime package."""

from __future__ import annotations

import argparse
import hashlib
import re
import struct
from dataclasses import dataclass
from pathlib import Path

import codec_matrix
import verify_packages

PACKAGE_NAME = "luci-videoplayer-codec-runtime"
PACKAGE_VERSION = "6.1.4-r3"
FFMPEG_PATH = "usr/libexec/videoplayer-ffmpeg/ffmpeg"
RELAY_PATH = "usr/libexec/videoplayer-ffmpeg/videoplayer-mjpeg-relay"
BUILD_INFO_PATH = "usr/share/luci-videoplayer-codec-runtime/build-info"
APK_LIST_PATH = f"lib/apk/packages/{PACKAGE_NAME}.list"

MODE_FILE = 0o644
MODE_EXEC = 0o755
MAX_CODEC_PACKAGE_BYTES = 64 * 1024 * 1024
MAX_BUILD_INFO_BYTES = 16 * 1024
MAX_CODEC_PAYLOAD_BYTES = 128 * 1024 * 1024
MAX_CODEC_PAYLOAD_FILES = 16
MIN_FFMPEG_BYTES = 1024 * 1024
MIN_RELAY_BYTES = 4 * 1024
MAX_RELAY_BYTES = 1024 * 1024
MAX_SCRIPT_BYTES = 32 * 1024
BUILD_INFO_KEY = re.compile(r"^[a-z][a-z0-9_]*$")
EXPECTED_BUILD_INFO_KEYS = {
    "format",
    "openwrt_release",
    "openwrt_revision",
    "compatible_arch",
    "build_target",
    "build_subtarget",
    "sdk_sha256",
    "packages_feed_commit",
    "ffmpeg_version",
    "package_format",
    "validation_mode",
    "renderer_profile",
    "build_patented",
    "network_enabled",
    "avdevice_enabled",
    "swresample_enabled",
    "audio_output",
    "audio_sample_rate",
    "audio_channels",
    "audio_chunk_frames",
    "audio_chunk_bytes",
    "private_binary",
}
EXPECTED_IPK_CONTROL_FIELDS = {
    "Package",
    "Version",
    "Depends",
    "Source",
    "SourceName",
    "License",
    "LicenseFiles",
    "Section",
    "SourceDateEpoch",
    "URL",
    "CPE-ID",
    "Maintainer",
    "Architecture",
    "Installed-Size",
    "Description",
}


class CodecPackageVerificationError(RuntimeError):
    """Raised when a codec package is malformed or targets the wrong ABI."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise CodecPackageVerificationError(message)


@dataclass(frozen=True)
class ElfIdentity:
    elf_class: int
    byte_order: int
    machine: int


def _identity_map(
    architectures: tuple[str, ...],
    *,
    elf_class: int,
    byte_order: int,
    machine: int,
) -> dict[str, ElfIdentity]:
    identity = ElfIdentity(elf_class, byte_order, machine)
    return {architecture: identity for architecture in architectures}


# ELF constants come from the System V ABI and Linux elf-em.h. Package ABI names
# are OpenWrt's DISTRIB_ARCH values; CPU-tuning suffixes cannot be distinguished
# by the generic ELF header and are therefore enforced by package/build metadata.
ELF_IDENTITIES = {
    **_identity_map(
        (
            "aarch64_cortex-a53",
            "aarch64_cortex-a72",
            "aarch64_cortex-a76",
            "aarch64_generic",
        ),
        elf_class=2,
        byte_order=1,
        machine=183,
    ),
    **_identity_map(
        (
            "arm_arm1176jzf-s_vfp",
            "arm_arm926ej-s",
            "arm_cortex-a15_neon-vfpv4",
            "arm_cortex-a5_vfpv4",
            "arm_cortex-a7",
            "arm_cortex-a7_neon-vfpv4",
            "arm_cortex-a7_vfpv4",
            "arm_cortex-a8_vfpv3",
            "arm_cortex-a9",
            "arm_cortex-a9_neon",
            "arm_cortex-a9_vfpv3-d16",
            "arm_fa526",
            "arm_xscale",
        ),
        elf_class=1,
        byte_order=1,
        machine=40,
    ),
    **_identity_map(
        ("armeb_xscale",),
        elf_class=1,
        byte_order=2,
        machine=40,
    ),
    **_identity_map(
        ("i386_pentium-mmx", "i386_pentium4"),
        elf_class=1,
        byte_order=1,
        machine=3,
    ),
    **_identity_map(
        ("loongarch64_generic",),
        elf_class=2,
        byte_order=1,
        machine=258,
    ),
    **_identity_map(
        ("mips64_mips64r2", "mips64_octeonplus"),
        elf_class=2,
        byte_order=2,
        machine=8,
    ),
    **_identity_map(
        ("mips64el_mips64r2",),
        elf_class=2,
        byte_order=1,
        machine=8,
    ),
    **_identity_map(
        ("mips_24kc", "mips_4kec", "mips_mips32"),
        elf_class=1,
        byte_order=2,
        machine=8,
    ),
    **_identity_map(
        ("mipsel_24kc", "mipsel_24kc_24kf", "mipsel_74kc", "mipsel_mips32"),
        elf_class=1,
        byte_order=1,
        machine=8,
    ),
    **_identity_map(
        ("powerpc64_e5500",),
        elf_class=2,
        byte_order=2,
        machine=21,
    ),
    **_identity_map(
        ("powerpc_464fp", "powerpc_8548"),
        elf_class=1,
        byte_order=2,
        machine=20,
    ),
    **_identity_map(
        ("riscv64_generic", "riscv64_riscv64"),
        elf_class=2,
        byte_order=1,
        machine=243,
    ),
    **_identity_map(
        ("x86_64",),
        elf_class=2,
        byte_order=1,
        machine=62,
    ),
}


def read_build_info(path: Path) -> tuple[bytes, dict[str, str]]:
    try:
        data = verify_packages.read_limited_file(
            path, MAX_BUILD_INFO_BYTES, "external BUILD_INFO"
        )
    except verify_packages.PackageVerificationError as exc:
        raise CodecPackageVerificationError(str(exc)) from exc
    require(data.endswith(b"\n"), "BUILD_INFO must end with one LF")
    require(
        b"\r" not in data and b"\x00" not in data, "BUILD_INFO is not canonical text"
    )
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise CodecPackageVerificationError("BUILD_INFO is not UTF-8") from exc

    values: dict[str, str] = {}
    for line_number, line in enumerate(text.splitlines(), start=1):
        require(line != "" and "=" in line, f"Malformed BUILD_INFO line {line_number}")
        key, value = line.split("=", 1)
        require(
            BUILD_INFO_KEY.fullmatch(key) is not None,
            f"Malformed BUILD_INFO key at line {line_number}: {key!r}",
        )
        require(key not in values, f"Duplicate BUILD_INFO key: {key}")
        require(
            value != "" and all(character.isprintable() for character in value),
            f"Unsafe BUILD_INFO value for {key}",
        )
        values[key] = value

    require(
        set(values) == EXPECTED_BUILD_INFO_KEYS,
        "BUILD_INFO field set differs from the codec runtime schema",
    )
    return data, values


def validate_build_info(
    values: dict[str, str], *, package_format: str, architecture: str
) -> dict[str, str]:
    matrix = codec_matrix.load_matrix()
    matches = [
        entry
        for entry in codec_matrix.build_entries(matrix)
        if entry["format"] == package_format and entry["arch"] == architecture
    ]
    require(
        len(matches) == 1,
        f"No unique pinned matrix entry exists for {package_format}/{architecture}",
    )
    entry = matches[0]
    expected = {
        "format": "3",
        "openwrt_release": entry["release"],
        "openwrt_revision": entry["revision"],
        "compatible_arch": architecture,
        "build_target": entry["target"],
        "build_subtarget": entry["subtarget"],
        "sdk_sha256": entry["sdk_sha256"],
        "packages_feed_commit": entry["packages_feed_commit"],
        "ffmpeg_version": "6.1.4",
        "package_format": package_format,
        "validation_mode": entry["validation_mode"],
        "renderer_profile": "buffered-tee-v1",
        "build_patented": "y",
        "network_enabled": "n",
        "avdevice_enabled": "n",
        "swresample_enabled": "y",
        "audio_output": "pcm_s16le",
        "audio_sample_rate": "48000",
        "audio_channels": "2",
        "audio_chunk_frames": "12000",
        "audio_chunk_bytes": "48000",
        "private_binary": f"/{FFMPEG_PATH}",
    }
    for key, value in expected.items():
        require(values[key] == value, f"BUILD_INFO {key} is incorrect")
    return entry


def verify_elf(
    data: bytes,
    architecture: str,
    *,
    label: str = "Private FFmpeg",
    minimum_bytes: int = MIN_FFMPEG_BYTES,
    maximum_bytes: int = MAX_CODEC_PAYLOAD_BYTES,
    required_markers: tuple[bytes, ...] = (
        b"configuration:",
        b"libavcodec",
        b"libavformat",
        b"h264",
        b"hevc",
        b"mjpeg",
        b"pcm_s16le",
    ),
) -> None:
    require(
        set(ELF_IDENTITIES) == codec_matrix.EXPECTED_ARCHITECTURES,
        "ELF identity table does not cover the complete architecture matrix",
    )
    require(
        architecture in ELF_IDENTITIES, f"Unsupported ELF architecture: {architecture}"
    )
    identity = ELF_IDENTITIES[architecture]

    require(
        minimum_bytes <= len(data) <= maximum_bytes,
        f"{label} ELF size is outside the expected safety range",
    )
    require(data[:4] == b"\x7fELF", f"{label} payload is not an ELF executable")
    require(data[4] == identity.elf_class, f"Wrong ELF class for {architecture}")
    require(data[5] == identity.byte_order, f"Wrong ELF byte order for {architecture}")
    require(data[6] == 1, "Unsupported ELF identification version")
    require(data[7] in {0, 3}, "Unexpected ELF OS ABI")

    endian = "<" if identity.byte_order == 1 else ">"
    elf_type, machine, version = struct.unpack_from(f"{endian}HHI", data, 16)
    require(elf_type in {2, 3}, f"{label} ELF is not executable or PIE")
    require(machine == identity.machine, f"Wrong ELF machine for {architecture}")
    require(version == 1, "Unsupported ELF header version")

    if identity.elf_class == 1:
        entry_point, program_offset = struct.unpack_from(f"{endian}II", data, 24)
        header_size = struct.unpack_from(f"{endian}H", data, 40)[0]
        program_entry_size, program_count = struct.unpack_from(f"{endian}HH", data, 42)
        require(header_size == 52, "Wrong ELF32 header size")
        minimum_program_entry_size = 32
    else:
        entry_point, program_offset = struct.unpack_from(f"{endian}QQ", data, 24)
        header_size = struct.unpack_from(f"{endian}H", data, 52)[0]
        program_entry_size, program_count = struct.unpack_from(f"{endian}HH", data, 54)
        require(header_size == 64, "Wrong ELF64 header size")
        minimum_program_entry_size = 56

    require(entry_point != 0, f"{label} ELF has no entry point")
    require(
        program_entry_size >= minimum_program_entry_size,
        f"{label} ELF program-header entries are too small",
    )
    require(
        1 <= program_count <= 128,
        f"{label} ELF program-header count is invalid",
    )
    require(
        program_offset >= header_size
        and program_offset + program_entry_size * program_count <= len(data),
        f"{label} ELF program-header table is outside the file",
    )

    executable_load = False
    entry_in_executable_load = False
    executable_payload = bytearray()
    load_count = 0
    dynamic_count = 0
    interpreter = b""
    for index in range(program_count):
        offset = program_offset + index * program_entry_size
        segment_type = struct.unpack_from(f"{endian}I", data, offset)[0]
        if identity.elf_class == 1:
            (
                segment_offset,
                virtual_address,
                _physical_address,
                file_size,
                memory_size,
                flags,
            ) = struct.unpack_from(f"{endian}IIIIII", data, offset + 4)
        else:
            flags = struct.unpack_from(f"{endian}I", data, offset + 4)[0]
            (
                segment_offset,
                virtual_address,
                _physical_address,
                file_size,
                memory_size,
            ) = struct.unpack_from(f"{endian}QQQQQ", data, offset + 8)
        require(
            segment_offset <= len(data) and file_size <= len(data) - segment_offset,
            f"{label} ELF segment exceeds the file",
        )
        if segment_type in {1, 7}:
            require(
                file_size <= memory_size,
                f"{label} ELF load/TLS file size exceeds memory size",
            )
        if segment_type == 1:
            load_count += 1
            if flags & 1 and file_size:
                executable_load = True
                executable_payload.extend(
                    data[segment_offset : segment_offset + file_size]
                )
                entry_in_executable_load |= (
                    virtual_address <= entry_point < virtual_address + memory_size
                )
        elif segment_type == 2:
            dynamic_count += 1
        elif segment_type == 3:
            require(not interpreter, f"{label} ELF has duplicate interpreters")
            interpreter = data[segment_offset : segment_offset + file_size]

    require(executable_load, f"{label} ELF has no executable PT_LOAD segment")
    require(
        entry_in_executable_load,
        f"{label} ELF entry point is outside its executable segments",
    )
    require(load_count >= 2, f"{label} ELF has too few PT_LOAD segments")
    require(dynamic_count == 1, f"{label} ELF must have one PT_DYNAMIC segment")
    require(
        interpreter.startswith(b"/lib/ld-musl-")
        and interpreter.endswith(b".so.1\x00")
        and b"\x00" not in interpreter[:-1],
        f"{label} ELF has an unexpected dynamic interpreter",
    )
    require(
        len(set(executable_payload)) >= 128
        and sum(byte != 0 for byte in executable_payload)
        >= len(executable_payload) // 4,
        f"{label} executable segment has implausible byte content",
    )
    for marker in required_markers:
        require(marker in data, f"{label} ELF is missing marker {marker!r}")


def normalize_script(data: bytes, label: str) -> list[str]:
    require(0 < len(data) <= MAX_SCRIPT_BYTES, f"{label} size is invalid")
    require(b"\x00" not in data and b"\r" not in data, f"{label} is not canonical text")
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise CodecPackageVerificationError(f"{label} is not UTF-8") from exc
    require(text.endswith("\n"), f"{label} must end with LF")
    return [line.strip() for line in text.splitlines() if line.strip()]


def preinst_lines(values: dict[str, str]) -> list[str]:
    release = values["openwrt_release"]
    revision = values["openwrt_revision"]
    architecture = values["compatible_arch"]
    return [
        "#!/bin/sh",
        'if [ -z "${IPKG_INSTROOT:-}" ]; then',
        "[ -r /etc/openwrt_release ] || {",
        'echo "This codec runtime can only be installed on OpenWrt." >&2',
        "exit 1",
        "}",
        ". /etc/openwrt_release",
        f'[ "${{DISTRIB_RELEASE:-}}" = "{release}" ] &&',
        f'[ "${{DISTRIB_REVISION:-}}" = "{revision}" ] &&',
        f'[ "${{DISTRIB_ARCH:-}}" = "{architecture}" ] || {{',
        (
            f'echo "This codec runtime requires OpenWrt {release} {revision}, '
            f'architecture {architecture}." >&2'
        ),
        "exit 1",
        "}",
        "fi",
        "exit 0",
    ]


def ipk_default_postinst_lines() -> list[str]:
    return [
        "#!/bin/sh",
        '[ "${IPKG_NO_SCRIPT}" = "1" ] && exit 0',
        "[ -s ${IPKG_INSTROOT}/lib/functions.sh ] || exit 0",
        ". ${IPKG_INSTROOT}/lib/functions.sh",
        "default_postinst $0 $@",
    ]


def ipk_default_prerm_lines() -> list[str]:
    return [
        "#!/bin/sh",
        "[ -s ${IPKG_INSTROOT}/lib/functions.sh ] || exit 0",
        ". ${IPKG_INSTROOT}/lib/functions.sh",
        "default_prerm $0 $@",
    ]


def apk_post_install_lines() -> list[str]:
    return [
        "#!/bin/sh",
        '[ "${IPKG_NO_SCRIPT}" = "1" ] && exit 0',
        "[ -s ${IPKG_INSTROOT}/lib/functions.sh ] || exit 0",
        ". ${IPKG_INSTROOT}/lib/functions.sh",
        'export root="${IPKG_INSTROOT}"',
        f'export pkgname="{PACKAGE_NAME}"',
        "add_group_and_user",
        "default_postinst",
    ]


def apk_pre_deinstall_lines() -> list[str]:
    return [
        "#!/bin/sh",
        "[ -s ${IPKG_INSTROOT}/lib/functions.sh ] || exit 0",
        ". ${IPKG_INSTROOT}/lib/functions.sh",
        'export root="${IPKG_INSTROOT}"',
        f'export pkgname="{PACKAGE_NAME}"',
        "default_prerm",
    ]


def verify_payload(
    payload: dict[str, tuple[bytes, int]],
    *,
    package_format: str,
    architecture: str,
    external_build_info: bytes,
    expected_binary: bytes | None,
) -> tuple[bytes, bytes]:
    expected_paths = {FFMPEG_PATH, RELAY_PATH, BUILD_INFO_PATH}
    if package_format == "apk":
        expected_paths.add(APK_LIST_PATH)
    require(
        set(payload) == expected_paths,
        "Codec package payload paths differ from the private runtime layout",
    )

    ffmpeg, ffmpeg_mode = payload[FFMPEG_PATH]
    relay, relay_mode = payload[RELAY_PATH]
    internal_info, info_mode = payload[BUILD_INFO_PATH]
    require(ffmpeg_mode == MODE_EXEC, "Private FFmpeg mode must be 0755")
    require(relay_mode == MODE_EXEC, "MJPEG relay mode must be 0755")
    require(info_mode == MODE_FILE, "Internal build-info mode must be 0644")
    require(
        internal_info == external_build_info,
        "Internal build-info does not match external BUILD_INFO byte-for-byte",
    )
    if expected_binary is not None:
        require(
            ffmpeg == expected_binary,
            "Packaged FFmpeg differs from the already validated build binary",
        )
    verify_elf(ffmpeg, architecture)
    verify_elf(
        relay,
        architecture,
        label="MJPEG relay",
        minimum_bytes=MIN_RELAY_BYTES,
        maximum_bytes=MAX_RELAY_BYTES,
        required_markers=(b"videoplayer-", b"Content-Length", b"image/jpeg"),
    )

    if package_format == "apk":
        package_list, list_mode = payload[APK_LIST_PATH]
        expected_list = (
            f"/{FFMPEG_PATH}\n/{RELAY_PATH}\n/{BUILD_INFO_PATH}\n"
        ).encode()
        require(list_mode == MODE_FILE, "APK package-list mode must be 0644")
        require(package_list == expected_list, "APK package-list content is incorrect")
    return ffmpeg, relay


def verify_ipk(
    package_path: Path,
    *,
    architecture: str,
    external_build_info: bytes,
    build_info_values: dict[str, str],
    expected_binary: bytes | None,
) -> tuple[bytes, bytes]:
    outer, outer_directories, _ = verify_packages.parse_tar_gz(
        verify_packages.read_limited_file(
            package_path, MAX_CODEC_PACKAGE_BYTES, "codec IPK"
        ),
        "codec IPK outer archive",
        allow_directories=False,
        max_output_bytes=verify_packages.MAX_IPK_OUTER_TAR_BYTES,
        max_members=verify_packages.MAX_OUTER_TAR_MEMBERS,
    )
    require(not outer_directories, "Codec IPK outer archive contains directories")
    require(
        set(outer) == {"debian-binary", "control.tar.gz", "data.tar.gz"},
        "Codec IPK outer member set is incorrect",
    )
    require(outer["debian-binary"][0] == b"2.0\n", "Invalid IPK debian-binary")

    control_members, control_directories, _ = verify_packages.parse_tar_gz(
        outer["control.tar.gz"][0],
        "codec IPK control.tar.gz",
        allow_directories=True,
        max_output_bytes=verify_packages.MAX_IPK_CONTROL_TAR_BYTES,
        max_members=verify_packages.MAX_CONTROL_TAR_MEMBERS,
    )
    require(
        set(control_members) == {"control", "preinst", "postinst", "prerm"},
        "Codec IPK control member set is incorrect",
    )
    require(
        set(control_directories) == {"."},
        "Codec IPK control directory set is incorrect",
    )
    control, control_mode, _ = control_members["control"]
    require(control_mode == MODE_FILE, "Codec IPK control mode must be 0644")
    fields = verify_packages.parse_control_fields(control)
    require(
        set(fields) == EXPECTED_IPK_CONTROL_FIELDS,
        "Codec IPK control metadata field set is incorrect",
    )
    expected_fields = {
        "Package": PACKAGE_NAME,
        "Version": PACKAGE_VERSION,
        "Depends": "libc",
        "SourceName": "ffmpeg",
        "License": ("LGPL-2.1-or-later GPL-2.0-or-later LGPL-3.0-or-later"),
        "Section": "multimedia",
        "URL": "https://github.com/communism420/luci-app-videoplayer",
        "CPE-ID": "cpe:/a:ffmpeg:ffmpeg",
        "Maintainer": "openwrt-video-player contributors",
        "Architecture": architecture,
    }
    for key, value in expected_fields.items():
        require(fields.get(key) == value, f"Wrong codec IPK {key} metadata")
    for numeric_field in ("SourceDateEpoch", "Installed-Size"):
        require(
            fields[numeric_field].isdigit() and int(fields[numeric_field]) > 0,
            f"Codec IPK {numeric_field} is not a positive integer",
        )
    expected_scripts = {
        "preinst": preinst_lines(build_info_values),
        "postinst": ipk_default_postinst_lines(),
        "prerm": ipk_default_prerm_lines(),
    }
    for name, expected_lines in expected_scripts.items():
        body, mode, _ = control_members[name]
        require(mode == MODE_EXEC, f"Codec IPK {name} mode must be 0755")
        require(
            normalize_script(body, f"codec IPK {name}") == expected_lines,
            f"Codec IPK {name} differs from the pinned lifecycle script",
        )

    data_members, _, _ = verify_packages.parse_tar_gz(
        outer["data.tar.gz"][0],
        "codec IPK data.tar.gz",
        allow_directories=True,
        max_output_bytes=MAX_CODEC_PAYLOAD_BYTES,
        max_members=MAX_CODEC_PAYLOAD_FILES + 32,
    )
    payload = {name: (body, mode) for name, (body, mode, _) in data_members.items()}
    return verify_payload(
        payload,
        package_format="ipk",
        architecture=architecture,
        external_build_info=external_build_info,
        expected_binary=expected_binary,
    )


def _apk_file_values(reader: verify_packages.AdbReader, value: int) -> list[int]:
    value_type = reader.value_type(value)
    if value_type == reader.TYPE_ARRAY:
        return reader.array(value)
    require(value_type == reader.TYPE_OBJECT, "APK file collection has the wrong type")
    items = reader.object(value)
    require(
        sorted(items) == list(range(1, len(items) + 1)),
        "APK file indices are not contiguous",
    )
    return [items[index] for index in sorted(items)]


def _apk_acl_mode(reader: verify_packages.AdbReader, value: int, label: str) -> int:
    acl = reader.object(value)
    require(set(acl) == {1, 2, 3}, f"APK {label} ACL is incomplete")
    require(reader.string(acl[2]) == "root", f"APK {label} owner is not root")
    require(reader.string(acl[3]) == "root", f"APK {label} group is not root")
    return reader.integer(acl[1]) & 0o7777


def extract_apk_payload(
    reader: verify_packages.AdbReader,
    paths_value: int,
    data_blocks: list[tuple[int, int, bytes]],
) -> dict[str, tuple[bytes, int]]:
    paths = reader.object(paths_value)
    require(paths, "Codec APK path table is empty")
    require(
        sorted(paths) == list(range(1, len(paths) + 1)),
        "Codec APK directory indices are not contiguous",
    )

    metadata: dict[tuple[int, int], tuple[str, int, int, bytes]] = {}
    seen_paths: set[str] = set()
    total_bytes = 0
    for directory_index in sorted(paths):
        directory = reader.object(paths[directory_index])
        require(2 in directory, "Codec APK directory has no ACL")
        require(
            set(directory) <= {1, 2, 3},
            "Codec APK directory metadata has unexpected fields",
        )
        directory_name = reader.string(directory[1]) if 1 in directory else ""
        if directory_name:
            require(
                verify_packages.normalize_archive_name(directory_name)
                == directory_name,
                f"Codec APK directory is not normalized: {directory_name}",
            )
        else:
            require(
                directory_index == 1, "Codec APK root directory has the wrong index"
            )
        require(
            _apk_acl_mode(reader, directory[2], f"directory /{directory_name}")
            == 0o755,
            f"Wrong codec APK directory mode: /{directory_name}",
        )

        file_values = _apk_file_values(reader, directory[3]) if 3 in directory else []
        for file_index, file_value in enumerate(file_values, start=1):
            require(
                len(metadata) < MAX_CODEC_PAYLOAD_FILES,
                "Codec APK contains too many files",
            )
            file_info = reader.object(file_value)
            require(
                set(file_info) == {1, 2, 3, 4, 5},
                "Codec APK file metadata is incomplete",
            )
            filename = reader.string(file_info[1])
            require(
                filename not in {"", ".", ".."} and "/" not in filename,
                f"Codec APK contains an unsafe filename: {filename!r}",
            )
            path = f"{directory_name}/{filename}" if directory_name else filename
            require(path not in seen_paths, f"Duplicate codec APK path: /{path}")
            require(
                verify_packages.normalize_archive_name(path) == path,
                f"Codec APK path is not normalized: /{path}",
            )
            size = reader.integer(file_info[3])
            require(
                0 <= size <= MAX_CODEC_PAYLOAD_BYTES - total_bytes,
                "Codec APK payload exceeds its safety limit",
            )
            total_bytes += size
            metadata[(directory_index, file_index)] = (
                path,
                _apk_acl_mode(reader, file_info[2], f"file /{path}"),
                size,
                reader.blob(file_info[5]),
            )
            seen_paths.add(path)

    actual_data: dict[tuple[int, int], bytes] = {}
    for directory_index, file_index, body in data_blocks:
        key = (directory_index, file_index)
        require(key not in actual_data, f"Duplicate codec APK DATA block: {key}")
        actual_data[key] = body
    require(
        set(actual_data) == set(metadata),
        "Codec APK DATA blocks differ from file metadata",
    )

    payload: dict[str, tuple[bytes, int]] = {}
    for key, (path, mode, size, expected_hash) in metadata.items():
        body = actual_data[key]
        require(len(body) == size, f"Wrong codec APK payload size for /{path}")
        require(
            hashlib.sha256(body).digest() == expected_hash,
            f"Wrong codec APK payload hash for /{path}",
        )
        payload[path] = (body, mode)
    return payload


def verify_apk(
    package_path: Path,
    *,
    architecture: str,
    external_build_info: bytes,
    build_info_values: dict[str, str],
    expected_binary: bytes | None,
) -> tuple[bytes, bytes]:
    adb_data, data_blocks = verify_packages.parse_apk_blocks(
        verify_packages.read_limited_file(
            package_path, MAX_CODEC_PACKAGE_BYTES, "codec APK"
        )
    )
    reader = verify_packages.AdbReader(adb_data)
    root = reader.object(reader.root())
    require(set(root) == {1, 2, 3}, "Codec APK root object is incorrect")
    info = reader.object(root[1])
    require(
        set(info) == {1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 15, 16},
        "Codec APK package metadata field set is incorrect",
    )
    require(reader.string(info[1]) == PACKAGE_NAME, "Wrong codec APK package name")
    require(reader.string(info[2]) == PACKAGE_VERSION, "Wrong codec APK version")
    require(reader.string(info[5]) == architecture, "Wrong codec APK architecture")
    require(
        len(reader.blob(info[3])) == verify_packages.APK_UID_SIZE, "Wrong APK UID size"
    )
    require(any(reader.blob(info[3])), "Codec APK UID must not be all zeroes")

    require(15 in info, "Codec APK dependency metadata is missing")
    dependencies: set[str] = set()
    for item in _apk_file_values(reader, info[15]):
        dependency = reader.object(item)
        require(set(dependency) == {1}, "Codec APK dependency metadata is malformed")
        dependencies.add(reader.string(dependency[1]))
    require(dependencies == {"libc"}, "Codec APK dependencies are not isolated")

    provides: set[str] = set()
    for item in _apk_file_values(reader, info[16]):
        provided = reader.object(item)
        require(set(provided) == {1}, "Codec APK provides metadata is malformed")
        provides.add(reader.string(provided[1]))
    require(
        provides == {f"{PACKAGE_NAME}-any"},
        "Codec APK provides metadata is incorrect",
    )

    scripts = reader.object(root[3])
    raw_preinst = preinst_lines(build_info_values)
    post_install = apk_post_install_lines()
    expected_scripts = {
        2: raw_preinst,
        3: post_install,
        4: apk_pre_deinstall_lines(),
        6: ["#!/bin/sh", "export PKG_UPGRADE=1", *raw_preinst[1:]],
        7: ["#!/bin/sh", "export PKG_UPGRADE=1", *post_install[1:]],
    }
    require(
        set(scripts) == set(expected_scripts),
        "Codec APK lifecycle script set is incorrect",
    )
    for field, expected_lines in expected_scripts.items():
        require(
            normalize_script(
                reader.blob(scripts[field]), f"codec APK lifecycle script {field}"
            )
            == expected_lines,
            f"Codec APK lifecycle script {field} differs from the pinned script",
        )

    payload = extract_apk_payload(reader, root[2], data_blocks)
    require(
        reader.integer(info[12]) == sum(len(body) for body, _ in payload.values()),
        "Codec APK installed-size does not match its payload",
    )
    return verify_payload(
        payload,
        package_format="apk",
        architecture=architecture,
        external_build_info=external_build_info,
        expected_binary=expected_binary,
    )


def verify_codec_package(
    package_path: Path,
    *,
    package_format: str,
    architecture: str,
    build_info_path: Path,
    expected_binary_path: Path | None = None,
) -> tuple[bytes, bytes]:
    require(package_format in {"apk", "ipk"}, "Package format must be apk or ipk")
    require(
        architecture in codec_matrix.EXPECTED_ARCHITECTURES,
        f"Architecture is not in the OpenWrt matrix: {architecture}",
    )
    require(
        package_path.is_file() and not package_path.is_symlink(),
        f"Codec package is missing or unsafe: {package_path}",
    )
    external_build_info, values = read_build_info(build_info_path)
    entry = validate_build_info(
        values, package_format=package_format, architecture=architecture
    )
    expected_filename = codec_matrix.codec_filename(
        codec_matrix.load_matrix(), package_format, architecture
    )
    require(
        package_path.name == expected_filename,
        f"Codec package filename differs from the pinned matrix: {package_path.name}",
    )
    require(
        entry["codec_file"] == expected_filename,
        "Codec filename generation differs inside the pinned matrix",
    )
    expected_binary = None
    if expected_binary_path is not None:
        try:
            expected_binary = verify_packages.read_limited_file(
                expected_binary_path,
                MAX_CODEC_PAYLOAD_BYTES,
                "validated build binary",
            )
        except verify_packages.PackageVerificationError as exc:
            raise CodecPackageVerificationError(str(exc)) from exc
        verify_elf(expected_binary, architecture)
    try:
        if package_format == "ipk":
            packaged_payloads = verify_ipk(
                package_path,
                architecture=architecture,
                external_build_info=external_build_info,
                build_info_values=values,
                expected_binary=expected_binary,
            )
        else:
            packaged_payloads = verify_apk(
                package_path,
                architecture=architecture,
                external_build_info=external_build_info,
                build_info_values=values,
                expected_binary=expected_binary,
            )
    except verify_packages.PackageVerificationError as exc:
        raise CodecPackageVerificationError(str(exc)) from exc
    return packaged_payloads


def write_verified_binary(destination: Path, packaged_binary: bytes) -> None:
    require(
        destination.parent.is_dir() and not destination.parent.is_symlink(),
        f"Extracted-binary parent is missing or unsafe: {destination.parent}",
    )
    require(
        not destination.exists() and not destination.is_symlink(),
        f"Refusing to overwrite extracted-binary path: {destination}",
    )
    created = False
    try:
        with destination.open("xb") as output:
            created = True
            output.write(packaged_binary)
        destination.chmod(MODE_EXEC)
    except OSError:
        if created and destination.is_file() and not destination.is_symlink():
            try:
                destination.unlink()
            except OSError:
                pass
        raise


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("package", type=Path)
    parser.add_argument("--format", choices=("apk", "ipk"), required=True)
    parser.add_argument("--architecture", required=True)
    parser.add_argument("--build-info", type=Path, required=True)
    parser.add_argument("--expected-binary", type=Path)
    parser.add_argument(
        "--extract-binary",
        type=Path,
        help="write the verified FFmpeg ELF from the package to a new file",
    )
    parser.add_argument(
        "--extract-relay",
        type=Path,
        help="write the verified MJPEG relay ELF from the package to a new file",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    packaged_binary, packaged_relay = verify_codec_package(
        args.package,
        package_format=args.format,
        architecture=args.architecture,
        build_info_path=args.build_info,
        expected_binary_path=args.expected_binary,
    )
    if args.extract_binary is not None:
        write_verified_binary(args.extract_binary, packaged_binary)
    if args.extract_relay is not None:
        write_verified_binary(args.extract_relay, packaged_relay)
    print(
        f"Codec package verified: {args.format.upper()} "
        f"{PACKAGE_VERSION} for {args.architecture}"
    )


if __name__ == "__main__":
    try:
        main()
    except (OSError, codec_matrix.MatrixError, CodecPackageVerificationError) as exc:
        raise SystemExit(f"ERROR: {exc}") from exc
