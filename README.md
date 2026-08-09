# luci-app-videoplayer

A joke but functional video player for **OpenWrt**, integrated into **LuCI**.
Local videos can either be decoded normally by the client browser or decoded
by the router CPU with FFmpeg and delivered as a continuous MJPEG stream.
In router mode, a fetch-capable browser first builds a bounded client-side
buffer containing at least 120 seconds of router-rendered JPEG frames and
router-decoded PCM audio, or the complete stream when it is shorter. It then
draws frames on a persistent canvas while PCM plays at its original speed.
Audio is the playback clock; if the buffer runs dry, sound and picture pause
together while it refills. The original browser-decoded audio track remains an
automatic fallback. Playback stays inside the LuCI web interface and does not
use HDMI or a framebuffer.

Current source package version: **1.1.0**. The latest published GitHub release
is still **1.0.0**. The release installer below remains pinned to that release,
while a separate APK-only installer follows the latest successfully tested
`main` source.

## Features

| Mode | How it works |
|---|---|
| Browser decoding | Browse local storage and stream the original file to the HTML5 `<video>` element with HTTP Range support |
| Router CPU rendering | After bounded media and audio probes, one long-lived FFmpeg producer scales and MJPEG-encodes video at selectable targets from 5 to 60 FPS and decodes PCM from the same input clock; fetch-capable browsers prebuffer at least 120 seconds (or the complete shorter stream), draw JPEG frames on a persistent canvas against fixed-rate PCM audio, and pause both tracks together on underrun |
| Remote URLs | Play `http://` and `https://` URLs directly in the browser; remote URLs are never fetched by FFmpeg on the router |
| Interface | **Services → Video Player** page in LuCI |

The local browser recognizes common containers and raw streams, including
MP4/M4V/MOV, WebM, MKV, AVI/DivX, Ogg, MPEG/VOB, MPEG-TS/M2TS/MTS, FLV/F4V,
WMV/ASF, 3GP/3G2, RealMedia, and raw H.264/H.265 files. Extension matching is
case-insensitive. MP4 with H.264 video and AAC audio offers the broadest
client-browser compatibility. Router CPU mode depends on the decoders enabled
in the installed OpenWrt FFmpeg build, so it may support a different subset.
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
    └── Router mode ─── one long-lived FFmpeg producer
                         ├── MJPEG FIFO → /cgi-bin/videoplayer-frame?token=…
                         │                 └── browser JPEG buffer → canvas
                         ├── PCM FIFO/ring → /cgi-bin/videoplayer-audio
                         │                  ?token=…&chunk=…&count=…
                         │                  └── browser PCM buffer → Web Audio 1×
                         ├── original descriptor → /cgi-bin/videoplayer-stream
                         │    ?renderer=…&audio=… (hidden <audio> fallback)
                         └── full browser decoding if router video cannot start

UCI videoplayer.main.media_path ── root of the accessible media library
```

LuCI calls ACL-protected backend methods. Browser resolution and renderer
status require read permission; starting or stopping the CPU renderer requires
write permission. The unrestricted regular-file listing used only by CPU mode
and the browser-audio capability resolver also require write permission; the
read-only `list` method retains the video extension allowlist. Browser-audio
resolution accepts only the canonical source of the current active renderer
session, so the client cannot exchange an arbitrary path for an unrestricted
stream. It creates a second random nonce that is distinct from and bound to the
active renderer token; possession of the MJPEG token alone cannot open the
original file. The CGI reopens the source descriptor already held by the live
renderer and verifies its device, inode, and size before serving it. Stop,
expiry, worker failure, or session replacement invalidates new audio requests.
Read-only LuCI accounts automatically fall back to full browser decoding.

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
after the first of 45 wall-clock seconds, five seconds of configured video
frames, or 16 MiB of complete JPEG payload, always between frames, then LuCI
opens the next segment when its bounded buffer has capacity. This is one
request per segment rather than one request per frame. The frame sequence is
global across those segments, so reconnect wall time is not added to media
time. The relay validates a complete bounded JPEG before publishing it. Any
ambiguous HTTP interruption after dispatch falls back the whole playback
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
threads to bound memory on embedded targets. Filtering and MJPEG encoding use
one thread on a single-core router and at most two elsewhere. FFmpeg remains at
reduced scheduler priority so it yields to LuCI and network traffic under load,
but no input pacing option limits how quickly it can use otherwise idle CPU.
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
tracks pause on the last complete position and resume only after a refill. If
the PCM path is unavailable, LuCI requests a session-bound browser-audio
capability and uses the renderer's already-open original-file descriptor as a
reduced-guarantee audio fallback. Browsers without the streaming and canvas
features required by this mode fall back to normal browser decoding instead of
using an unsynchronized native MJPEG image. The session renews a 90-second
inactivity lease while rendering, buffering, or playback is active. This
tolerates minute-level timer throttling in a background browser tab. Closing
the page or losing the client stops the sole allowed renderer after that
bounded delay, and every session also has an absolute six-hour expiry.
After a clean terminal drain, the worker releases FFmpeg, FIFO, ring, relay,
and log resources but temporarily retains the validated original-file
descriptor for later protected browser-audio Range requests. Authenticated
status polling renews this minimal source-holder lease while buffered playback
continues; **Stop**, replacement by another session, 90 seconds without a
heartbeat, or the absolute expiry releases it.

## Requirements

The package directly depends on `luci-base`, `uhttpd`, `jshn`,
`coreutils-stat`, and `coreutils-timeout`. FFmpeg is optional: browser mode
works without it, while router CPU mode uses the private compatible codec
runtime when installed and otherwise tries a compatible system `ffmpeg`.
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
enabling the corresponding router output. If only the PCM path is unavailable,
video can remain router-rendered while the browser attempts to decode the
original audio track.

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
the relay fails its root-owned filesystem safety check. The package does not overwrite
`/usr/bin/ffmpeg` or install global `libav*.so` files. The renderer prefers the
private executable when it is present and passes all capability and filesystem
safety checks, then falls back to the normal system FFmpeg if it is absent or
unusable.

The codec build matrix covers every package ABI published for the current
official OpenWrt stable and old-stable releases: 35 APK architectures for
OpenWrt 25.12.5 and 36 IPK architectures for OpenWrt 24.10.8, producing 37
unique `DISTRIB_ARCH` folders and 71 separately compiled codec packages. The
folder key is the exact OpenWrt package ABI, not a marketing CPU name or the
broader value returned by `uname -m`.

If the player reports that the installed FFmpeg has no usable decoder for a
video, inspect the installed decoder list:

```sh
ffmpeg -hide_banner -decoders 2>/dev/null | grep -E 'h264|hevc|vc1'
```

A plain decoder entry such as `h264` is the native software decoder. If it is
listed but playback still fails, the player now reports a bounded, sanitized
FFmpeg diagnostic that can be used to identify the separate failure. An entry
such as `h264_v4l2m2m` is only a hardware wrapper: it works only with a
compatible and accessible V4L2 device and does not replace the native software
decoder. If only the wrapper is listed, use browser mode or install an FFmpeg
build with the native decoder for the router's exact OpenWrt release and
architecture. If neither entry is listed, a decoder-enabled FFmpeg build is
also required.

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
(set -eu; installer="$(mktemp /tmp/install-videoplayer.XXXXXX)"; trap 'rm -f "$installer"' 0; trap 'exit 129' HUP; trap 'exit 130' INT; trap 'exit 143' TERM; (ulimit -f 1024; wget -O "$installer" 'https://raw.githubusercontent.com/communism420/luci-app-videoplayer/main/scripts/install-from-github.sh'); [ -s "$installer" ]; sh "$installer")
```

This one-line bootstrap downloads the complete installer into a private,
size-limited temporary file before executing it and removes that file on exit.
It deliberately does not pipe partially downloaded network content into a
shell.

The installer currently installs the latest published release, not the newer
1.1.0 source tree. Before changing the application package, it downloads and
SHA-256-verifies the architecture-specific FFmpeg installer. That installer
selects the private runtime for the router's exact OpenWrt release, revision,
package manager, and `DISTRIB_ARCH`. It installs a missing runtime, attempts a
normal in-place update when one is already installed, and treats an
already-current package as success before continuing without downloading the
large FFmpeg package again. Because the package version intentionally remains
`6.1.4-r3`, its checksum-verified build metadata also carries the
`buffered-tee-v1` renderer profile. An older same-version runtime without that
profile is downloaded and force-reinstalled, which repairs pre-unified builds
without changing either application or codec package version. The release
installer then detects whether the
router uses `apk` or `opkg`, downloads the matching
1.0.0 package from
[Release 1.0.0](https://github.com/communism420/luci-app-videoplayer/releases/tag/1.0.0),
verifies its pinned SHA-256 checksum, attempts to refresh the package indexes,
and installs the package. The released APK is unsigned, so installation on
OpenWrt 25.12+ uses `apk add --allow-untrusted`. Downloads are size-limited to
protect the router's RAM-backed `/tmp` filesystem.

Because the FFmpeg step is mandatory, the release installer now requires an
exact codec-matrix entry. At present that means OpenWrt 25.12.5
`r33051-f5dae5ece4` or OpenWrt 24.10.8 `r29233-443ec4032a`; an unsupported
release, revision, or architecture is rejected before the application package
is changed. Release 1.0.0 itself remains browser-only, so it prepares the
private runtime for a later 1.1.0 installation but does not use router CPU
rendering.

### Current `main` APK (OpenWrt 25.12.5)

To install the newest successfully tested `main` source instead of Release
1.0.0, use the separate APK-only installer:

```sh
(set -eu; installer="$(mktemp /tmp/install-videoplayer-main.XXXXXX)"; trap 'rm -f "$installer"' 0; trap 'exit 129' HUP; trap 'exit 130' INT; trap 'exit 143' TERM; (ulimit -f 1024; wget -O "$installer" 'https://raw.githubusercontent.com/communism420/luci-app-videoplayer/main/scripts/install-main-apk.sh'); [ -s "$installer" ]; sh "$installer")
```

This command uses the same download-first, size-limited bootstrap described
above.

After every successful package-check run for a push to `main`, GitHub Actions
rebuilds the current source package and publishes the architecture-scoped
`dist/` index, packages, SHA-256 values, and exact source commit to the
generated `snapshot` branch. The installer resolves that branch immutably,
matches the router's exact release, revision, and `DISTRIB_ARCH`, validates the
indexed path and checksum, and confirms that the source commit still equals
the current head of `main`. Before installing that verified application APK,
it also installs or checks for an update to the same exact
architecture-specific private FFmpeg runtime described below. An
already-current runtime does not stop the application installation. The
installer then checks the head of `main` again immediately before replacing
the application package. It refuses to proceed while a newer push is still
being checked or if any verification fails. This path supports only `apk`; use
the published-release installer above on OpenWrt versions that still use
`opkg`.
The current snapshot targets the exact OpenWrt 25.12.5 revision listed below
and force-reinstalls the application when a newer snapshot still has the same
package version, `1.1.0`.

### Architecture-specific Codec Runtime (APK or IPK)

The generated codec package version is **6.1.4-r3**. The current matrix covers:

- OpenWrt `25.12.5` revision `r33051-f5dae5ece4`: 35 APK architectures;
- OpenWrt `24.10.8` revision `r29233-443ec4032a`: 36 IPK architectures;
- 37 unique `DISTRIB_ARCH` folders and 71 codec packages in total.

Your ASUS RT-AX52 reports `aarch64_cortex-a53` and therefore selects that
folder. Other AArch64 routers may report `aarch64_cortex-a72`,
`aarch64_cortex-a76`, or `aarch64_generic`; those are separate ABI folders
with separately compiled codec binaries.

Both quick application installers above perform this FFmpeg installation or
update check automatically before changing the application package. To
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
`DISTRIB_REVISION`, and `DISTRIB_ARCH`, and selects exactly one entry from the
immutable `codec-snapshot` index. It rejects malformed metadata, unknown
architectures, mismatched revisions, duplicate entries, unexpected paths, and
checksum failures before installation. It compares the installed and published
package versions: a missing or older runtime is installed, a matching current
or newer runtime with compatible build metadata is kept, and a current-version
runtime with missing or incompatible metadata is reinstalled from the verified
package. It then confirms that the private runtime exposes the native H.264,
HEVC, and VC-1 decoders plus every component required by the continuous MJPEG
and PCM renderers.

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
│   │   └── luci-videoplayer-codec-runtime-6.1.4-r3.apk
│   └── openwrt-24.10.8-r29233-443ec4032a/
│       ├── luci-app-videoplayer_1.1.0_all.ipk
│       └── luci-videoplayer-codec-runtime_6.1.4-r3_aarch64_cortex-a53.ipk
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
  root@192.168.1.1:/tmp/
ssh root@192.168.1.1
apk add --allow-untrusted /tmp/luci-app-videoplayer-1.1.0.apk
```

OpenWrt 24.10.8 on `aarch64_cortex-a53`:

```sh
scp -O \
  dist/aarch64_cortex-a53/openwrt-24.10.8-r29233-443ec4032a/luci-app-videoplayer_1.1.0_all.ipk \
  root@192.168.1.1:/tmp/
ssh root@192.168.1.1
opkg install /tmp/luci-app-videoplayer_1.1.0_all.ipk
```

If your `scp` implementation does not support `-O`, omit that option. After
installation, sign out of LuCI and sign in again if the new menu item does not
appear.

Package managers may consider an older build with a release suffix newer than
this suffix-free `1.1.0` build. When replacing such an installation, explicitly
allow a downgrade or remove the old package before installing this one.

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
contact there before submitting it to an official package feed.

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
requires either the private codec runtime described above or a compatible
system FFmpeg.

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
	option router_fps '8'
	option max_depth '8'
```

| Option | Description |
|---|---|
| `enabled` | Enable or disable the streamer |
| `media_path` | Root directory of the local media library |
| `allow_remote` | Show the remote URL field in the interface |
| `render_mode` | Local playback mode: `browser` or `router`; unknown values safely fall back to `browser` |
| `router_fps` | Router CPU output frame rate: `5`, `8` (default), `12`, `15`, `20`, `24`, `30`, `48`, `50`, or `60` (maximum); higher rates also increase browser prebuffer memory and JPEG decoding work, and unknown values safely fall back to `8` |
| `max_depth` | Maximum traversal depth for nested directories |

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

Removing only `luci-videoplayer-codec-runtime` restores the normal system
FFmpeg fallback and does not remove the LuCI application, its configuration,
or any videos.

The post-removal script clears LuCI caches and temporary player state
(stream tokens, renderer sessions, and locks), then reloads rpcd. Videos are
never deleted. How the configuration file is handled during removal depends
on the package manager and whether the file has been modified.

## Limitations and Security

- This is a web interface, not a hardware HDMI player.
- Browser mode codec support depends on the client browser.
- Router CPU mode is experimental and capped at 640×360. Its frame rate is
  selectable at 5, 8, 12, 15, 20, 24, 30, 48, 50, or 60 FPS. The default is
  8 FPS; higher settings progressively increase CPU and network load, and
  60 FPS may overload even fast routers. Rendering can be slower than media
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
- Router-decoded PCM uses a bounded eight-second router-side staging ring rather
  than an unbounded cache. It is not the playback buffer: LuCI continuously
  drains it into the bounded client-side buffer while the one FFmpeg producer
  creates video and audio from the same input timeline. Each validated batch
  request acknowledges only earlier PCM chunks; a full ring backpressures the
  shared FFmpeg process instead of overwriting sound that the browser has not
  received. Numeric requests avoid rescanning the whole ring while waiting for
  a complete batch, and LuCI backs off repeated empty polls from 50 ms to an
  interval of 250 ms.
  A short authenticated lock-busy response is retried for a bounded interval
  instead of aborting the entire CPU-rendered session. If the backend explicitly
  reports that its PCM chunker is
  unavailable, or Web Audio fails after a safe discard drain has been
  established, the player attempts the protected original track in a hidden
  HTML media element at 1×. It keeps acknowledging discarded PCM batches when
  that transport is still trustworthy, so unused router audio cannot block
  video rendering. Persistent PCM HTTP/session loss cannot be acknowledged
  safely and falls back to complete browser playback. If neither audio path can
  decode the track, playback remains silent. For uncommon or extensionless
  containers, fallback audio support can still depend on browser sniffing.
- Video is authoritative when source track lengths differ. A shorter audio
  track is padded with silence and longer audio is cut at video EOF inside the
  unified FFmpeg output, preventing a full PCM ring from keeping a completed
  video session alive. The two stream-selective demux contexts read container
  metadata and packets independently, but only one video and one audio stream
  are decoded; this trades some storage I/O for deterministic track-length
  handling without a second renderer process.
- Router CPU mode has no user-controlled pause or seeking. Separate
  **Rendered time** and **Played time** counters show elapsed media time against
  advisory container duration while rendering; the total is shown as `?` when
  the container does not report one. Container metadata never shortens the
  two-minute start gate or ends playback. After a clean renderer EOF, LuCI
  replaces the denominator with the actual received video timeline. Audio
  remains at its original rate while
  playing. LuCI reconnects the producer stream only at clean frame-aligned CGI
  handoffs and keeps the last canvas image during handoff or refill. Every
  nonterminal response closes after the first of 45 seconds of wall time, five
  seconds of configured video frames, or 16 MiB of complete JPEG payload (with
  room for at most one final 4 MiB frame). An active response is always drained
  to that validated frame boundary; high-water backpressure delays only
  its successor, so a hidden tab cannot leave uHTTPd holding an unread body.
- A fatal error inside the shared FFmpeg producer can end both router video and
  PCM even when the one-frame audio probe succeeded. An authenticated backend
  `unavailable` state and recoverable Web Audio failures preserve router video
  and switch to protected browser audio. Ambiguous PCM transport/session loss,
  or a fatal shared decoder/filter failure, safely falls back the whole
  playback instead of guessing a synchronization point.
- If router-side FFmpeg cannot start for a local file, the UI reports the
  classified failure and automatically retries that file with browser
  decoding. Automatic browser fallback starts muted; audio can be enabled with
  the player control.
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
- Remote URLs deliberately remain browser-side in both modes. Passing them to
  router-side FFmpeg would turn the player into an SSRF-capable network proxy.
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
session-bound browser-audio nonce, stable source-descriptor Range streaming,
continuous multipart MJPEG framing, single-viewer locking, heartbeat renewal,
minute-throttled lease tolerance, video-authoritative mismatched-track
termination and short-audio silence padding,
path-replacement resistance, bounded JPEG and sequential PCM prebuffering, the
120-second start gate and short-file EOF exception, persistent-canvas media-time
presentation, fixed-rate audio, joint underrun/refill, progress counters,
browser-audio fallback, autoplay recovery, stale asynchronous cleanup, and
renderer cleanup, checks modern and legacy missing-decoder diagnostics,
unusable V4L2 hardware decoders, bounded noisy logs, and unknown FFmpeg failures
with isolated fake processes, and builds and verifies both packages. After
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
