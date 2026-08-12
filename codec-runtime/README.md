# Private FFmpeg codec matrix

This directory builds architecture-specific private FFmpeg packages for the
current official OpenWrt stable and old-stable releases:

- OpenWrt `25.12.5` (`r33051-f5dae5ece4`): 35 APK package architectures
- OpenWrt `24.10.8` (`r29233-443ec4032a`): 36 IPK package architectures
- 37 unique `DISTRIB_ARCH` values and 71 codec builds in total

`matrix.json` is the checksum-pinned source of truth. Folder names use the
exact OpenWrt package ABI reported as `DISTRIB_ARCH`; they do not use the
marketing name of a processor or the broader value returned by `uname -m`.
For example, OpenWrt distinguishes `aarch64_cortex-a53`,
`aarch64_cortex-a72`, `aarch64_cortex-a76`, and `aarch64_generic`.

The generated layout is release-qualified because a binary built for one
OpenWrt series is not made compatible with another series merely by sharing a
CPU:

```text
dist/
└── aarch64_cortex-a53/
    ├── openwrt-25.12.5-r33051-f5dae5ece4/
    │   ├── luci-app-videoplayer-1.2.0.apk
    │   ├── luci-videoplayer-codec-runtime-6.1.4-r4.apk
    │   ├── BUILD_INFO
    │   ├── PACKAGE_SET.json
    │   └── SHA256SUMS
    └── openwrt-24.10.8-r29233-443ec4032a/
        ├── luci-app-videoplayer_1.2.0_all.ipk
        ├── luci-videoplayer-codec-runtime_6.1.4-r4_aarch64_cortex-a53.ipk
        ├── BUILD_INFO
        ├── PACKAGE_SET.json
        └── SHA256SUMS
```

The application package remains architecture-independent (`noarch` for APK
and `all` for IPK), so byte-identical application packages are placed in every
compatible directory. The codec runtime is never copied between
architectures: every APK and IPK contains a separately cross-compiled FFmpeg
executable.

## Runtime isolation

The package installs two private executables at:

```text
/usr/libexec/videoplayer-ffmpeg/ffmpeg
/usr/libexec/videoplayer-ffmpeg/videoplayer-mjpeg-relay
```

It does not replace `/usr/bin/ffmpeg`, any system `libav*.so`, or any other
global library. The libav components are linked statically into the private
FFmpeg executable. The small frame-aligned MJPEG relay is compiled for the
same target ABI, with its GCC compiler support routines linked statically.
Each executable's only permitted dynamic dependency is the target's `libc`.
Network protocols, AV devices, hardware accelerators, and auto-detected
external libraries are disabled.

The build enables native software decoders and the components required for
H.264-to-continuous-MJPEG video output and AAC-to-48 kHz stereo PCM audio
output. This includes the `mpjpeg`, raw PCM, and `tee` muxers plus the `apad`
filter used to end both outputs on the video timeline; H.264, HEVC, VC-1,
MPEG-4, VP8, VP9, AV1, MJPEG, AAC, AC-3, E-AC-3, DTS, FLAC, MP3, Opus,
ALAC, PCM S16LE, TrueHD, and Vorbis, subject to what FFmpeg 6.1.4 supports.
It is not a promise
to decode every existing or future media format, DRM system, encrypted stream,
or damaged file.

## Pinned builds

Every matrix entry records:

- exact OpenWrt release and revision;
- package format and `DISTRIB_ARCH`;
- one representative target/subtarget SDK;
- SDK filename and SHA-256 checksum;
- `feeds.buildinfo` checksum and packages-feed commit;
- QEMU user-mode emulator and the applicable runtime or static validation mode.

The format-4 `BUILD_INFO` records `renderer_profile=software-cpu-v1`,
`execution_backend=software-cpu-v1`, and `software_cpu_only=1`. The installer
requires all three attestation fields and the exact private binary path, so a
pre-r4 package or incomplete same-version package is repaired rather than
accepted as a strict CPU runtime.

Multiple OpenWrt targets can share a userspace package ABI. The representative
SDK target is therefore build provenance, not an installation restriction.
The package pre-install script checks the exact release, revision, and
`DISTRIB_ARCH`. This is safe for this libc-only userspace runtime; it would not
be sufficient for a kernel module.

On a live router with the application installed, codec install, upgrade, and
removal enter the renderer's maintenance gate and quiesce all sessions before
package files can change. The gate stays active on every pre-hook failure and
is released only by the matching successful post-hook. A legacy renderer
helper is rejected with an instruction to install application 1.2.0 or newer;
the package never falls back to an unguarded cleanup. Standalone codec
installation and removal remain valid when no renderer helper is installed.

The matrix includes the official Malta `mips64_mips64r2` and
`mips64el_mips64r2` SDKs and marks them as emulator entries. OpenWrt 25.12 has
the APK-only `riscv64_generic` ABI. OpenWrt 24.10 has the IPK-only
`mips_4kec` and `riscv64_riscv64` ABIs.

## Validation and publication

The GitHub workflow validates `matrix.json`, downloads every official SDK over
HTTPS, verifies its pinned checksum, pins the packages feed, applies that
feed's FFmpeg patch set, and builds the private package with
`CONFIG_BUILD_PATENTED=y`.

Each resulting executable is checked statically for:

- an isolated three-file package payload;
- exact package name, version, ABI, internal build metadata, and ELF target;
- no dynamic libav dependency, RPATH, or unexpected shared library;
- required decoder, encoder, demuxer, muxer, and filter lists;
- fail-closed native software decoder and encoder allowlists derived from its
  embedded build configuration and generated component headers;

On every QEMU-compatible architecture the executable is additionally checked
for:

- frame-aligned MJPEG relay resynchronization after a truncated segment;
- an empty runtime `ffmpeg -hwaccels` report;
- H.264-to-multipart-MJPEG decoding under the architecture's QEMU user
  emulator when the ISA is faithfully supported;
- AAC-to-PCM output in exact 192,000-byte one-second chunks under the same
  condition.

The `mipsel_74kc` runtime is executed with QEMU's explicit `74Kf` CPU model;
QEMU's default MIPS CPU does not implement all instructions emitted for 74Kc.

The Octeon and embedded PowerPC ABIs use static ELF, linkage, FFmpeg
configuration, component, and package validation because QEMU user mode cannot
faithfully execute those CPU-specific userspace ABIs. `armeb_xscale` uses the
same static validation because QEMU's big-endian ARM user emulation has a known
VDSO `SIGSEGV`
([QEMU issue #2333](https://gitlab.com/qemu-project/qemu/-/issues/2333)).
Pull requests and pushes run a representative eight-architecture smoke matrix.
An explicit full manual workflow run builds all 71 entries. Publication happens
only after that full matrix succeeds. The generated `codec-snapshot` branch
contains the complete architecture-scoped `dist/` tree; the source branch
contains only recipes, the pinned matrix, and verification code.

Official architecture inventories are published at:

- <https://downloads.openwrt.org/releases/packages-25.12/>
- <https://downloads.openwrt.org/releases/packages-24.10/>

Do not install a codec package outside the exact release, revision, and
architecture recorded in its directory and `BUILD_INFO`. CPU speed, flash,
RAM, thermals, storage throughput, and codec patent rules remain practical and
legal constraints even when a package exists for an architecture.
