#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Verify the complete architecture-scoped dist/ package layout."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
from pathlib import Path
from typing import Any

import codec_matrix
import verify_codec_package
import verify_packages

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DIST = ROOT / "dist"
COMMIT = re.compile(r"^[0-9a-f]{40}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
BUILD_INFO_KEY = re.compile(r"^[a-z][a-z0-9_]*$")
MAX_METADATA_BYTES = 4 * 1024 * 1024
MAX_SMALL_METADATA_BYTES = 64 * 1024


class DistVerificationError(RuntimeError):
    """Raised when dist/ is incomplete, inconsistent, or unsafe."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise DistVerificationError(message)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def read_limited_bytes(path: Path, limit: int, label: str) -> bytes:
    try:
        return verify_packages.read_limited_file(path, limit, label)
    except verify_packages.PackageVerificationError as exc:
        raise DistVerificationError(str(exc)) from exc


def read_limited_text(path: Path, limit: int, label: str) -> str:
    try:
        return read_limited_bytes(path, limit, label).decode("utf-8")
    except UnicodeDecodeError as exc:
        raise DistVerificationError(f"{label} is not UTF-8: {path}") from exc


def path_is_link_or_junction(path: Path) -> bool:
    if path.is_symlink():
        return True
    is_junction = getattr(path, "is_junction", None)
    return bool(is_junction is not None and is_junction())


def load_json(path: Path) -> dict[str, Any]:
    require(path.is_file() and not path.is_symlink(), f"Missing JSON file: {path}")
    try:
        value = json.loads(
            read_limited_text(path, MAX_METADATA_BYTES, f"JSON file {path}")
        )
    except (OSError, json.JSONDecodeError) as exc:
        raise DistVerificationError(f"Cannot parse {path}: {exc}") from exc
    require(isinstance(value, dict), f"JSON root must be an object: {path}")
    return value


def parse_build_info(path: Path) -> dict[str, str]:
    require(path.is_file() and not path.is_symlink(), f"Missing BUILD_INFO: {path}")
    lines = read_limited_text(
        path, verify_codec_package.MAX_BUILD_INFO_BYTES, f"BUILD_INFO {path}"
    ).splitlines()
    values: dict[str, str] = {}
    for line in lines:
        require(line and "=" in line, f"Malformed BUILD_INFO line in {path}")
        key, value = line.split("=", 1)
        require(
            BUILD_INFO_KEY.fullmatch(key) is not None,
            f"Malformed BUILD_INFO key in {path}: {key!r}",
        )
        require(key not in values, f"Duplicate BUILD_INFO key in {path}: {key}")
        require(
            value != "" and "\x00" not in value,
            f"Empty or unsafe BUILD_INFO value in {path}: {key}",
        )
        values[key] = value
    return values


def verify_checksums(directory: Path, expected: dict[str, str]) -> None:
    checksum_path = directory / "SHA256SUMS"
    require(
        checksum_path.is_file() and not checksum_path.is_symlink(),
        f"Missing SHA256SUMS in {directory}",
    )
    try:
        lines = read_limited_text(
            checksum_path,
            MAX_SMALL_METADATA_BYTES,
            f"SHA256SUMS {checksum_path}",
        ).splitlines()
    except OSError as exc:
        raise DistVerificationError(f"Cannot read {checksum_path}: {exc}") from exc
    actual: dict[str, str] = {}
    for line in lines:
        require("  " in line, f"Malformed checksum line in {checksum_path}")
        digest, name = line.split("  ", 1)
        require(SHA256.fullmatch(digest) is not None, "Malformed SHA-256 digest")
        require(
            codec_matrix.SAFE_COMPONENT.fullmatch(name) is not None,
            f"Unsafe checksum filename: {name!r}",
        )
        require(name not in actual, f"Duplicate checksum filename: {name}")
        actual[name] = digest
    require(
        actual == expected, f"SHA256SUMS differs from expected files in {directory}"
    )
    for name, digest in actual.items():
        path = directory / name
        require(path.is_file() and not path.is_symlink(), f"Missing package: {path}")
        require(sha256_file(path) == digest, f"Checksum mismatch: {path}")


def verify_build_info(
    path: Path,
    *,
    entry: dict[str, str],
    matrix: dict[str, Any],
) -> None:
    info = parse_build_info(path)
    expected = {
        "format": "3",
        "openwrt_release": entry["release"],
        "openwrt_revision": entry["revision"],
        "compatible_arch": entry["arch"],
        "build_target": entry["target"],
        "build_subtarget": entry["subtarget"],
        "sdk_sha256": entry["sdk_sha256"],
        "packages_feed_commit": entry["packages_feed_commit"],
        "ffmpeg_version": matrix["codec"]["version"],
        "package_format": entry["format"],
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
        "private_binary": "/usr/libexec/videoplayer-ffmpeg/ffmpeg",
    }
    require(set(info) == set(expected), f"BUILD_INFO fields differ in {path}")
    for key, value in expected.items():
        require(info[key] == value, f"BUILD_INFO {key} differs in {path}")


def verify_package_set(
    directory: Path,
    *,
    entry: dict[str, str],
    matrix: dict[str, Any],
    source_commit: str,
    require_codecs: bool,
    canonical_apps: dict[str, tuple[str, bytes]],
) -> dict[str, Any]:
    package_format = entry["format"]
    application_name = matrix["application"][f"{package_format}_filename"]
    application_path = directory / application_name
    require(
        application_path.is_file() and not application_path.is_symlink(),
        f"Missing application package: {application_path}",
    )
    application_data = read_limited_bytes(
        application_path,
        verify_packages.MAX_PACKAGE_FILE_BYTES,
        f"application package {application_path}",
    )
    application_hash = hashlib.sha256(application_data).hexdigest()
    if package_format not in canonical_apps:
        canonical_apps[package_format] = (application_hash, application_data)
    else:
        expected_hash, expected_data = canonical_apps[package_format]
        require(
            application_hash == expected_hash and application_data == expected_data,
            f"Application {package_format.upper()} copies are not byte-identical",
        )

    codec_name = entry["codec_file"]
    codec_path = directory / codec_name
    missing_marker = directory / "CODEC_NOT_BUILT.txt"
    codec_present = codec_path.is_file() and not codec_path.is_symlink()
    if codec_present:
        require(
            not missing_marker.exists(), f"Stale missing-codec marker in {directory}"
        )
        build_info_path = directory / "BUILD_INFO"
        verify_build_info(build_info_path, entry=entry, matrix=matrix)
        try:
            verify_codec_package.verify_codec_package(
                codec_path,
                package_format=package_format,
                architecture=entry["arch"],
                build_info_path=build_info_path,
            )
        except verify_codec_package.CodecPackageVerificationError as exc:
            raise DistVerificationError(
                f"Codec package verification failed for {codec_path}: {exc}"
            ) from exc
        codec_hash: str | None = sha256_file(codec_path)
    else:
        require(
            missing_marker.is_file() and not missing_marker.is_symlink(),
            f"Codec package and missing marker are both absent in {directory}",
        )
        require(
            not (directory / "BUILD_INFO").exists(),
            f"BUILD_INFO exists without a codec package in {directory}",
        )
        codec_hash = None
        require(not require_codecs, f"Required codec package is missing: {codec_path}")

    expected_files = {
        application_name,
        "SHA256SUMS",
        "PACKAGE_SET.json",
        codec_name if codec_present else "CODEC_NOT_BUILT.txt",
    }
    if codec_present:
        expected_files.add("BUILD_INFO")
    children = list(directory.iterdir())
    require(
        all(path.is_file() and not path_is_link_or_junction(path) for path in children),
        f"Package-set directory contains a non-regular entry: {directory}",
    )
    actual_files = {path.name for path in children}
    require(
        actual_files == expected_files,
        f"Unexpected package-set files in {directory}: "
        f"{sorted(actual_files ^ expected_files)!r}",
    )
    checksum_expectation = {application_name: application_hash}
    if codec_hash is not None:
        checksum_expectation[codec_name] = codec_hash
    verify_checksums(directory, checksum_expectation)

    metadata = load_json(directory / "PACKAGE_SET.json")
    release = matrix["releases"][package_format]
    expected_metadata = {
        "schema_version": 1,
        "source_commit": source_commit,
        "folder_key": "DISTRIB_ARCH",
        "architecture": entry["arch"],
        "package_format": package_format,
        "manager": entry["manager"],
        "openwrt_release": entry["release"],
        "openwrt_revision": entry["revision"],
        "application": {
            "file": application_name,
            "sha256": application_hash,
        },
        "codec": (
            {"file": codec_name, "sha256": codec_hash}
            if codec_hash is not None
            else None
        ),
    }
    require(metadata == expected_metadata, f"PACKAGE_SET.json differs in {directory}")
    require(release["directory"] == entry["release_dir"], "Release directory drift")
    return expected_metadata


def verify_dist(dist: Path, require_codecs: bool) -> None:
    matrix = codec_matrix.load_matrix()
    require(dist.is_dir() and not dist.is_symlink(), f"Missing dist directory: {dist}")
    root_entries = {path.name: path for path in dist.iterdir()}
    expected_root = set(codec_matrix.EXPECTED_ARCHITECTURES) | {
        "INDEX.json",
        "INDEX.tsv",
        "SOURCE_COMMIT",
    }
    require(
        set(root_entries) == expected_root,
        f"dist root entries differ: {sorted(set(root_entries) ^ expected_root)!r}",
    )
    for architecture in codec_matrix.EXPECTED_ARCHITECTURES:
        path = root_entries[architecture]
        require(
            path.is_dir() and not path_is_link_or_junction(path),
            f"Unsafe folder: {path}",
        )
    for name in ("INDEX.json", "INDEX.tsv", "SOURCE_COMMIT"):
        path = root_entries[name]
        require(
            path.is_file() and not path_is_link_or_junction(path),
            f"Unsafe index file: {path}",
        )

    source_commit = read_limited_text(
        dist / "SOURCE_COMMIT", 1024, "SOURCE_COMMIT"
    ).strip()
    require(COMMIT.fullmatch(source_commit) is not None, "Invalid SOURCE_COMMIT")

    entries = codec_matrix.build_entries(matrix)
    expected_release_dirs: dict[str, set[str]] = {
        arch: set() for arch in codec_matrix.EXPECTED_ARCHITECTURES
    }
    canonical_apps: dict[str, tuple[str, bytes]] = {}
    package_sets: list[dict[str, Any]] = []
    codec_count = 0
    for entry in entries:
        expected_release_dirs[entry["arch"]].add(entry["release_dir"])
        directory = dist / entry["arch"] / entry["release_dir"]
        require(
            directory.is_dir() and not path_is_link_or_junction(directory),
            f"Missing release directory: {directory}",
        )
        metadata = verify_package_set(
            directory,
            entry=entry,
            matrix=matrix,
            source_commit=source_commit,
            require_codecs=require_codecs,
            canonical_apps=canonical_apps,
        )
        package_sets.append(metadata)
        if metadata["codec"] is not None:
            codec_count += 1

    for architecture, expected in expected_release_dirs.items():
        directory = dist / architecture
        children = list(directory.iterdir())
        require(
            all(
                path.is_dir() and not path_is_link_or_junction(path)
                for path in children
            ),
            f"Architecture root contains a non-directory entry: {architecture}",
        )
        actual = {path.name for path in children}
        require(actual == expected, f"Release folders differ for {architecture}")

    require(set(canonical_apps) == {"apk", "ipk"}, "Missing application package format")
    first_ipk = next(
        dist
        / entry["arch"]
        / entry["release_dir"]
        / matrix["application"]["ipk_filename"]
        for entry in entries
        if entry["format"] == "ipk"
    )
    first_apk = next(
        dist
        / entry["arch"]
        / entry["release_dir"]
        / matrix["application"]["apk_filename"]
        for entry in entries
        if entry["format"] == "apk"
    )
    try:
        verify_packages.verify_packages(first_ipk, first_apk)
    except verify_packages.PackageVerificationError as exc:
        raise DistVerificationError(
            f"Application package verification failed: {exc}"
        ) from exc

    index = load_json(dist / "INDEX.json")
    expected_arch_index: dict[str, dict[str, object]] = {
        arch: {} for arch in sorted(codec_matrix.EXPECTED_ARCHITECTURES)
    }
    for metadata in package_sets:
        architecture = str(metadata["architecture"])
        package_format = str(metadata["package_format"])
        release = matrix["releases"][package_format]
        expected_arch_index[architecture][package_format] = {
            "directory": f"{architecture}/{release['directory']}",
            "openwrt_release": release["openwrt_release"],
            "openwrt_revision": release["openwrt_revision"],
            "manager": release["manager"],
            "application": metadata["application"],
            "codec": metadata["codec"],
        }
    expected_index = {
        "schema_version": 1,
        "source_commit": source_commit,
        "folder_key": "DISTRIB_ARCH",
        "application_version": matrix["application"]["version"],
        "codec_version": f"{matrix['codec']['version']}-r{matrix['codec']['release']}",
        "architecture_count": len(expected_arch_index),
        "package_set_count": len(package_sets),
        "codec_package_count": codec_count,
        "architectures": expected_arch_index,
    }
    require(index == expected_index, "INDEX.json does not match the package tree")

    expected_tsv = [
        (
            "# format|release|revision|architecture|application_path|"
            "application_sha256|codec_path|codec_sha256"
        )
    ]
    for metadata in package_sets:
        architecture = str(metadata["architecture"])
        package_format = str(metadata["package_format"])
        release = matrix["releases"][package_format]
        directory = f"{architecture}/{release['directory']}"
        application = metadata["application"]
        codec = metadata["codec"]
        codec_path = ""
        codec_hash = ""
        if isinstance(codec, dict):
            codec_path = f"{directory}/{codec['file']}"
            codec_hash = str(codec["sha256"])
        expected_tsv.append(
            "|".join(
                (
                    package_format,
                    str(release["openwrt_release"]),
                    str(release["openwrt_revision"]),
                    architecture,
                    f"{directory}/{application['file']}",
                    str(application["sha256"]),
                    codec_path,
                    codec_hash,
                )
            )
        )
    actual_tsv = read_limited_text(
        dist / "INDEX.tsv", MAX_METADATA_BYTES, "INDEX.tsv"
    ).splitlines()
    require(actual_tsv == expected_tsv, "INDEX.tsv does not match the package tree")

    require(
        not require_codecs or codec_count == 71,
        f"Expected 71 codec packages, found {codec_count}",
    )
    print("Architecture-scoped distribution verified")
    print(f"  architecture folders: {len(expected_arch_index)}")
    print(f"  package sets: {len(package_sets)}")
    print(f"  codec packages: {codec_count}")
    print(f"  application version: {matrix['application']['version']}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dist",
        type=Path,
        default=DEFAULT_DIST,
        help="distribution directory (default: repository dist/)",
    )
    parser.add_argument(
        "--require-codecs",
        action="store_true",
        help="require all 71 architecture-specific codec packages",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    absolute = Path(os.path.abspath(args.dist))
    require(
        not path_is_link_or_junction(absolute),
        "dist root must not be a symbolic link or junction",
    )
    verify_dist(absolute.resolve(), args.require_codecs)


if __name__ == "__main__":
    try:
        main()
    except (
        OSError,
        UnicodeDecodeError,
        codec_matrix.MatrixError,
        DistVerificationError,
    ) as exc:
        raise SystemExit(f"ERROR: {exc}") from exc
