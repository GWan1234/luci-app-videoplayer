# Private codec runtime

This directory builds a target-specific companion package for:

- OpenWrt `25.12.5` (`r33051-f5dae5ece4`)
- target `mediatek/filogic`
- package architecture `aarch64_cortex-a53`

The package is named `luci-videoplayer-codec-runtime`. It installs one
private FFmpeg executable at:

```text
/usr/libexec/videoplayer-ffmpeg/ffmpeg
```

It does not install or replace `/usr/bin/ffmpeg`, any `libav*.so`, or any
system library. The libav components are linked statically into the private
executable. Network protocols, AV devices, hardware accelerators, and
auto-detected external libraries are disabled. Native FFmpeg decoders,
demuxers, and filters remain enabled, including H.264, HEVC, VC-1, AAC, AC-3,
E-AC-3, DTS, FLAC, MP3, Opus, TrueHD, and Vorbis. The runtime also includes
the PCM S16LE encoder, the raw S16LE muxer, and the resampling filters used to
produce 48 kHz stereo audio for the web player.

The build is pinned to the official OpenWrt 25.12.5 mediatek/filogic SDK and
the packages-feed commit recorded by that release. CI also applies the FFmpeg
patch set from that exact feed commit, sets `CONFIG_BUILD_PATENTED=y`, validates
the target metadata, verifies that the ELF's only dynamic dependency is the
target `libc`, checks the required decoder and output features under AArch64
emulation, and performs H.264-to-JPEG and AAC-to-PCM smoke tests. The audio
test additionally verifies that its raw output is an exact sequence of
48,000-byte quarter-second blocks.

After those checks pass for `main`, CI publishes
`luci-videoplayer-codec-runtime-6.1.4-r2.apk`, its checksum, build metadata,
and the source commit under the exact target tuple in the generated
`codec-snapshot` branch. `scripts/install-codec-runtime.sh` resolves that
branch immutably and refuses every release, revision, target, or architecture
other than the tuple above.

Every additional OpenWrt target needs its own checksum-pinned SDK build and
separate artifact directory. An APK from this directory must not be treated as
a generic AArch64 package merely because another router also reports
`aarch64`.

Do not install the resulting APK on another OpenWrt release, revision, target,
or architecture. The package pre-install script rejects a mismatched live
system. Building or distributing codec support may be subject to patent rules
in your jurisdiction.
