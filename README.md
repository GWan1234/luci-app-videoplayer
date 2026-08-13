# luci-app-videoplayer

A joke but functional video player for **OpenWrt**, integrated into **LuCI**.
Local videos can either be decoded normally by the client browser or processed
by the router in a strict software-CPU mode and delivered as MJPEG plus PCM.
Both the Fast and Quality router profiles use only the attested private FFmpeg
runtime: source video/audio decoding, filtering, scaling, MJPEG encoding, and
PCM production run in software on the router CPU. The mode fails closed rather
than silently decoding the original file or its original audio in the browser.
A fetch-capable browser first builds a bounded client-side buffer containing at
least 120 seconds of router-produced JPEG frames and PCM audio, or the complete
stream when it is shorter. It then presents those already-produced outputs on a
persistent canvas and through Web Audio. Browser/OS presentation, compositing,
and audio-device implementation are outside a web application's control and
are therefore not claimed to be CPU-only. Playback stays inside LuCI and does
not use the router's HDMI or framebuffer.

Current source package version: **1.1.0**. The latest published GitHub release
is **1.1.0**. Its release installer installs the application and the exact
architecture-specific private codec runtime together. A separate APK-only
installer follows the latest successfully tested `main` source.

## Features

| Mode | How it works |
|---|---|
| Browser decoding | Browse local storage and stream the original file to the HTML5 `<video>` element with HTTP Range support |
| Router CPU rendering | Strict, fail-closed software processing through the attested private FFmpeg runtime. Fast and Quality both decode the source, filter/scale video, encode MJPEG, and produce PCM only on the router CPU; the browser presents only those JPEG/PCM outputs |
| Remote URLs | Play `http://` and `https://` URLs only in Browser mode. Router mode refuses them instead of proxying them through FFmpeg or silently changing render modes |
| Interface | **Services → Video Player** page in LuCI |

The local browser recognizes common containers and raw streams, including
MP4/M4V/MOV, WebM, MKV, AVI/DivX, Ogg, MPEG/VOB, MPEG-TS/M2TS/MTS, FLV/F4V,
WMV/ASF, 3GP/3G2, RealMedia, and raw H.264/H.265 files. Extension matching is
case-insensitive. MP4 with H.264 video and AAC audio offers the broadest
client-browser compatibility. Router CPU mode depends on the native software
decoders enabled in the installed private codec runtime, so it may support a
different subset.
When CPU mode is available, the browser lists every regular non-symlink file
inside the media directory so FFmpeg can probe uncommon containers and files
without an extension by content. Browser mode keeps the extension allowlist and
does not stream arbitrary files. Directory entries are sorted on the router in
a stable bytewise order and returned in pages of 100 entries. A link to the
parent directory is available on every page.

```text
LuCI (main.js)
    │ ubus/rpcd
    ▼
luci.videoplayer ── authenticated list / resolve / renderer control
    │
    ├── Browser mode ── /cgi-bin/videoplayer-stream?token=…
    │                    └── original file with HTTP Range (206)
    │
    └── Router mode ─── attested private software-only FFmpeg producer
                         ├── MJPEG FIFO → /cgi-bin/videoplayer-frame?token=…
                         │                 └── browser JPEG buffer → canvas
                         ├── PCM FIFO/ring → /cgi-bin/videoplayer-audio
                         │                  ?token=…&chunk=…&count=…
                         │                  └── browser PCM buffer → Web Audio 1×
                         └── any strict-path failure → stop with an error

UCI videoplayer.main.media_path ── root of the accessible media library
```

LuCI calls ACL-protected backend methods. Browser resolution and renderer
status require read permission; starting or stopping the CPU renderer requires
write permission. The unrestricted regular-file listing used only by CPU mode
also requires write permission; the read-only `list` method retains the video
extension allowlist. A read-only account cannot start strict router processing
and is told to select Browser mode explicitly instead of being silently moved
there.

Normal browser mode uses a separate short-lived opaque path token. Its CGI
endpoint accepts only that token, never a file path supplied by the browser.
These tokens are stored in 4,096 fixed bucket slots, preventing their count and
lookup cost from growing without bound. If a random collision selects a slot
containing an unexpired token, the backend chooses another slot instead of
overwriting it.

Router CPU mode has a separate single-session runtime. Only one CPU-rendering
session may run at a time, and selecting another local video replaces the
previous session. Each session uses its own random token directory under
`/tmp`; FFmpeg writes its native multipart MJPEG output into a root-only,
bounded FIFO and one relay CGI at a time forwards it directly to the browser.
LuCI incrementally parses complete JPEG parts and stores them in a bounded
browser-side queue. There is no temporary JPEG, filesystem scan, or process
launch per frame on the router. The application ends each nonterminal response
after the first of 45 wall-clock seconds, 20 seconds of configured video frames
(capped at 300 frames), or 16 MiB of complete JPEG payload, always between
frames, then LuCI
opens the next segment when its bounded buffer has capacity. This is one
request per segment rather than one request per frame. The frame sequence is
global across those segments, so reconnect wall time is not added to media
time. The relay validates a complete bounded JPEG before publishing it. Any
ambiguous HTTP interruption after dispatch stops the whole strict playback
because the browser cannot prove how many FIFO frames uHTTPd already consumed.
At video EOF, a nonce-bound two-phase drain and acknowledgement prove both FIFO
completion and a clean browser body before the final timeline is sealed. Only
one MJPEG viewer may hold the session stream at a time, which prevents duplicate
tabs from exhausting uHTTPd's small CGI worker pool.

After bounded media and audio probes, a single long-lived FFmpeg process opens
two independent demux contexts on the same validated, immutable source
descriptor: one selects video and one selects audio. This prevents a much
longer audio track in one container from hiding video EOF until global input
EOF. The process produces MJPEG and PCM from the same normalized input
timeline. Video decoding uses the detected online CPU count, capped at four
threads to bound memory on embedded targets. The Fast profile uses the same
bounded count for filtering and MJPEG encoding; Quality uses one thread on a
single-core router and at most two elsewhere. FFmpeg remains at reduced
scheduler priority so it yields to LuCI and network traffic under load, but no
input pacing option limits how quickly it can use otherwise idle CPU.
Its unified `tee` output pads a short audio track with silence
and stops an overlong audio track when video ends, so video is the authoritative
timeline and neither length mismatch can stall the producer. LuCI immediately
drains sequential PCM batches and complete JPEG frames into bounded browser
memory. Playback starts after both available
tracks contain at least 120 seconds, or after clean end of input for a shorter
video. Web Audio runs at exactly 1× and supplies the master media clock;
`requestAnimationFrame()` selects the matching JPEG for a persistent canvas.
No image element is replaced between frames, and audio speed or pitch is never
changed to chase renderer or network jitter. If either queue runs dry, both
tracks pause on the last complete position and resume only after a refill. A
source with no audio stream plays silently. If a source advertises audio but
the private runtime cannot decode it, or if the PCM path fails during playback,
the complete strict session stops; the original audio is never handed back to
the browser. A browser without the required streaming, canvas, and Web Audio
features cannot start Router mode and must be switched explicitly to Browser
mode. The session renews a 90-second
inactivity lease while rendering, buffering, or playback is active. This
tolerates minute-level timer throttling in a background browser tab. Closing
the page or losing the client stops the sole allowed renderer after that
bounded delay, and every session also has an absolute six-hour expiry.
After a clean terminal drain, the worker releases FFmpeg, source descriptors,
FIFO, ring, relay, and log resources. **Stop**, replacement by another session,
90 seconds without a heartbeat, or the absolute expiry also releases them.

## Requirements

The package directly depends on `luci-base`, `uhttpd`, `jshn`,
`coreutils-stat`, and `coreutils-timeout`. FFmpeg is optional for Browser mode.
Router CPU mode requires the architecture-specific private codec runtime and
refuses to start without its complete software-only attestation; it never uses
`/usr/bin/ffmpeg` or another executable found through `PATH`.
The application itself contains no CPU-specific binaries, so its architecture
remains `all` for IPK and `noarch` for APK.

FFmpeg is large for router software. Depending on architecture and repository
configuration, `libffmpeg-full` alone may consume roughly 14–23 MiB after
installation, before its other dependencies. Router CPU mode also requires an
FFmpeg build containing the native MJPEG encoder, the `mpjpeg` muxer, and the
`fps`, `scale`, and `format` filters. Router-decoded PCM audio additionally
requires the `pcm_s16le` encoder, the `s16le` muxer, and the `aresample`,
`aformat`, `apad`, and `asetnsamples` filters, plus the `tee` muxer. The UI
checks these capabilities before
enabling the corresponding router output. A file with no audio stream is valid,
but an advertised audio stream whose software decoder or PCM path is unusable
causes the strict session to stop.

Despite its name, the official OpenWrt `libffmpeg-full` package is built
without H.264, HEVC, and VC-1 decoders when OpenWrt's global
`CONFIG_BUILD_PATENTED` option is disabled, as it is for official package
repositories. Router-side decoding of those codecs requires an FFmpeg package
built for the router's exact OpenWrt release and architecture with the needed
decoders enabled. Do not install libraries built for another release or ABI.
The user is responsible for checking codec patent and distribution rules in
their jurisdiction.

This repository also builds an optional architecture-specific companion named
`luci-videoplayer-codec-runtime`. Unlike a replacement system FFmpeg package,
it installs private FFmpeg and a small frame-aligned MJPEG relay under
`/usr/libexec/videoplayer-ffmpeg/`. The relay gives bounded CGI segments exact
complete-frame handoffs; a slower shell implementation remains available if
the relay fails its root-owned filesystem safety check. The package does not
overwrite `/usr/bin/ffmpeg` or install global `libav*.so` files. Its root-owned
build metadata attests the private executable, exact software-only execution
profile, and disabled hardware-acceleration surface. The renderer accepts only
that fixed private executable after repeating filesystem, metadata, component,
decoder, and hardware-acceleration checks. Missing, outdated, unsafe, or
mismatched runtime state makes Router mode unavailable instead of selecting a
system FFmpeg.

The codec build matrix covers every package ABI published for the current
official OpenWrt stable and old-stable releases: 35 APK architectures for
OpenWrt 25.12.5 and 36 IPK architectures for OpenWrt 24.10.8, producing 37
unique `DISTRIB_ARCH` folders and 71 separately compiled codec packages. The
folder key is the exact OpenWrt package ABI, not a marketing CPU name or the
broader value returned by `uname -m`.

If the player reports that the installed FFmpeg has no usable decoder for a
video, inspect the installed decoder list:

```sh
/usr/libexec/videoplayer-ffmpeg/ffmpeg -hide_banner -decoders 2>/dev/null | grep -E 'h264|hevc|vc1'
```

A plain decoder entry such as `h264` is the native software decoder. If it is
listed but playback still fails, the player now reports a bounded, sanitized
FFmpeg diagnostic that can be used to identify the separate failure. An entry
such as `h264_v4l2m2m` is only a hardware wrapper and is deliberately excluded
from strict Router mode. That mode never accepts an arbitrary or system FFmpeg
build. If the required native decoder is absent, use Browser mode or install a
future attested `luci-videoplayer-codec-runtime` release whose exact
software-only allowlist includes the codec.

The scripts also use standard OpenWrt BusyBox commands, including `sort -z`
and `flock`.

## Preparing the Storage

The application deliberately **does not create `/mnt/video` automatically**.
First connect a USB drive or SD card, create the mount point, and confirm that
the storage device is actually mounted:

```sh
mkdir -p /mnt/video
mount /dev/sda1 /mnt/video       # Example; the device and filesystem may differ
mount | grep ' /mnt/video '
df -h /mnt/video
```

Copy videos there only after these checks succeed. If the storage device is not
mounted, writing to `/mnt/video` will use the router's internal overlay and may
quickly exhaust its flash storage.

To use a different path:

```sh
uci set videoplayer.main.media_path='/path/to/media'
uci commit videoplayer
/etc/init.d/rpcd reload
```

## Quick Installation from GitHub

### Published Release (APK or IPK)

After preparing the storage, connect to the router over SSH as `root`. The
router must have working HTTPS access to GitHub:

```sh
sh <(wget -O - https://github.com/communism420/luci-app-videoplayer/releases/download/1.1.0/install-from-github.sh)
```

This compact command uses the process-substitution support provided by the
standard OpenWrt BusyBox `ash` shell. The release URL points to the installer
asset attached directly to Release 1.1.0. The installer itself downloads the
manifest and both packages into private, size-limited temporary files and
verifies their pinned SHA-256 values before the first package-manager write.
Compared with the previous longer bootstrap, this shorter form trusts HTTPS
and the selected GitHub URL for the installer script itself; the manifest and
package checksum verification remains unchanged.

The installer is pinned to
[Release 1.1.0](https://github.com/communism420/luci-app-videoplayer/releases/tag/1.1.0)
and supports both package generations in that release:

- OpenWrt `25.12.5` revision `r33051-f5dae5ece4` with `apk`;
- OpenWrt `24.10.8` revision `r29233-443ec4032a` with `opkg`.

It reads the exact package ABI from `DISTRIB_ARCH` in `/etc/openwrt_release`
and corroborates it with the package database before any download:
the primary `/etc/apk/arch` entry for APK, or one unique positive-priority
entry from `opkg print-architecture` for IPK. It deliberately does not infer
the package ABI from `uname -m` or normalize architecture aliases, because
OpenWrt distinguishes optimized ABIs such as `aarch64_cortex-a53` from generic
CPU-family names. The installer then downloads the release's pinned 71-entry
codec manifest, verifies that manifest against a
checksum embedded in the installer, and requires one exact release/revision/
format/architecture match. It then downloads and verifies both the
architecture-independent 1.1.0 application package and the matching
6.1.4-r5 codec package before changing the router. The maintenance-capable
application is installed first; only after that succeeds is the private codec
runtime installed. The final step validates package registration, root-owned
runtime metadata, executable safety, the native relay, and the renderer's exact
software-only attestation.

The application version `1.1.0` was also used by historical builds and is lower
than a previously tested `1.2.0` source package. The installer therefore uses
APK force-reinstall or IPK force-downgrade plus force-reinstall semantics rather
than relying on normal version ordering. It refuses an already-installed APK
when the router's `apk` implementation cannot perform a safe force-reinstall.
The released APKs are unsigned and are installed with `--allow-untrusted`.
Metadata, application, and codec downloads have separate bounded size limits
to protect the router's RAM-backed `/tmp` filesystem. If application
installation fails, the codec is not changed. If codec installation or final
attestation fails, the command returns an error and Browser mode remains the
recovery path.

### Current `main` APK (OpenWrt 25.12.5)

To install the newest successfully tested `main` source instead of the fixed
Release 1.1.0 package set, use the separate APK-only installer:

```sh
sh <(wget -O - https://raw.githubusercontent.com/communism420/luci-app-videoplayer/refs/heads/main/scripts/install-main-apk.sh)
```

This command uses the same compact OpenWrt `ash` process-substitution format
and follows the current `main` branch rather than the fixed release asset.

After every successful package-check run for a push to `main`, GitHub Actions
rebuilds the current source package and publishes the architecture-scoped
`dist/` index, packages, SHA-256 values, and exact source commit to the
generated `snapshot` branch. The installer resolves that branch immutably,
matches the router's exact release, revision, and `DISTRIB_ARCH`, validates the
native APK package ABI, indexed path, and checksum, and confirms that the
source commit still equals
the current head of `main`. The installer checks the head of `main` again
immediately before replacing the application package. Only after the verified
1.1.0 maintenance helper is installed does it install or update the matching
architecture-specific private FFmpeg runtime. This ordering safely migrates
legacy helpers and prevents the r5 codec package from being changed outside a
strict maintenance transaction. It refuses to proceed while a newer push is
still being checked or if application verification fails. This path supports only `apk`; use
the 1.1.0 application-plus-r5 local IPK procedure under
**Installing a Prebuilt Local Package** on OpenWrt versions that still use
`opkg`. The published-release installer above supports both APK and IPK routers
for the exact releases and revisions in Release 1.1.0.
The current snapshot targets the exact OpenWrt 25.12.5 revision listed below
and force-reinstalls the application when a newer snapshot still has the same
package version, `1.1.0`. Because that number is also used by older builds and
is lower than a previously tested source package, the installer
performs an explicit replacement instead of relying on ordinary version
ordering.

### Architecture-specific Codec Runtime (APK or IPK)

The generated codec package version is **6.1.4-r5**. The current matrix covers:

- OpenWrt `25.12.5` revision `r33051-f5dae5ece4`: 35 APK architectures;
- OpenWrt `24.10.8` revision `r29233-443ec4032a`: 36 IPK architectures;
- 37 unique `DISTRIB_ARCH` folders and 71 codec packages in total.

Your ASUS RT-AX52 reports `aarch64_cortex-a53` and therefore selects that
folder. Other AArch64 routers may report `aarch64_cortex-a72`,
`aarch64_cortex-a76`, or `aarch64_generic`; those are separate ABI folders
with separately compiled codec binaries.

Both the Release 1.1.0 installer and the current-`main` installer perform this
FFmpeg installation after installing the maintenance-capable application. To
install, update, or verify only the codec runtime independently, run:

```sh
(
	set -e
	installer="$(mktemp /tmp/install-videoplayer-codecs.XXXXXX)"
	trap 'rm -f "$installer"' 0
	trap 'exit 129' 1
	trap 'exit 130' 2
	trap 'exit 143' 15
	(
		ulimit -f 1024
		wget -O "$installer" 'https://raw.githubusercontent.com/communism420/luci-app-videoplayer/main/scripts/install-codec-runtime.sh'
	)
	sh "$installer"
)
```

The installer detects `apk` or `opkg`, reads `DISTRIB_RELEASE`,
`DISTRIB_REVISION`, and `DISTRIB_ARCH`, corroborates the native package ABI
with `/etc/apk/arch` or `opkg print-architecture`, and selects exactly one
entry from the
immutable `codec-snapshot` index. It rejects malformed metadata, unknown
architectures, mismatched revisions, duplicate entries, unexpected paths, and
checksum failures before installation. It compares the installed and published
package versions: a missing or older runtime is installed, a matching current
or newer runtime with compatible build metadata is kept, and a current-version
runtime with missing or incompatible metadata is reinstalled from the verified
package. It then confirms the exact native software video-decoder allowlist
(H.263, H.264, HEVC, VC-1, MPEG-4, VP8, VP9, AV1, and MJPEG), the exact audio-decoder
allowlist, the two permitted encoders, an empty hardware-accelerator report,
and every component required by the continuous MJPEG and PCM renderers.

Each runtime is built from a checksum-pinned official OpenWrt SDK with
`CONFIG_BUILD_PATENTED=y`. QEMU-compatible architectures are executed under
their matching user emulator for H.264-to-multipart-MJPEG and AAC-to-PCM smoke
tests.
The `mipsel_74kc` runtime uses QEMU's explicit `74Kf` CPU model so the
validation environment matches the generated instruction set.
The Octeon and embedded PowerPC ABIs receive static ELF, linkage,
configuration, component, and package validation because QEMU user mode cannot
faithfully execute those CPU-specific userspace ABIs. `armeb_xscale` receives
the same static validation because QEMU's big-endian ARM user emulation has a
known VDSO `SIGSEGV`
([QEMU issue #2333](https://gitlab.com/qemu-project/qemu/-/issues/2333)).
Availability of a package is not a promise of literally every existing or
future codec.
DRM, encryption, damaged media, unsupported formats, available flash and RAM,
CPU performance, heat, and storage throughput can still prevent playback.

## Building and Verifying Packages Locally

Python 3.10 or newer is sufficient to build the application packages and the
architecture-scoped layout:

```sh
python scripts/build-dist.py
python scripts/verify-dist.py
```

The layout builder creates 37 top-level architecture folders and 71
release-qualified package-set directories. It builds the architecture-neutral
application once, verifies it, and places byte-identical APK or IPK copies in
every compatible directory. Without a validated codec artifact source it
writes an explicit `CODEC_NOT_BUILT.txt` marker; it never copies an
incompatible binary into a folder.

To require the complete codec matrix from a shallow checkout of the generated
`codec-snapshot` branch:

```sh
git clone --depth 1 --branch codec-snapshot \
  https://github.com/communism420/luci-app-videoplayer.git \
  /path/to/codec-snapshot
python scripts/build-dist.py \
  --codec-source /path/to/codec-snapshot/dist \
  --require-codecs
python scripts/verify-dist.py --require-codecs
```

The builder uses `SOURCE_DATE_EPOCH` (default: `0`), so identical application
sources produce byte-for-byte identical packages. When it records the current
`HEAD` automatically, it refuses a dirty worktree so that `SOURCE_COMMIT`
cannot claim false provenance. A supplied codec tree must also contain the
same `SOURCE_COMMIT`; stale codec binaries cannot be relabeled as a newer
source build. Example in PowerShell:

```powershell
$env:SOURCE_DATE_EPOCH = '1767225600'
python scripts/build-dist.py
python scripts/verify-dist.py
```

The low-level application-only builder remains available for development:

```sh
python scripts/build-packages.py --check-reproducible
python scripts/build-packages.py --verify-only
```

It writes to `.staging/app/`, not to the organized `dist/` tree.

The resulting full layout is:

```text
dist/
├── INDEX.json
├── INDEX.tsv
├── SOURCE_COMMIT
├── aarch64_cortex-a53/
│   ├── openwrt-25.12.5-r33051-f5dae5ece4/
│   │   ├── luci-app-videoplayer-1.1.0.apk
│   │   └── luci-videoplayer-codec-runtime-6.1.4-r5.apk
│   └── openwrt-24.10.8-r29233-443ec4032a/
│       ├── luci-app-videoplayer_1.1.0_all.ipk
│       └── luci-videoplayer-codec-runtime_6.1.4-r5_aarch64_cortex-a53.ipk
├── aarch64_cortex-a72/
├── …
└── x86_64/
```

The IPK uses the gzip-compressed GNU tar format expected by OpenWrt 24.10.
`Installed-Size` is calculated in the same way as by the standard
`ipkg-build` script. The locally built APK is unsigned and intended for
development and testing. For an official package repository, use the official
OpenWrt SDK/Buildroot and signing infrastructure.

To display the correct folder key on a router:

```sh
. /etc/openwrt_release
printf '%s\n' "$DISTRIB_ARCH"
```

## Installing a Prebuilt Local Package

OpenWrt 25.12.5 on `aarch64_cortex-a53`:

```sh
scp -O \
  dist/aarch64_cortex-a53/openwrt-25.12.5-r33051-f5dae5ece4/luci-app-videoplayer-1.1.0.apk \
  dist/aarch64_cortex-a53/openwrt-25.12.5-r33051-f5dae5ece4/luci-videoplayer-codec-runtime-6.1.4-r5.apk \
  root@192.168.1.1:/tmp/
ssh root@192.168.1.1
apk add --allow-untrusted --force-reinstall /tmp/luci-app-videoplayer-1.1.0.apk
apk add --allow-untrusted /tmp/luci-videoplayer-codec-runtime-6.1.4-r5.apk
```

OpenWrt 24.10.8 on `aarch64_cortex-a53`:

```sh
scp -O \
  dist/aarch64_cortex-a53/openwrt-24.10.8-r29233-443ec4032a/luci-app-videoplayer_1.1.0_all.ipk \
  dist/aarch64_cortex-a53/openwrt-24.10.8-r29233-443ec4032a/luci-videoplayer-codec-runtime_6.1.4-r5_aarch64_cortex-a53.ipk \
  root@192.168.1.1:/tmp/
ssh root@192.168.1.1
opkg --force-downgrade --force-reinstall install /tmp/luci-app-videoplayer_1.1.0_all.ipk
opkg install /tmp/luci-videoplayer-codec-runtime_6.1.4-r5_aarch64_cortex-a53.ipk
```

Keep this order when replacing an existing installation: the current 1.1.0
application installs the maintenance-capable helper first, then the r5 codec
package replaces the private FFmpeg while that helper holds the strict
maintenance gate.

If your `scp` implementation does not support `-O`, omit that option. After
installation, sign out of LuCI and sign in again if the new menu item does not
appear.

The numeric version `1.1.0` is shared with historical builds that do not have
the strict maintenance helper, and it is lower than a previously tested source
package. Use the forced replacement commands above (or remove the
old application package first); an ordinary install may retain the wrong build.

Direct URL:
`http://<router-ip>/cgi-bin/luci/admin/services/videoplayer`.

## Building in the Official OpenWrt Tree

```sh
cp -a luci-app-videoplayer feeds/luci/applications/
./scripts/feeds install luci-app-videoplayer
make menuconfig
make package/luci-app-videoplayer/compile V=s
```

The package is listed under **LuCI → Applications**. Its canonical project URL
is configured in `luci-app-videoplayer/Makefile`; set a specific maintainer
contact there before submitting it to an official package feed. The ordinary
OpenWrt package hook intentionally refuses a direct replacement from a legacy
helper without strict maintenance because it cannot close that helper's startup
race. Run the current verified standalone 1.1.0 package once to perform that
migration, after which normal package upgrades use the strict maintenance
protocol.

## Manual Installation over SSH for Development

```sh
chmod +x scripts/install-to-router.sh
./scripts/install-to-router.sh root@192.168.1.1
```

The script first uploads files to a temporary directory and then replaces the
installed files atomically. An existing `/etc/config/videoplayer` is preserved;
missing UCI options are added separately. The script tries `scp -O` first and
then falls back to regular `scp`. This development installer does not install
package dependencies. FFmpeg is optional for browser mode; router CPU mode
requires the attested private codec runtime described above. A system FFmpeg is
never accepted for Router mode. Before replacing or removing the renderer
helper, the script requires the strict maintenance acknowledgement, quiesces
the session, and preserves the global lock inodes. Renderer startup resumes
only after the new helper revalidates the maintenance state; removal leaves the
durable gate active. A legacy helper must first be migrated by the current
verified standalone 1.1.0 package.

To remove only the program files installed manually:

```sh
./scripts/install-to-router.sh --uninstall root@192.168.1.1
```

The configuration and media library are preserved.

## UCI Configuration

Contents of `/etc/config/videoplayer`:

```text
config videoplayer 'main'
	option enabled '1'
	option media_path '/mnt/video'
	option allow_remote '1'
	option render_mode 'browser'
	option router_profile 'fast'
	option router_fps '8'
	option max_depth '8'
```

| Option | Description |
|---|---|
| `enabled` | Enable or disable the streamer |
| `media_path` | Root directory of the local media library |
| `allow_remote` | Show the remote URL field in the interface |
| `render_mode` | Local playback mode: `browser` or `router`; unknown values safely fall back to `browser` |
| `router_profile` | Router CPU profile: `fast` (default, 480×270 JPEG q12 with decoder speed optimizations and an 8 FPS cap) or `quality` (640×360 JPEG q8); unknown values safely fall back to `fast` |
| `router_fps` | Router CPU output frame rate: `5`, `8` (default), `12`, `15`, `20`, `24`, `30`, `48`, `50`, or `60` (maximum); Fast accepts 5 or 8 and clamps stale higher values to 8, while Quality permits the full list |
| `max_depth` | Maximum traversal depth for nested directories |

The LuCI page uses the standard OpenWrt configuration footer. **Save** stages
the edited values as pending UCI changes, **Save & Apply** activates them using
LuCI's normal checked-apply and rollback flow, and **Reset** discards only form
edits that have not yet been saved.

The `uci-defaults` script is idempotent: it restores a missing section and adds
only missing options without overwriting user-defined values.
`/etc/config/videoplayer` is declared as a conffile, so the package manager
treats it as user configuration during upgrades.

## Removing the Package

```sh
# OpenWrt with apk
apk del luci-app-videoplayer
apk del luci-videoplayer-codec-runtime

# OpenWrt with opkg
opkg remove luci-app-videoplayer
opkg remove luci-videoplayer-codec-runtime
```

Removing only `luci-videoplayer-codec-runtime` makes strict Router mode
unavailable and does not remove the LuCI application, its configuration, or any
videos. Browser mode remains usable.

The post-removal script clears LuCI caches and stream tokens, then reloads rpcd.
The renderer maintenance marker and its two global lock files deliberately
survive application removal so a stale command cannot reopen a different lock
inode. A later verified installation consumes that marker and resumes playback
only after its new helper is validated. Videos are never deleted. How the
configuration file is handled during removal depends on the package manager and
whether the file has been modified.

## Limitations and Security

- This is a web interface, not a hardware HDMI player.
- Browser mode codec support depends on the client browser.
- Router CPU mode is experimental. The default Fast profile renders 480×270
  JPEG q12, uses safe decoder shortcuts, and caps output at 8 FPS; 5 FPS reduces
  load further. The Quality profile preserves the 640×360 JPEG q8 path and
  permits 5, 8, 12, 15, 20, 24, 30, 48, 50, or 60 FPS. Higher settings
  progressively increase CPU and network load, and 60 FPS may overload even
  fast routers. Rendering can still be slower than media
  time; initial buffering then takes longer and playback pauses to refill
  instead of changing audio speed or pitch. The continuous MJPEG transport
  removes per-frame HTTP requests, but the browser still parses and stores
  every retained JPEG, then decodes the frames selected for presentation. It
  cannot make an underpowered CPU encode 60
  frames per second. Selecting a rate above the source video's frame rate
  duplicates frames; it does not perform motion interpolation.
- In browsers with streaming `fetch()` support, router CPU audio primarily uses
  signed 16-bit stereo PCM decoded at 48 kHz by the same FFmpeg process that
  creates the MJPEG stream. LuCI requests sequential batches from chunk zero,
  stores them with the JPEG queue, and schedules them at their original 1× rate.
  PCM is the master media clock, and the canvas presents frames by media time.
  An underrun pauses both tracks instead of stopping, rebasing, or resampling
  short audio fragments. Browser autoplay policies may require pressing
  **Unmute** once.
- Router-decoded PCM uses one-second chunks and a bounded eight-second
  router-side staging ring rather
  than an unbounded cache. It is not the playback buffer: LuCI continuously
  drains it into the bounded client-side buffer while the one FFmpeg producer
  creates video and audio from the same input timeline. Each validated batch
  request acknowledges only earlier PCM chunks; a full ring backpressures the
  shared FFmpeg process instead of overwriting sound that the browser has not
  received. Numeric requests fetch at most two chunks (384 KiB), avoid rescanning
  the whole ring while waiting for a complete batch, and LuCI backs off repeated
  empty polls from 50 ms to an interval of one second.
  A short authenticated lock-busy response is retried for a bounded interval
  instead of aborting the entire CPU-rendered session. A true video-only source
  plays silently. If the source advertises audio and the private software
  decoder, PCM producer, transport, Web Audio queue, or synchronization path
  fails, the strict session stops with a classified error. The application does
  not open the original track in a hidden media element and does not acknowledge
  data it cannot prove was safely received.
- Video is authoritative when source track lengths differ. A shorter audio
  track is padded with silence and longer audio is cut at video EOF inside the
  unified FFmpeg output, preventing a full PCM ring from keeping a completed
  video session alive. The two stream-selective demux contexts read container
  metadata and packets independently, but only one video and one audio stream
  are decoded; this trades some storage I/O for deterministic track-length
  handling without a second renderer process.
- Router CPU mode has no user-controlled pause or seeking. Separate
  **Rendered time**, **Played time**, **Router output speed**, and **Buffered
  ahead** counters distinguish end-to-end router-output arrival throughput from
  the fixed 1× playback clock. The speed value is not presented as a pure
  FFmpeg benchmark or a measurement of browser presentation cost.
  The two time counters show elapsed media time against
  advisory container duration while rendering; the total is shown as `?` when
  the container does not report one. Container metadata never shortens the
  two-minute start gate or ends playback. After a clean renderer EOF, LuCI
  replaces the denominator with the actual received video timeline. Audio
  remains at its original rate while
  playing. LuCI reconnects the producer stream only at clean frame-aligned CGI
  handoffs and keeps the last canvas image during handoff or refill. Every
  nonterminal response closes after the first of 45 seconds of wall time, 20
  seconds of configured video frames (capped at 300 frames), or 16 MiB of
  complete JPEG payload (with
  room for at most one final 4 MiB frame). An active response is always drained
  to that validated frame boundary; high-water backpressure delays only
  its successor, so a hidden tab cannot leave uHTTPd holding an unread body.
- A fatal error inside the shared FFmpeg producer ends both router video and
  PCM even when startup probes succeeded. Renderer attestation, startup,
  transport, parsing, buffering, canvas, PCM, or shared decoder/filter failures
  are fail-closed: the UI stops playback, preserves the selected Router mode,
  and explains that the user may explicitly switch to Browser mode. It never
  guesses a synchronization point or silently changes the source-decoding path.
- Router CPU mode can cause high CPU use, heat, stutter, and temporary LuCI
  slowdown. Reducing the output frame rate does not prevent FFmpeg from
  decoding the source stream, so high-resolution media may still overwhelm a
  low-powered router.
- The source file is read incrementally through a validated file descriptor;
  it is not copied wholesale into router RAM. FFmpeg still needs working memory
  for compressed packets, decoded frames, reference frames, scaling, and JPEG
  output. The router uses bounded pipes and PCM staging, while the browser
  intentionally keeps a bounded prebuffer. Two minutes of 48 kHz stereo PCM is
  23,040,000 bytes (about 22 MiB), and JPEG frames can require tens or hundreds
  of additional MiB at high FPS. The player enforces a combined browser-buffer
  byte limit and reports an error instead of allowing unbounded growth.
- No player can guarantee every existing or future codec. Unsupported
  decoders, DRM, encryption, damaged files, CPU performance, available RAM,
  thermal limits, and storage throughput remain real constraints.
- The remote server must allow the browser to load the resource. CORS is
  required when the server or page policy enforces a CORS check; convenient
  seeking also requires HTTP Range support.
- Remote URLs are accepted only while Browser mode is active. Router mode
  rejects them and asks for an explicit mode change; passing them to FFmpeg
  would turn the router into an SSRF-capable network proxy, while silently
  browser-playing them would violate the selected strict-mode contract.
- Do not store sensitive files inside `media_path`.
- To protect memory on resource-constrained routers, each directory is limited
  to 5,000 entries and 1 MiB of combined path data. Split larger libraries into
  subdirectories.
- Access LuCI only from a trusted LAN or through a VPN. Do not expose it
  directly to the internet.
- Transferring large files over Wi-Fi may be slow on a low-powered SoC.

## Verification

`scripts/verify_packages.py` parses IPK and APK files without relying on
`assert` and validates metadata, dependencies, conffiles, lifecycle scripts,
permissions, timestamps, the 20-byte SHA-256 prefix in the APK UID, and the
exact payload contents. The builder also rejects metadata drift against the
verifier and checks its version, release suffix, and dependencies against the
OpenWrt Makefile. The CI workflow checks and lints all shipped scripts,
exercises browser extension filtering and extensionless CPU media discovery,
exercises successful renderer and PCM-audio lifecycle, validates the
strict private-runtime attestation, software-only decoder inventory, explicit
hardware-acceleration disablement, continuous multipart MJPEG framing,
single-viewer locking, heartbeat renewal,
minute-throttled lease tolerance, video-authoritative mismatched-track
termination and short-audio silence padding,
path-replacement resistance, bounded JPEG and sequential PCM prebuffering, the
120-second start gate and short-file EOF exception, persistent-canvas media-time
presentation, fixed-rate audio, joint underrun/refill, progress counters,
autoplay recovery, stale asynchronous cleanup, strict rejection of every
automatic browser/original-audio fallback, and renderer cleanup. It also checks
modern and legacy missing-decoder diagnostics, rejects V4L2 and other hardware
decoder wrappers, bounds noisy logs and unknown FFmpeg failures with isolated
fake processes, and builds and verifies both packages. After
those checks pass on `main`, a separate job
with narrowly scoped repository write access rebuilds the architecture-scoped
application layout and updates the generated `snapshot` branch. It never
uploads files to a router or changes GitHub Releases.

`scripts/codec_matrix.py` validates the exact 37-folder, 71-build inventory.
`scripts/verify-dist.py` rejects missing or extra architecture folders,
non-identical application copies, unsafe links, stale files, malformed
metadata, checksum drift, codec package metadata or ELF architecture drift,
and incomplete codec coverage.

The separate codec-runtime workflow downloads all checksum-pinned official
OpenWrt SDKs, pins each release's packages-feed commit, applies that feed's
FFmpeg patches, and cross-compiles 35 private APK packages plus 36 private IPK
packages. Every packaged FFmpeg binary and frame-aligned relay is checked for
an isolated payload and target `libc` as its only dynamic dependency. The final
packaged relay is also exercised under the matching QEMU user emulator, while
FFmpeg is tested for H.264-to-multipart-MJPEG and AAC-to-PCM output where that
ISA is faithfully supported. Octeon and embedded PowerPC use the strict static
validation path described above. Pushes and pull requests use the eight-entry
smoke matrix; the complete matrix is an explicit manual run. The validated tree
is published atomically to the generated `codec-snapshot` branch only after all
71 jobs succeed.

## Repository Structure

```text
openwrt-video-player/
├── .github/workflows/
│   ├── codec-runtime.yml
│   └── package-check.yml
├── README.md
├── LICENSE
├── codec-runtime/
│   ├── README.md
│   ├── matrix.json
│   ├── validate-runtime.sh
│   └── package/
├── tests/
│   ├── app-lifecycle.sh
│   ├── codec-attestation.py
│   ├── installer-entrypoints.sh
│   ├── local-listing.sh
│   ├── renderer-behavior.sh
│   └── web-audio.js
├── scripts/
│   ├── build-dist.py
│   ├── build-packages.py
│   ├── codec_matrix.py
│   ├── install-codec-runtime.sh
│   ├── install-from-github.sh
│   ├── install-main-apk.sh
│   ├── install-to-router.sh
│   ├── release-1.1.0-codecs.tsv
│   ├── verify_codec_package.py
│   ├── verify-dist.py
│   └── verify_packages.py
└── luci-app-videoplayer/
    ├── Makefile
    ├── htdocs/luci-static/resources/view/videoplayer/main.js
    └── root/
        ├── etc/config/videoplayer
        ├── etc/uci-defaults/80_luci-videoplayer
        ├── usr/libexec/rpcd/luci.videoplayer
        ├── usr/libexec/videoplayer-renderer
        ├── usr/share/luci/menu.d/…
        ├── usr/share/rpcd/acl.d/…
        ├── www/cgi-bin/videoplayer-stream
        ├── www/cgi-bin/videoplayer-frame
        └── www/cgi-bin/videoplayer-audio
```

## License

[GPL-2.0-or-later](LICENSE).
