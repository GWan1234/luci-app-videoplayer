#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Validate and query the pinned OpenWrt codec-runtime build matrix."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MATRIX = ROOT / "codec-runtime" / "matrix.json"

APP_VERSION = "1.1.0"
CODEC_VERSION = "6.1.4"
CODEC_RELEASE = 2
CODEC_SOURCE_SHA256 = "a231e3d5742c44b1cdaebfb98ad7b6200d12763e0b6db9e1e2c5891f2c083a18"

EXPECTED_RELEASES = {
    "apk": {
        "openwrt_release": "25.12.5",
        "openwrt_revision": "r33051-f5dae5ece4",
        "status": "stable",
        "manager": "apk",
        "packages_feed_commit": "5caa62e0bc9f7fb9b0c12a23267bceb7724214dd",
        "feeds_buildinfo_sha256": (
            "e11279b01e7fea7f7d399e25e969d9382be6891071cbc1225804195224b27b52"
        ),
    },
    "ipk": {
        "openwrt_release": "24.10.8",
        "openwrt_revision": "r29233-443ec4032a",
        "status": "old-stable",
        "manager": "opkg",
        "packages_feed_commit": "23abaa6f3b0fdfd76b570031107e5718476ff0c8",
        "feeds_buildinfo_sha256": (
            "8abf2a8ca51671f8bae637cfc79d8dc2a07d9d5029f1f97c18e46a91d7760da3"
        ),
    },
}

COMMON_ARCHITECTURES = {
    "aarch64_cortex-a53",
    "aarch64_cortex-a72",
    "aarch64_cortex-a76",
    "aarch64_generic",
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
    "armeb_xscale",
    "i386_pentium-mmx",
    "i386_pentium4",
    "loongarch64_generic",
    "mips64_mips64r2",
    "mips64_octeonplus",
    "mips64el_mips64r2",
    "mips_24kc",
    "mips_mips32",
    "mipsel_24kc",
    "mipsel_24kc_24kf",
    "mipsel_74kc",
    "mipsel_mips32",
    "powerpc64_e5500",
    "powerpc_464fp",
    "powerpc_8548",
    "x86_64",
}
APK_ONLY_ARCHITECTURES = {"riscv64_generic"}
IPK_ONLY_ARCHITECTURES = {"mips_4kec", "riscv64_riscv64"}
EXPECTED_ARCHITECTURES = (
    COMMON_ARCHITECTURES | APK_ONLY_ARCHITECTURES | IPK_ONLY_ARCHITECTURES
)
SMOKE_BUILD_IDS = {
    "apk-aarch64_cortex-a53",
    "apk-armeb_xscale",
    "apk-loongarch64_generic",
    "apk-mipsel_24kc",
    "ipk-mips_4kec",
    "ipk-powerpc_8548",
    "ipk-riscv64_riscv64",
    "ipk-x86_64",
}
# QEMU user mode cannot faithfully execute Octeon-specific userspace binaries,
# the selected embedded PowerPC variants, or armeb userspace affected by QEMU's
# big-endian ARM VDSO crash (qemu-project/qemu#2333). These entries still
# receive strict package, ELF, linkage, and FFmpeg component validation; only
# the decode/encode execution smoke test is skipped.
STATIC_VALIDATION_ARCHITECTURES = {
    "armeb_xscale",
    "mips64_octeonplus",
    "powerpc64_e5500",
    "powerpc_464fp",
    "powerpc_8548",
}

SAFE_COMPONENT = re.compile(r"^[a-z0-9][a-z0-9_.+-]*$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
GIT_COMMIT = re.compile(r"^[0-9a-f]{40}$")
REVISION = re.compile(r"^r[0-9]+-[0-9a-f]+$")


class MatrixError(RuntimeError):
    """Raised when the pinned build matrix is malformed or incomplete."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise MatrixError(message)


def require_keys(value: dict[str, Any], expected: set[str], label: str) -> None:
    actual = set(value)
    require(
        actual == expected,
        f"{label} fields differ: expected {sorted(expected)!r}, got {sorted(actual)!r}",
    )


def expected_qemu(architecture: str) -> str:
    mappings = (
        ("aarch64_", "qemu-aarch64-static"),
        ("armeb_", "qemu-armeb-static"),
        ("arm_", "qemu-arm-static"),
        ("i386_", "qemu-i386-static"),
        ("loongarch64_", "qemu-loongarch64-static"),
        ("mips64el_", "qemu-mips64el-static"),
        ("mips64_", "qemu-mips64-static"),
        ("mipsel_", "qemu-mipsel-static"),
        ("mips_", "qemu-mips-static"),
        ("powerpc64_", "qemu-ppc64-static"),
        ("powerpc_", "qemu-ppc-static"),
        ("riscv64_", "qemu-riscv64-static"),
        ("x86_64", "qemu-x86_64-static"),
    )
    for prefix, executable in mappings:
        if architecture.startswith(prefix):
            return executable
    raise MatrixError(f"No QEMU mapping exists for architecture {architecture!r}")


def load_matrix(path: Path = DEFAULT_MATRIX) -> dict[str, Any]:
    try:
        raw = path.read_text(encoding="utf-8")
        data = json.loads(raw)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise MatrixError(f"Cannot read matrix {path}: {exc}") from exc
    require(isinstance(data, dict), "Matrix root must be an object")
    validate_matrix(data)
    if path.resolve() == DEFAULT_MATRIX.resolve():
        validate_application_version_references()
    return data


def validate_application_version_references() -> None:
    expected_lines = {
        ROOT / "luci-app-videoplayer" / "Makefile": f"PKG_VERSION:={APP_VERSION}",
        ROOT / "scripts" / "build-packages.py": f'PKG_VERSION = "{APP_VERSION}"',
        ROOT / "scripts" / "verify_packages.py": f'PKG_VERSION = "{APP_VERSION}"',
        ROOT / "scripts" / "install-main-apk.sh": f'APP_VERSION="{APP_VERSION}"',
    }
    for path, expected_line in expected_lines.items():
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except (OSError, UnicodeDecodeError) as exc:
            raise MatrixError(
                f"Cannot read application version reference {path}: {exc}"
            ) from exc
        require(
            lines.count(expected_line) == 1,
            f"Application version reference differs in {path.relative_to(ROOT)}",
        )


def validate_matrix(data: dict[str, Any]) -> None:
    require_keys(
        data,
        {
            "application",
            "codec",
            "folder_key",
            "releases",
            "schema_version",
            "scope",
        },
        "matrix",
    )
    require(data["schema_version"] == 1, "Unsupported matrix schema version")
    require(data["folder_key"] == "DISTRIB_ARCH", "Folder key must be DISTRIB_ARCH")
    require(
        data["scope"] == "current official OpenWrt stable and old-stable releases",
        "Matrix scope is unexpected",
    )

    application = data["application"]
    require(isinstance(application, dict), "application must be an object")
    require_keys(
        application,
        {"name", "version", "apk_filename", "ipk_filename"},
        "application",
    )
    require(application["name"] == "luci-app-videoplayer", "Wrong app name")
    require(application["version"] == APP_VERSION, "App version must remain 1.1.0")
    require(
        application["apk_filename"] == f"luci-app-videoplayer-{APP_VERSION}.apk",
        "Wrong app APK filename",
    )
    require(
        application["ipk_filename"] == f"luci-app-videoplayer_{APP_VERSION}_all.ipk",
        "Wrong app IPK filename",
    )

    codec = data["codec"]
    require(isinstance(codec, dict), "codec must be an object")
    require_keys(codec, {"name", "version", "release", "source_sha256"}, "codec")
    require(codec["name"] == "luci-videoplayer-codec-runtime", "Wrong codec name")
    require(codec["version"] == CODEC_VERSION, "Wrong codec source version")
    require(codec["release"] == CODEC_RELEASE, "Wrong codec package release")
    require(
        codec["source_sha256"] == CODEC_SOURCE_SHA256,
        "Wrong FFmpeg source checksum",
    )

    releases = data["releases"]
    require(isinstance(releases, dict), "releases must be an object")
    require(set(releases) == set(EXPECTED_RELEASES), "Expected APK and IPK releases")

    expected_by_format = {
        "apk": COMMON_ARCHITECTURES | APK_ONLY_ARCHITECTURES,
        "ipk": COMMON_ARCHITECTURES | IPK_ONLY_ARCHITECTURES,
    }
    seen_pairs: set[tuple[str, str]] = set()
    for package_format, expected_release in EXPECTED_RELEASES.items():
        release = releases[package_format]
        require(
            isinstance(release, dict), f"{package_format} release must be an object"
        )
        require_keys(
            release,
            {
                "openwrt_release",
                "openwrt_revision",
                "status",
                "manager",
                "directory",
                "packages_feed_commit",
                "feeds_buildinfo_sha256",
                "architectures",
            },
            f"{package_format} release",
        )
        for key, expected in expected_release.items():
            require(
                release[key] == expected,
                f"{package_format} release field {key!r} is not pinned correctly",
            )
        require(
            REVISION.fullmatch(release["openwrt_revision"]) is not None,
            f"{package_format} revision is malformed",
        )
        expected_directory = (
            f"openwrt-{release['openwrt_release']}-{release['openwrt_revision']}"
        )
        require(
            release["directory"] == expected_directory,
            f"{package_format} directory is not release-qualified",
        )
        require(
            GIT_COMMIT.fullmatch(release["packages_feed_commit"]) is not None,
            f"{package_format} packages feed commit is malformed",
        )
        require(
            SHA256.fullmatch(release["feeds_buildinfo_sha256"]) is not None,
            f"{package_format} feeds.buildinfo checksum is malformed",
        )

        architectures = release["architectures"]
        require(
            isinstance(architectures, dict),
            f"{package_format} architectures must be an object",
        )
        require(
            set(architectures) == expected_by_format[package_format],
            f"{package_format} architecture coverage is incomplete or unexpected",
        )
        for architecture, entry in architectures.items():
            require(
                SAFE_COMPONENT.fullmatch(architecture) is not None,
                f"Unsafe architecture key {architecture!r}",
            )
            pair = (package_format, architecture)
            require(pair not in seen_pairs, f"Duplicate matrix pair {pair!r}")
            seen_pairs.add(pair)
            require(isinstance(entry, dict), f"Entry {pair!r} must be an object")
            require_keys(
                entry,
                {
                    "target",
                    "subtarget",
                    "device_class",
                    "sdk_file",
                    "sdk_sha256",
                    "qemu",
                },
                f"entry {pair!r}",
            )
            for field in ("target", "subtarget"):
                require(
                    isinstance(entry[field], str)
                    and SAFE_COMPONENT.fullmatch(entry[field]) is not None,
                    f"Unsafe {field} in {pair!r}",
                )
            require(
                entry["device_class"] in {"router", "emulator"},
                f"Invalid device class in {pair!r}",
            )
            require(
                (entry["target"] == "malta") == (entry["device_class"] == "emulator"),
                f"Malta classification mismatch in {pair!r}",
            )
            sdk_prefix = (
                f"openwrt-sdk-{release['openwrt_release']}-"
                f"{entry['target']}-{entry['subtarget']}_"
            )
            require(
                entry["sdk_file"].startswith(sdk_prefix)
                and entry["sdk_file"].endswith(".Linux-x86_64.tar.zst")
                and "/" not in entry["sdk_file"]
                and "\\" not in entry["sdk_file"],
                f"Unsafe or mismatched SDK filename in {pair!r}",
            )
            require(
                SHA256.fullmatch(entry["sdk_sha256"]) is not None,
                f"Malformed SDK checksum in {pair!r}",
            )
            require(
                entry["qemu"] == expected_qemu(architecture),
                f"Wrong QEMU executable in {pair!r}",
            )

    require(
        len(seen_pairs) == 71,
        f"Expected 71 package builds, found {len(seen_pairs)}",
    )
    union = set().union(
        *(set(release["architectures"]) for release in releases.values())
    )
    require(union == EXPECTED_ARCHITECTURES, "Architecture-folder union is incorrect")


def codec_filename(data: dict[str, Any], package_format: str, arch: str) -> str:
    codec = data["codec"]
    base = f"{codec['name']}"
    version = f"{codec['version']}-r{codec['release']}"
    if package_format == "apk":
        return f"{base}-{version}.apk"
    return f"{base}_{version}_{arch}.ipk"


def build_entries(data: dict[str, Any]) -> list[dict[str, str]]:
    entries: list[dict[str, str]] = []
    for package_format in ("apk", "ipk"):
        release = data["releases"][package_format]
        for architecture, target in sorted(release["architectures"].items()):
            base_url = (
                "https://downloads.openwrt.org/releases/"
                f"{release['openwrt_release']}/targets/"
                f"{target['target']}/{target['subtarget']}"
            )
            entries.append(
                {
                    "id": f"{package_format}-{architecture}",
                    "format": package_format,
                    "manager": release["manager"],
                    "arch": architecture,
                    "release": release["openwrt_release"],
                    "revision": release["openwrt_revision"],
                    "release_dir": release["directory"],
                    "target": target["target"],
                    "subtarget": target["subtarget"],
                    "device_class": target["device_class"],
                    "sdk_file": target["sdk_file"],
                    "sdk_url": f"{base_url}/{target['sdk_file']}",
                    "sdk_sha256": target["sdk_sha256"],
                    "feeds_buildinfo_url": f"{base_url}/feeds.buildinfo",
                    "feeds_buildinfo_sha256": release["feeds_buildinfo_sha256"],
                    "packages_feed_commit": release["packages_feed_commit"],
                    "qemu": target["qemu"],
                    "validation_mode": (
                        "static"
                        if architecture in STATIC_VALIDATION_ARCHITECTURES
                        else "qemu"
                    ),
                    "ffmpeg_version": data["codec"]["version"],
                    "ffmpeg_sha256": data["codec"]["source_sha256"],
                    "codec_release": str(data["codec"]["release"]),
                    "codec_file": codec_filename(data, package_format, architecture),
                    "artifact_dir": f"dist/{architecture}/{release['directory']}",
                    "artifact_name": f"codec-{package_format}-{architecture}",
                }
            )
    return entries


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--matrix", type=Path, default=DEFAULT_MATRIX)
    parser.add_argument(
        "--scope",
        choices=("full", "smoke"),
        default="full",
        help="matrix scope for --github-matrix (default: full)",
    )
    output = parser.add_mutually_exclusive_group()
    output.add_argument(
        "--github-matrix",
        action="store_true",
        help="print a compact GitHub Actions include matrix",
    )
    output.add_argument(
        "--list-architectures",
        action="store_true",
        help="print the 37 architecture folder names",
    )
    output.add_argument(
        "--summary",
        action="store_true",
        help="print human-readable coverage totals",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    data = load_matrix(args.matrix.resolve())
    if args.github_matrix:
        entries = build_entries(data)
        if args.scope == "smoke":
            entries = [entry for entry in entries if entry["id"] in SMOKE_BUILD_IDS]
            require(
                {entry["id"] for entry in entries} == SMOKE_BUILD_IDS,
                "Smoke-build selection is incomplete",
            )
        json.dump({"include": entries}, sys.stdout, separators=(",", ":"))
        sys.stdout.write("\n")
    elif args.list_architectures:
        for architecture in sorted(EXPECTED_ARCHITECTURES):
            print(architecture)
    elif args.summary:
        print("OpenWrt codec build matrix is valid")
        print(f"  architecture folders: {len(EXPECTED_ARCHITECTURES)}")
        print(f"  APK builds: {len(data['releases']['apk']['architectures'])}")
        print(f"  IPK builds: {len(data['releases']['ipk']['architectures'])}")
        print(f"  total codec builds: {len(build_entries(data))}")
        print(f"  application version: {data['application']['version']}")
    else:
        print("OpenWrt codec build matrix is valid")


if __name__ == "__main__":
    try:
        main()
    except MatrixError as exc:
        raise SystemExit(f"ERROR: {exc}") from exc
