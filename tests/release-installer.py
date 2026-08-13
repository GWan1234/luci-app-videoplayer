#!/usr/bin/env python3
"""Validate the frozen Release 1.1.0 installer manifest against the codec matrix."""

from __future__ import annotations

import hashlib
import json
import re
import sys
from collections import Counter
from pathlib import Path


def fail(message: str) -> None:
    raise SystemExit(f"Release installer regression: {message}")


def require(condition: bool, message: str) -> None:
    if not condition:
        fail(message)


def main() -> None:
    if len(sys.argv) != 2:
        fail("usage: release-installer.py REPOSITORY_ROOT")

    root = Path(sys.argv[1]).resolve()
    installer_path = root / "scripts" / "install-from-github.sh"
    readme_path = root / "README.md"
    matrix_path = root / "codec-runtime" / "matrix.json"
    installer = installer_path.read_text(encoding="utf-8")
    readme = readme_path.read_text(encoding="utf-8")
    matrix = json.loads(matrix_path.read_text(encoding="utf-8"))

    def assignment(name: str) -> str:
        matches = re.findall(
            rf'^{re.escape(name)}="([^"\n]*)"$', installer, re.MULTILINE
        )
        require(len(matches) == 1, f"expected one literal {name} assignment")
        return matches[0]

    release_version = assignment("RELEASE_VERSION")
    source_commit = assignment("RELEASE_SOURCE_COMMIT")
    app_apk = assignment("APK_FILE")
    app_ipk = assignment("IPK_FILE")
    codec_version = assignment("CODEC_VERSION")
    codec_name = assignment("CODEC_PACKAGE_NAME")
    manifest_name = assignment("CODEC_MANIFEST_FILE")
    manifest_sha256 = assignment("CODEC_MANIFEST_SHA256")

    require(matrix.get("schema_version") == 1, "unexpected codec matrix schema")
    require(matrix.get("folder_key") == "DISTRIB_ARCH", "wrong matrix folder key")
    application = matrix["application"]
    codec = matrix["codec"]
    require(release_version == application["version"] == "1.1.0", "version drift")
    require(
        app_apk == "luci-app-videoplayer-$RELEASE_VERSION.apk"
        and app_apk.replace("$RELEASE_VERSION", release_version)
        == application["apk_filename"],
        "APK filename drift",
    )
    require(
        app_ipk == "luci-app-videoplayer_${RELEASE_VERSION}_all.ipk"
        and app_ipk.replace("${RELEASE_VERSION}", release_version)
        == application["ipk_filename"],
        "IPK filename drift",
    )
    require(codec_name == codec["name"], "codec package name drift")
    require(
        codec_version == f"{codec['version']}-r{codec['release']}",
        "codec version drift",
    )
    require(re.fullmatch(r"[0-9a-f]{40}", source_commit) is not None, "bad source SHA")
    require(
        re.fullmatch(r"[0-9a-f]{64}", manifest_sha256) is not None,
        "bad manifest SHA-256 pin",
    )

    installer_sha256 = hashlib.sha256(installer_path.read_bytes()).hexdigest()
    bootstrap_pins = re.findall(
        r"expected='([0-9a-f]{64})';[^\n]*"
        r"releases/download/1\.1\.0/install-from-github\.sh",
        readme,
    )
    require(
        bootstrap_pins == [installer_sha256],
        "README release bootstrap does not pin the exact installer bytes",
    )

    require(Path(manifest_name).name == manifest_name, "unsafe manifest filename")
    manifest_path = root / "scripts" / manifest_name
    require(manifest_path.is_file(), f"missing {manifest_name}")
    manifest_bytes = manifest_path.read_bytes()
    require(
        hashlib.sha256(manifest_bytes).hexdigest() == manifest_sha256,
        "manifest bytes do not match CODEC_MANIFEST_SHA256",
    )

    manifest_lines = manifest_bytes.decode("utf-8").splitlines()
    require(
        manifest_lines[:3]
        == [
            "# luci-app-videoplayer release codec manifest v1",
            f"# source_commit={source_commit}",
            "# format|release|revision|architecture|asset|sha256|local_package_name",
        ],
        "manifest header or source provenance is not exact",
    )

    rows: list[tuple[str, ...]] = []
    for line_number, line in enumerate(manifest_lines[3:], 4):
        require(line != "", f"blank line at {line_number}")
        require(not line.startswith("#"), f"unexpected comment at {line_number}")
        fields = tuple(line.split("|"))
        require(len(fields) == 7, f"line {line_number} does not have seven fields")
        rows.append(fields)

    require(len(rows) == 71, f"expected 71 mappings, found {len(rows)}")
    keys = [(row[0], row[1], row[2], row[3]) for row in rows]
    duplicate_keys = [key for key, count in Counter(keys).items() if count != 1]
    require(not duplicate_keys, f"duplicate mapping keys: {duplicate_keys[:3]}")

    expected: dict[tuple[str, str, str, str], tuple[str, str]] = {}
    for package_format, release in matrix["releases"].items():
        require(package_format in {"apk", "ipk"}, "unsupported matrix format")
        expected_manager = "apk" if package_format == "apk" else "opkg"
        require(release["manager"] == expected_manager, "matrix manager mismatch")
        for architecture in release["architectures"]:
            key = (
                package_format,
                release["openwrt_release"],
                release["openwrt_revision"],
                architecture,
            )
            if package_format == "apk":
                asset = f"{codec_name}-{codec_version}_{architecture}.apk"
                local_name = f"{codec_name}-{codec_version}.apk"
            else:
                asset = f"{codec_name}_{codec_version}_{architecture}.ipk"
                local_name = asset
            expected[key] = (asset, local_name)

    require(len(expected) == 71, f"codec matrix has {len(expected)} mappings, not 71")
    actual_keys = set(keys)
    expected_keys = set(expected)
    missing = sorted(expected_keys - actual_keys)
    extra = sorted(actual_keys - expected_keys)
    require(
        not missing and not extra,
        f"mapping mismatch; missing={missing[:3]} extra={extra[:3]}",
    )

    assets: list[str] = []
    for (
        package_format,
        release,
        revision,
        architecture,
        asset,
        checksum,
        local_name,
    ) in rows:
        key = (package_format, release, revision, architecture)
        expected_asset, expected_local_name = expected[key]
        require(asset == expected_asset, f"wrong asset for {key}: {asset}")
        require(local_name == expected_local_name, f"wrong local filename for {key}")
        require(
            re.fullmatch(r"[0-9a-f]{64}", checksum) is not None,
            f"invalid checksum for {key}",
        )
        assets.append(asset)
    require(len(set(assets)) == 71, "release asset names are not globally unique")

    print("Release 1.1.0 manifest and codec-matrix checks passed.")


if __name__ == "__main__":
    main()
