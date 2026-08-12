#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Adversarial checks for the software-cpu-v1 package attestation."""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import verify_codec_package  # noqa: E402


def configuration_blob(options: list[str]) -> bytes:
    return b"%sconfiguration: " + " ".join(options).encode("ascii") + b"\x00"


def expect_rejected(options: list[str], label: str) -> None:
    try:
        verify_codec_package.verify_software_configuration(
            configuration_blob(options)
        )
    except verify_codec_package.CodecPackageVerificationError:
        return
    raise AssertionError(f"software-cpu-v1 accepted {label}")


def make_definition(makefile: str, name: str) -> list[str]:
    marker = f"define {name}\n"
    assert makefile.count(marker) == 1
    body = makefile.split(marker, 1)[1].split("\nendef", 1)[0]
    return [line.strip() for line in body.splitlines() if line.strip()]


def marked_allowlist_block(path: Path) -> str:
    text = path.read_text(encoding="utf-8")
    begin = "# CODEC_REPORT_ALLOWLIST_BEGIN\n"
    end = "# CODEC_REPORT_ALLOWLIST_END\n"
    assert text.count(begin) == 1 and text.count(end) == 1
    return begin + text.split(begin, 1)[1].split(end, 1)[0] + end


def inspect_component_report(block: str, report: str, allowed: str) -> str:
    sentinel = "CODEC_ATTESTATION_REPORT_EOF"
    assert sentinel not in report
    program = (
        block
        + f'\ncat <<\'{sentinel}\' | unexpected_codec_aliases - "$1"\n'
        + report
        + f"{sentinel}\n"
    )
    if shutil.which("sh") is not None:
        command = ["sh", "-s", "--", allowed]
    else:
        command = [
            "wsl",
            "-u",
            "root",
            "--",
            "sh",
            "-s",
            "--",
            allowed,
        ]
    result = subprocess.run(
        command,
        input=program.encode("utf-8"),
        capture_output=True,
        check=True,
    )
    assert result.stderr == b""
    return result.stdout.decode("utf-8").strip()


def run_lifecycle_adversarial_checks() -> None:
    pre_lines = [
        "#!/bin/sh",
        *verify_codec_package.renderer_maintenance_enter_lines("replacing"),
        "exit 0",
    ]
    post_lines = [
        "#!/bin/sh",
        *verify_codec_package.renderer_maintenance_exit_lines("installing"),
        "exit 0",
    ]

    def isolated_script(lines: list[str]) -> str:
        return (
            "\n".join(lines)
            .replace(
                verify_codec_package.RENDERER_HELPER_PATH,
                "${CASE_DIR}/renderer",
            )
            .replace(
                verify_codec_package.RENDERER_MAINTENANCE_PATH,
                "${CASE_DIR}/maintenance",
            )
            + "\n"
        )

    program = f"""\
set -eu
CASE_DIR="$(mktemp -d)"
export CASE_DIR
trap 'rm -rf -- "$CASE_DIR"' EXIT HUP INT TERM
mkdir "$CASE_DIR/bin"
cat >"$CASE_DIR/bin/stat" <<'CODEC_STAT_EOF'
#!/bin/sh
stat_target=
for stat_argument do
    stat_target="$stat_argument"
done
case "$stat_target" in
*/renderer) printf '%s\n' "${{FAKE_HELPER_STAT:-0:755}}" ;;
*/maintenance) printf '%s\n' "${{FAKE_MARKER_STAT:-0:600:15}}" ;;
*) exit 64 ;;
esac
CODEC_STAT_EOF
chmod 755 "$CASE_DIR/bin/stat"
PATH="$CASE_DIR/bin:$PATH"
export PATH

cat >"$CASE_DIR/renderer" <<'CODEC_HELPER_EOF'
#!/bin/sh
printf '%s\n' "$1" >>"$FAKE_CALLS"
case "$1" in
maintenance-enter)
    case "$FAKE_MODE" in
    unknown) exit 2 ;;
    enter-fail) exit 1 ;;
    esac
    (umask 077 && printf 'maintenance-v1\n' >"$FAKE_MARKER")
    if [ "$FAKE_MODE" = "bad-ack" ]; then
        printf 'maintenance\nextra\n'
    elif [ "$FAKE_MODE" = "no-newline" ]; then
        printf 'maintenance'
    else
        printf 'maintenance\n'
    fi
    ;;
cleanup)
    [ -f "$FAKE_MARKER" ] || exit 10
    [ "$FAKE_MODE" != "cleanup-fail" ] || exit 9
    if [ "$FAKE_MODE" = "cleanup-drops-marker" ]; then
        rm -f -- "$FAKE_MARKER"
    fi
    ;;
maintenance-exit)
    [ -f "$FAKE_MARKER" ] || exit 11
    [ "$FAKE_MODE" != "exit-fail" ] || exit 8
    if [ "$FAKE_MODE" != "exit-keeps-marker" ]; then
        rm -f -- "$FAKE_MARKER"
    fi
    printf 'resumed\n'
    ;;
*) exit 64 ;;
esac
CODEC_HELPER_EOF
chmod 755 "$CASE_DIR/renderer"
export FAKE_CALLS="$CASE_DIR/calls"
export FAKE_MARKER="$CASE_DIR/maintenance"

cat >"$CASE_DIR/pre" <<'CODEC_PRE_SCRIPT_EOF'
{isolated_script(pre_lines)}CODEC_PRE_SCRIPT_EOF
cat >"$CASE_DIR/post" <<'CODEC_POST_SCRIPT_EOF'
{isolated_script(post_lines)}CODEC_POST_SCRIPT_EOF
chmod 755 "$CASE_DIR/pre" "$CASE_DIR/post"

reset_case() {{
    rm -f -- "$CASE_DIR/calls" "$CASE_DIR/maintenance" \
        "$CASE_DIR/mutated" "$CASE_DIR/stdout" "$CASE_DIR/stderr"
    export FAKE_MODE="$1"
    export FAKE_HELPER_STAT="${{2:-0:755}}"
    export FAKE_MARKER_STAT="${{3:-0:600:15}}"
}}
run_pre() {{
    if "$CASE_DIR/pre" >"$CASE_DIR/stdout" 2>"$CASE_DIR/stderr"; then
        PRE_STATUS=0
        : >"$CASE_DIR/mutated"
    else
        PRE_STATUS=$?
    fi
}}
run_post() {{
    if "$CASE_DIR/post" >"$CASE_DIR/stdout" 2>"$CASE_DIR/stderr"; then
        POST_STATUS=0
    else
        POST_STATUS=$?
    fi
}}

reset_case success
run_pre
[ "$PRE_STATUS" -eq 0 ]
[ -f "$CASE_DIR/mutated" ]
[ -f "$CASE_DIR/maintenance" ]
[ "$(cat "$CASE_DIR/calls")" = "maintenance-enter
cleanup" ]
run_post
[ "$POST_STATUS" -eq 0 ]
[ ! -e "$CASE_DIR/maintenance" ]
[ "$(cat "$CASE_DIR/calls")" = "maintenance-enter
cleanup
maintenance-exit" ]

reset_case unknown
run_pre
[ "$PRE_STATUS" -ne 0 ]
[ ! -e "$CASE_DIR/mutated" ]
[ ! -e "$CASE_DIR/maintenance" ]
[ "$(cat "$CASE_DIR/calls")" = "maintenance-enter" ]
grep -F "Install luci-app-videoplayer 1.2.0 or newer first" \
    "$CASE_DIR/stderr" >/dev/null

reset_case enter-fail
run_pre
[ "$PRE_STATUS" -ne 0 ]
[ ! -e "$CASE_DIR/mutated" ]
[ ! -e "$CASE_DIR/maintenance" ]
[ "$(cat "$CASE_DIR/calls")" = "maintenance-enter" ]

reset_case bad-ack
run_pre
[ "$PRE_STATUS" -ne 0 ]
[ ! -e "$CASE_DIR/mutated" ]
[ -f "$CASE_DIR/maintenance" ]
[ "$(cat "$CASE_DIR/calls")" = "maintenance-enter" ]

reset_case no-newline
run_pre
[ "$PRE_STATUS" -ne 0 ]
[ ! -e "$CASE_DIR/mutated" ]
[ -f "$CASE_DIR/maintenance" ]
[ "$(cat "$CASE_DIR/calls")" = "maintenance-enter" ]

reset_case cleanup-fail
run_pre
[ "$PRE_STATUS" -ne 0 ]
[ ! -e "$CASE_DIR/mutated" ]
[ -f "$CASE_DIR/maintenance" ]
[ "$(cat "$CASE_DIR/calls")" = "maintenance-enter
cleanup" ]

reset_case cleanup-drops-marker
run_pre
[ "$PRE_STATUS" -ne 0 ]
[ ! -e "$CASE_DIR/mutated" ]
[ ! -e "$CASE_DIR/maintenance" ]
[ "$(cat "$CASE_DIR/calls")" = "maintenance-enter
cleanup" ]

reset_case success 0:754
run_pre
[ "$PRE_STATUS" -ne 0 ]
[ ! -e "$CASE_DIR/mutated" ]
[ ! -e "$CASE_DIR/calls" ]
[ ! -e "$CASE_DIR/maintenance" ]

reset_case success 0:755 0:600:14
run_pre
[ "$PRE_STATUS" -ne 0 ]
[ ! -e "$CASE_DIR/mutated" ]
[ -f "$CASE_DIR/maintenance" ]
[ "$(cat "$CASE_DIR/calls")" = "maintenance-enter
cleanup" ]

reset_case success
run_post
[ "$POST_STATUS" -eq 0 ]
[ ! -e "$CASE_DIR/calls" ]

reset_case success
run_pre
[ "$PRE_STATUS" -eq 0 ]
export FAKE_MODE=exit-fail
run_post
[ "$POST_STATUS" -ne 0 ]
[ -f "$CASE_DIR/maintenance" ]
[ "$(cat "$CASE_DIR/calls")" = "maintenance-enter
cleanup
maintenance-exit" ]

reset_case success
run_pre
[ "$PRE_STATUS" -eq 0 ]
export FAKE_MODE=exit-keeps-marker
run_post
[ "$POST_STATUS" -ne 0 ]
[ -f "$CASE_DIR/maintenance" ]
[ "$(cat "$CASE_DIR/calls")" = "maintenance-enter
cleanup
maintenance-exit" ]

reset_case success
run_pre
[ "$PRE_STATUS" -eq 0 ]
printf 'not-maintenance\n' >"$CASE_DIR/maintenance"
run_post
[ "$POST_STATUS" -ne 0 ]
[ -f "$CASE_DIR/maintenance" ]
[ "$(cat "$CASE_DIR/calls")" = "maintenance-enter
cleanup" ]

reset_case success
mv "$CASE_DIR/renderer" "$CASE_DIR/renderer.saved"
run_pre
[ "$PRE_STATUS" -eq 0 ]
[ -f "$CASE_DIR/mutated" ]
[ ! -e "$CASE_DIR/calls" ]
run_post
[ "$POST_STATUS" -eq 0 ]
mv "$CASE_DIR/renderer.saved" "$CASE_DIR/renderer"
"""
    if shutil.which("sh") is not None:
        command = ["sh", "-s"]
    else:
        command = ["wsl", "-u", "root", "--", "sh", "-s"]
    result = subprocess.run(
        command,
        input=program.encode("utf-8"),
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise AssertionError(
            "codec lifecycle adversarial checks failed:\n"
            + result.stderr.decode("utf-8", errors="replace")
        )
    assert result.stdout == b""


def main() -> None:
    build_info_template = (
        ROOT / "codec-runtime" / "package" / "files" / "build-info.template"
    ).read_text(encoding="utf-8").splitlines()
    for exact_runtime_field in (
        "format=4",
        "renderer_profile=software-cpu-v1",
        "execution_backend=software-cpu-v1",
        "software_cpu_only=1",
        "audio_chunk_frames=48000",
        "audio_chunk_bytes=192000",
    ):
        assert build_info_template.count(exact_runtime_field) == 1

    options = sorted(verify_codec_package.REQUIRED_SOFTWARE_CONFIGURATION)
    options.extend(
        f"--enable-decoder={decoder}"
        for decoder in sorted(verify_codec_package.SOFTWARE_DECODERS)
    )
    options.extend(
        f"--enable-encoder={encoder}"
        for encoder in sorted(verify_codec_package.SOFTWARE_ENCODERS)
    )
    verify_codec_package.verify_software_configuration(configuration_blob(options))

    missing_hw_disable = [
        option for option in options if option != "--disable-hwaccels"
    ]
    expect_rejected(missing_hw_disable, "a runtime without --disable-hwaccels")

    hardware_decoder = [*options, "--enable-decoder=h264_v4l2m2m"]
    expect_rejected(hardware_decoder, "a hardware-wrapper decoder")

    hardware_encoder = [*options, "--enable-encoder=h264_v4l2m2m"]
    expect_rejected(hardware_encoder, "a hardware-wrapper encoder")

    enabled_hwaccels = [*options, "--enable-hwaccels"]
    expect_rejected(enabled_hwaccels, "an enabled hardware-accelerator backend")
    explicit_hwaccel = [*options, "--enable-hwaccel=h264_vaapi"]
    expect_rejected(explicit_hwaccel, "an explicitly enabled hardware accelerator")
    enabled_encoders = [*options, "--enable-encoders"]
    expect_rejected(enabled_encoders, "a reopened global encoder set")

    reordered_decoders = [
        *(option for option in options if option != "--disable-decoders"),
        "--disable-decoders",
    ]
    expect_rejected(
        reordered_decoders, "a decoder allowlist opened before its global disable"
    )

    reordered_encoders = [
        *(option for option in options if option != "--disable-encoders"),
        "--disable-encoders",
    ]
    expect_rejected(
        reordered_encoders, "an encoder allowlist opened before its global disable"
    )

    makefile = (ROOT / "codec-runtime" / "package" / "Makefile").read_text(
        encoding="utf-8"
    )
    assert makefile.count('"$${renderer_helper}" maintenance-enter') == 2
    assert makefile.count('"$${renderer_helper}" cleanup || {') == 2
    assert makefile.count('"$${renderer_helper}" maintenance-exit') == 2
    lifecycle_values = {
        "openwrt_release": "test-release",
        "openwrt_revision": "test-revision",
        "compatible_arch": "test-architecture",
    }
    actual_preinst = make_definition(
        makefile, "Package/luci-videoplayer-codec-runtime/preinst"
    )
    actual_preinst = [
        line.replace("$$", "$")
        .replace("$(CODEC_OPENWRT_RELEASE)", lifecycle_values["openwrt_release"])
        .replace("$(CODEC_OPENWRT_REVISION)", lifecycle_values["openwrt_revision"])
        .replace("$(CODEC_COMPATIBLE_ARCH)", lifecycle_values["compatible_arch"])
        for line in actual_preinst
    ]
    assert actual_preinst == verify_codec_package.preinst_lines(lifecycle_values)

    actual_postinst = make_definition(
        makefile, "Package/luci-videoplayer-codec-runtime/postinst"
    )
    actual_postinst = [line.replace("$$", "$") for line in actual_postinst]
    assert actual_postinst == verify_codec_package.codec_postinst_lines()

    actual_prerm = make_definition(
        makefile, "Package/luci-videoplayer-codec-runtime/prerm"
    )
    actual_prerm = [line.replace("$$", "$") for line in actual_prerm]
    assert actual_prerm == verify_codec_package.codec_prerm_lines()

    actual_postrm = make_definition(
        makefile, "Package/luci-videoplayer-codec-runtime/postrm"
    )
    actual_postrm = [line.replace("$$", "$") for line in actual_postrm]
    assert actual_postrm == verify_codec_package.codec_postrm_lines()

    run_lifecycle_adversarial_checks()

    installer_allowlist = marked_allowlist_block(
        ROOT / "scripts" / "install-codec-runtime.sh"
    )
    validator_allowlist = marked_allowlist_block(
        ROOT / "codec-runtime" / "validate-runtime.sh"
    )
    assert installer_allowlist == validator_allowlist
    legend_and_allowed = """\
Decoders:
 V..... = Video
 A..... = Audio
 S..... = Subtitle
 VF...D h264
 V....D h264,hevc
"""
    assert (
        inspect_component_report(
            installer_allowlist, legend_and_allowed, "h264 hevc"
        )
        == ""
    )
    unexpected_real_codec = legend_and_allowed + " V....D h264_v4l2m2m\n"
    assert inspect_component_report(
        installer_allowlist, unexpected_real_codec, "h264 hevc"
    ) == "h264_v4l2m2m"
    malformed_alias = legend_and_allowed + " V....D h264-v4l2m2m\n"
    assert inspect_component_report(
        installer_allowlist, malformed_alias, "h264 hevc"
    ) == "__invalid_component_alias__"

    print("Codec software-cpu-v1 attestation checks passed.")


if __name__ == "__main__":
    main()
