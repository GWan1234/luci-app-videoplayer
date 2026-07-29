#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Assemble the architecture-scoped OpenWrt package tree under dist/."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

import codec_matrix

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = ROOT / "dist"
COMMIT = re.compile(r"^[0-9a-f]{40}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
MAX_CHECKSUM_BYTES = 4096
MAX_SOURCE_COMMIT_BYTES = 1024

_BUILDER_SPEC = importlib.util.spec_from_file_location(
    "videoplayer_build_packages", ROOT / "scripts" / "build-packages.py"
)
if _BUILDER_SPEC is None or _BUILDER_SPEC.loader is None:
    raise RuntimeError("Cannot load scripts/build-packages.py")
build_packages = importlib.util.module_from_spec(_BUILDER_SPEC)
_BUILDER_SPEC.loader.exec_module(build_packages)

_VERIFIER_SPEC = importlib.util.spec_from_file_location(
    "videoplayer_verify_dist", ROOT / "scripts" / "verify-dist.py"
)
if _VERIFIER_SPEC is None or _VERIFIER_SPEC.loader is None:
    raise RuntimeError("Cannot load scripts/verify-dist.py")
verify_dist_module = importlib.util.module_from_spec(_VERIFIER_SPEC)
_VERIFIER_SPEC.loader.exec_module(verify_dist_module)


class DistBuildError(RuntimeError):
    """Raised when the distribution tree cannot be assembled safely."""


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def write_text(path: Path, value: str) -> None:
    path.write_text(value, encoding="utf-8", newline="\n")


def copy_regular_file(source: Path, destination: Path) -> None:
    if source.is_symlink() or not source.is_file():
        raise DistBuildError(f"Expected a regular file: {source}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)


def read_canonical_text(path: Path, maximum_bytes: int, label: str) -> str:
    if path.is_symlink() or not path.is_file():
        raise DistBuildError(f"{label} must be a regular file: {path}")
    size = path.stat().st_size
    if not 0 < size <= maximum_bytes:
        raise DistBuildError(f"{label} size is outside its safety limit: {path}")
    try:
        data = path.read_bytes()
        text = data.decode("utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        raise DistBuildError(f"Cannot read {label} {path}: {exc}") from exc
    if not text.endswith("\n") or "\r" in text or "\x00" in text:
        raise DistBuildError(f"{label} is not canonical text: {path}")
    return text


def read_checksum_manifest(path: Path) -> dict[str, str]:
    text = read_canonical_text(path, MAX_CHECKSUM_BYTES, "codec checksum manifest")
    values: dict[str, str] = {}
    for line in text.splitlines():
        if "  " not in line:
            raise DistBuildError(f"Malformed codec checksum line in {path}")
        digest, name = line.split("  ", 1)
        if SHA256.fullmatch(digest) is None:
            raise DistBuildError(f"Malformed codec checksum in {path}")
        if codec_matrix.SAFE_COMPONENT.fullmatch(name) is None:
            raise DistBuildError(f"Unsafe codec checksum filename in {path}: {name!r}")
        if name in values:
            raise DistBuildError(f"Duplicate codec checksum filename in {path}: {name}")
        values[name] = digest
    return values


def current_commit() -> str:
    try:
        status = subprocess.run(
            ["git", "status", "--porcelain=v1", "--untracked-files=all"],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
        ).stdout
        if status:
            raise DistBuildError(
                "Cannot record HEAD as package provenance while the worktree is "
                "dirty; commit the source first or pass --source-commit explicitly"
            )
        value = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError) as exc:
        raise DistBuildError(f"Cannot resolve the source commit: {exc}") from exc
    if COMMIT.fullmatch(value) is None:
        raise DistBuildError(f"Git returned an invalid source commit: {value!r}")
    return value


def path_is_link_or_junction(path: Path) -> bool:
    if path.is_symlink():
        return True
    is_junction = getattr(path, "is_junction", None)
    return bool(is_junction is not None and is_junction())


def validate_output_path(output: Path) -> Path:
    absolute = Path(os.path.abspath(output))
    try:
        relative = absolute.relative_to(ROOT)
    except ValueError:
        raise DistBuildError("The output directory must be a child of the repository")

    parts = relative.parts
    allowed = (
        parts == ("dist",)
        or parts == (".snapshot-publish", "dist")
        or parts == (".codec-publish", "dist")
        or (len(parts) >= 2 and parts[0] == ".staging")
    )
    if not allowed:
        raise DistBuildError(
            "The output must be dist, .snapshot-publish/dist, "
            ".codec-publish/dist, or a child of .staging"
        )

    current = ROOT
    for component in parts:
        current /= component
        if path_is_link_or_junction(current):
            raise DistBuildError(
                f"The output path contains a symbolic link or junction: {current}"
            )

    resolved = absolute.resolve()
    if resolved == ROOT or ROOT not in resolved.parents:
        raise DistBuildError("The resolved output escaped the repository")
    resolved.parent.mkdir(parents=True, exist_ok=True)
    return resolved


def load_codec_artifact(
    codec_source: Path | None,
    relative_dir: Path,
    codec_name: str,
    application_name: str,
) -> tuple[Path, Path] | None:
    if codec_source is None:
        return None
    current = codec_source
    for component in relative_dir.parts:
        current /= component
        if path_is_link_or_junction(current):
            raise DistBuildError(
                f"Codec source path contains a symbolic link or junction: {current}"
            )
    source_dir = codec_source / relative_dir
    package = source_dir / codec_name
    build_info = source_dir / "BUILD_INFO"
    artifact_checksum = source_dir / f"{codec_name}.sha256"
    published_checksum = source_dir / "SHA256SUMS"
    checksum_candidates = [
        path for path in (artifact_checksum, published_checksum) if path.exists()
    ]
    if not package.exists() and not build_info.exists() and not checksum_candidates:
        return None
    if not package.exists() or not build_info.exists() or len(checksum_candidates) != 1:
        raise DistBuildError(f"Incomplete codec artifact set in {source_dir}")
    checksum = checksum_candidates[0]
    if any(
        path.is_symlink() or not path.is_file()
        for path in (package, build_info, checksum)
    ):
        raise DistBuildError(
            f"Codec artifact set contains a non-regular file: {source_dir}"
        )
    size_limits = {
        package: verify_dist_module.verify_codec_package.MAX_CODEC_PACKAGE_BYTES,
        build_info: verify_dist_module.verify_codec_package.MAX_BUILD_INFO_BYTES,
        checksum: MAX_CHECKSUM_BYTES,
    }
    for path, limit in size_limits.items():
        size = path.stat().st_size
        if not 0 < size <= limit:
            raise DistBuildError(
                f"Codec artifact size is outside its safety limit: {path}"
            )

    checksums = read_checksum_manifest(checksum)
    if checksum == artifact_checksum:
        expected_names = {codec_name}
    else:
        expected_names = {application_name, codec_name}
        source_application = source_dir / application_name
        if source_application.is_symlink() or not source_application.is_file():
            raise DistBuildError(
                f"Published codec source has no regular application package: "
                f"{source_application}"
            )
        if checksums.get(application_name) != sha256_file(source_application):
            raise DistBuildError(
                f"Published application checksum does not match {source_application}"
            )
    if set(checksums) != expected_names:
        raise DistBuildError(f"Codec checksum file set is incorrect in {checksum}")
    if checksums[codec_name] != sha256_file(package):
        raise DistBuildError(f"Codec checksum does not match {package}")
    return package, build_info


def package_set_metadata(
    *,
    source_commit: str,
    package_format: str,
    architecture: str,
    release: dict[str, object],
    application_name: str,
    application_hash: str,
    codec_name: str,
    codec_hash: str | None,
) -> dict[str, object]:
    return {
        "schema_version": 1,
        "source_commit": source_commit,
        "folder_key": "DISTRIB_ARCH",
        "architecture": architecture,
        "package_format": package_format,
        "manager": release["manager"],
        "openwrt_release": release["openwrt_release"],
        "openwrt_revision": release["openwrt_revision"],
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


def install_staging_tree(staging: Path, output: Path) -> None:
    """Atomically replace when possible, with a rollback-safe Windows fallback."""
    if not output.exists():
        os.replace(staging, output)
        return
    if output.is_symlink() or not output.is_dir():
        raise DistBuildError("Existing output must be a regular directory")

    backup = output.with_name(f".{output.name}.previous-{os.getpid()}")
    if backup.exists():
        raise DistBuildError(f"Refusing to overwrite temporary backup {backup}")
    backup.mkdir(mode=0o700)
    old_entries: list[tuple[Path, Path]] = []
    new_entries: list[tuple[Path, Path]] = []
    try:
        for child in list(output.iterdir()):
            destination = backup / child.name
            os.replace(child, destination)
            old_entries.append((destination, child))
        for child in list(staging.iterdir()):
            destination = output / child.name
            os.replace(child, destination)
            new_entries.append((destination, child))
    except BaseException:
        for installed, original in reversed(new_entries):
            if installed.exists() and not original.exists():
                os.replace(installed, original)
        for saved, original in reversed(old_entries):
            if saved.exists() and not original.exists():
                os.replace(saved, original)
        raise
    shutil.rmtree(backup)
    staging.rmdir()


def assemble(
    output: Path,
    codec_source: Path | None,
    require_codecs: bool,
    source_commit: str,
) -> None:
    matrix = codec_matrix.load_matrix()
    application = matrix["application"]
    expected_version = application["version"]
    versions = {
        "matrix": expected_version,
        "builder": build_packages.PKG_VERSION,
        "verifier": verify_dist_module.verify_packages.PKG_VERSION,
    }
    if len(set(versions.values())) != 1:
        raise DistBuildError(f"Application version metadata differs: {versions!r}")

    output = validate_output_path(output)
    if codec_source is not None:
        if path_is_link_or_junction(codec_source):
            raise DistBuildError("Codec source must not be a symbolic link or junction")
        codec_source = codec_source.resolve()
        if (
            codec_source == output
            or output in codec_source.parents
            or codec_source in output.parents
        ):
            raise DistBuildError("Codec source and output directories must be separate")
        if not codec_source.is_dir():
            raise DistBuildError("Codec source must be a regular directory tree")
        source_commit_path = codec_source / "SOURCE_COMMIT"
        codec_source_commit = read_canonical_text(
            source_commit_path,
            MAX_SOURCE_COMMIT_BYTES,
            "codec source commit",
        )
        if codec_source_commit != source_commit + "\n":
            raise DistBuildError(
                "Codec source provenance does not match the requested source commit"
            )

    with tempfile.TemporaryDirectory(prefix="videoplayer-app-build-") as app_temp_raw:
        app_temp = Path(app_temp_raw)
        build_packages.validate_source_metadata()
        mtime = build_packages.source_date_epoch()
        files = build_packages.collect_files()
        ipk, apk, apk_uid = build_packages.build_all(files, mtime, app_temp)
        build_packages.verify_outputs(ipk, apk, expected_uid=apk_uid)
        build_packages.check_reproducible(files, mtime, ipk, apk)

        app_sources = {"apk": apk, "ipk": ipk}
        for package_format, source in app_sources.items():
            expected_name = application[f"{package_format}_filename"]
            if source.name != expected_name:
                raise DistBuildError(
                    f"Built {package_format.upper()} filename {source.name!r} "
                    f"does not match matrix filename {expected_name!r}"
                )
        app_hashes = {key: sha256_file(value) for key, value in app_sources.items()}

        staging = Path(
            tempfile.mkdtemp(prefix=f".{output.name}.build-", dir=output.parent)
        )
        try:
            entries: list[dict[str, object]] = []
            index_architectures: dict[str, dict[str, object]] = {
                arch: {} for arch in sorted(codec_matrix.EXPECTED_ARCHITECTURES)
            }
            missing_codecs: list[str] = []

            for entry in codec_matrix.build_entries(matrix):
                package_format = entry["format"]
                architecture = entry["arch"]
                release = matrix["releases"][package_format]
                relative_dir = Path(architecture) / entry["release_dir"]
                target_dir = staging / relative_dir
                target_dir.mkdir(parents=True, exist_ok=False)

                app_name = matrix["application"][f"{package_format}_filename"]
                app_destination = target_dir / app_name
                copy_regular_file(app_sources[package_format], app_destination)
                application_hash = app_hashes[package_format]

                codec_name = entry["codec_file"]
                codec_artifact = load_codec_artifact(
                    codec_source,
                    relative_dir,
                    codec_name,
                    app_name,
                )
                codec_hash: str | None = None
                if codec_artifact is None:
                    missing_codecs.append(entry["id"])
                    write_text(
                        target_dir / "CODEC_NOT_BUILT.txt",
                        (
                            "The architecture-specific codec runtime has not been "
                            "materialized in this local tree.\n"
                        ),
                    )
                else:
                    codec_package, codec_build_info = codec_artifact
                    codec_destination = target_dir / codec_name
                    copy_regular_file(codec_package, codec_destination)
                    copy_regular_file(codec_build_info, target_dir / "BUILD_INFO")
                    codec_hash = sha256_file(codec_destination)

                checksums = [(application_hash, app_name)]
                if codec_hash is not None:
                    checksums.append((codec_hash, codec_name))
                checksums.sort(key=lambda item: item[1])
                write_text(
                    target_dir / "SHA256SUMS",
                    "".join(f"{digest}  {name}\n" for digest, name in checksums),
                )

                package_set = package_set_metadata(
                    source_commit=source_commit,
                    package_format=package_format,
                    architecture=architecture,
                    release=release,
                    application_name=app_name,
                    application_hash=application_hash,
                    codec_name=codec_name,
                    codec_hash=codec_hash,
                )
                write_text(
                    target_dir / "PACKAGE_SET.json",
                    json.dumps(package_set, indent=2, sort_keys=True) + "\n",
                )
                index_architectures[architecture][package_format] = {
                    "directory": relative_dir.as_posix(),
                    "openwrt_release": release["openwrt_release"],
                    "openwrt_revision": release["openwrt_revision"],
                    "manager": release["manager"],
                    "application": package_set["application"],
                    "codec": package_set["codec"],
                }
                entries.append(package_set)

            if require_codecs and missing_codecs:
                preview = ", ".join(missing_codecs[:5])
                suffix = "..." if len(missing_codecs) > 5 else ""
                raise DistBuildError(
                    f"Missing {len(missing_codecs)} codec artifacts: {preview}{suffix}"
                )

            index = {
                "schema_version": 1,
                "source_commit": source_commit,
                "folder_key": "DISTRIB_ARCH",
                "application_version": matrix["application"]["version"],
                "codec_version": (
                    f"{matrix['codec']['version']}-r{matrix['codec']['release']}"
                ),
                "architecture_count": len(index_architectures),
                "package_set_count": len(entries),
                "codec_package_count": len(entries) - len(missing_codecs),
                "architectures": index_architectures,
            }
            write_text(
                staging / "INDEX.json",
                json.dumps(index, indent=2, sort_keys=True) + "\n",
            )
            write_text(staging / "SOURCE_COMMIT", source_commit + "\n")

            tsv_lines = [
                (
                    "# format|release|revision|architecture|application_path|"
                    "application_sha256|codec_path|codec_sha256\n"
                )
            ]
            for entry in entries:
                architecture = str(entry["architecture"])
                package_format = str(entry["package_format"])
                release = matrix["releases"][package_format]
                directory = (Path(architecture) / str(release["directory"])).as_posix()
                application = entry["application"]
                codec = entry["codec"]
                codec_path = ""
                codec_hash = ""
                if isinstance(codec, dict):
                    codec_path = f"{directory}/{codec['file']}"
                    codec_hash = str(codec["sha256"])
                tsv_lines.append(
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
                    + "\n"
                )
            write_text(staging / "INDEX.tsv", "".join(tsv_lines))

            try:
                verify_dist_module.verify_dist(staging, require_codecs)
            except verify_dist_module.DistVerificationError as exc:
                raise DistBuildError(
                    f"Staged distribution failed verification: {exc}"
                ) from exc
            install_staging_tree(staging, output)
        finally:
            if staging.exists():
                shutil.rmtree(staging)

    print(f"Architecture-scoped distribution assembled at {output}")
    print(f"  architecture folders: {len(codec_matrix.EXPECTED_ARCHITECTURES)}")
    print(f"  package sets: {len(codec_matrix.build_entries(matrix))}")
    print(f"  codec packages: {71 - len(missing_codecs)}")
    if missing_codecs:
        print(f"  codec placeholders: {len(missing_codecs)}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=DEFAULT_OUTPUT,
        help="architecture-scoped output directory (default: repository dist/)",
    )
    parser.add_argument(
        "--codec-source",
        type=Path,
        help="validated codec artifact tree with paths matching dist/",
    )
    parser.add_argument(
        "--require-codecs",
        action="store_true",
        help="fail unless all 71 codec artifacts are supplied",
    )
    parser.add_argument(
        "--source-commit",
        help="40-character source commit (default: current HEAD)",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    source_commit = args.source_commit or current_commit()
    if COMMIT.fullmatch(source_commit) is None:
        raise DistBuildError(
            "source commit must be 40 lowercase hexadecimal characters"
        )
    assemble(
        args.output_dir,
        args.codec_source,
        args.require_codecs,
        source_commit,
    )


if __name__ == "__main__":
    try:
        main()
    except (
        OSError,
        shutil.Error,
        subprocess.SubprocessError,
        build_packages.PackageBuildError,
        codec_matrix.MatrixError,
        DistBuildError,
        verify_dist_module.DistVerificationError,
    ) as exc:
        raise SystemExit(f"ERROR: {exc}") from exc
