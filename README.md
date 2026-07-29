# luci-app-videoplayer

A joke but functional video player for **OpenWrt**, integrated into **LuCI**.
Local videos can either be decoded normally by the client browser or decoded
by the router CPU with FFmpeg and delivered as JPEG frames plus PCM audio
chunks. In both cases, playback stays inside the LuCI web interface. The
application does not use HDMI or a framebuffer.

Current source package version: **1.1.0**. The latest published GitHub release
is still **1.0.0**. The release installer below remains pinned to that release,
while a separate APK-only installer follows the latest successfully tested
`main` source.

## Features

| Mode | How it works |
|---|---|
| Browser decoding | Browse local storage and stream the original file to the HTML5 `<video>` element with HTTP Range support |
| Router CPU rendering | FFmpeg decodes a local file on the router and publishes JPEG frames at a selectable 5, 8, or 12 FPS plus PCM audio for the browser Web Audio API |
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
    └── Router mode ─── FFmpeg workers ── JPEG frames + PCM chunks in /tmp
                         ├── /cgi-bin/videoplayer-frame?token=…
                         └── /cgi-bin/videoplayer-audio?token=…&chunk=…

UCI videoplayer.main.media_path ── root of the accessible media library
```

LuCI calls ACL-protected backend methods. Browser resolution and renderer
status require read permission; starting or stopping the CPU renderer requires
write permission. The unrestricted regular-file listing used only by CPU mode
also requires write permission; the read-only `list` method retains the video
extension allowlist. Read-only LuCI accounts automatically fall back to browser
decoding. The backend validates the path and issues a short-lived opaque token.
The CGI endpoint accepts only this token, never a file path supplied by the
browser. Tokens are stored in 4,096 fixed bucket slots, preventing their count
and lookup cost from growing without bound. If a random collision selects a
slot containing an unexpired token, the backend chooses another slot instead
of overwriting it.

Router CPU mode has a separate single-session runtime. Only one CPU-rendering
session may run at a time, and selecting another local video replaces the
previous session. Each session uses its own random token directory under
`/tmp`; video frames are written with FFmpeg's atomic image update mode and
audio is divided into bounded raw PCM chunks. The UI renews a short heartbeat
while it is receiving media. Closing the page or losing the client stops CPU
work after the heartbeat timeout, and every session also has an absolute
expiry.

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
FFmpeg build containing the native MJPEG encoder, the `image2` muxer, and the
`fps`, `scale`, and `format` filters. Audio additionally requires the
`pcm_s16le` encoder, the `s16le` muxer, and the `aresample`, `aformat`, and
`asetnsamples` filters. The UI checks these capabilities before enabling the
corresponding CPU-rendered output.

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
it installs one private executable at
`/usr/libexec/videoplayer-ffmpeg/ffmpeg`. It does not overwrite
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
(
	set -e
	installer="$(mktemp /tmp/install-videoplayer.XXXXXX)"
	trap 'rm -f "$installer"' 0
	trap 'exit 129' 1
	trap 'exit 130' 2
	trap 'exit 143' 15
	(
		ulimit -f 1024
		wget -O "$installer" 'https://raw.githubusercontent.com/communism420/luci-app-videoplayer/main/scripts/install-from-github.sh'
	)
	sh "$installer"
)
```

The installer currently installs the latest published release, not the newer
1.1.0 source tree. It detects whether the router uses `apk` or `opkg`,
downloads the matching 1.0.0 package from
[Release 1.0.0](https://github.com/communism420/luci-app-videoplayer/releases/tag/1.0.0),
verifies its pinned SHA-256 checksum, attempts to refresh the package indexes,
and installs the package. The released APK is unsigned, so installation on
OpenWrt 25.12+ uses `apk add --allow-untrusted`. Downloads are size-limited to
protect the router's RAM-backed `/tmp` filesystem.

### Current `main` APK (OpenWrt 25.12.5)

To install the newest successfully tested `main` source instead of Release
1.0.0, use the separate APK-only installer:

```sh
(
	set -e
	installer="$(mktemp /tmp/install-videoplayer-main.XXXXXX)"
	trap 'rm -f "$installer"' 0
	trap 'exit 129' 1
	trap 'exit 130' 2
	trap 'exit 143' 15
	(
		ulimit -f 1024
		wget -O "$installer" 'https://raw.githubusercontent.com/communism420/luci-app-videoplayer/main/scripts/install-main-apk.sh'
	)
	sh "$installer"
)
```

After every successful package-check run for a push to `main`, GitHub Actions
rebuilds the current source package and publishes the architecture-scoped
`dist/` index, packages, SHA-256 values, and exact source commit to the
generated `snapshot` branch. The installer resolves that branch immutably,
matches the router's exact release, revision, and `DISTRIB_ARCH`, validates the
indexed path and checksum, and confirms that the source commit still equals
the current head of `main`. It refuses to install while a newer push is still
being checked or if any verification fails. This path supports only `apk`; use
the published-release installer above on OpenWrt versions that still use
`opkg`.
OpenWrt 25.12.1 and newer can force a reinstall when two snapshots share the
same package version. On 25.12.0, the first installation works, but an existing
copy must be removed manually before installing any newer build, including a
genuine version upgrade.

### Architecture-specific Codec Runtime (APK or IPK)

The generated codec package version is **6.1.4-r2**. The current matrix covers:

- OpenWrt `25.12.5` revision `r33051-f5dae5ece4`: 35 APK architectures;
- OpenWrt `24.10.8` revision `r29233-443ec4032a`: 36 IPK architectures;
- 37 unique `DISTRIB_ARCH` folders and 71 codec packages in total.

Your ASUS RT-AX52 reports `aarch64_cortex-a53` and therefore selects that
folder. Other AArch64 routers may report `aarch64_cortex-a72`,
`aarch64_cortex-a76`, or `aarch64_generic`; those are separate ABI folders
with separately compiled codec binaries.

Install the current 1.1.0 application package from the same exact architecture
folder first: the APK on OpenWrt 25.12.5 or the IPK on OpenWrt 24.10.8. Then
select **Router CPU rendering** in LuCI and run:

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
checksum failures before installation. It then confirms that the private
runtime exposes the native H.264, HEVC, and VC-1 decoders plus every component
required by the JPEG and PCM renderers.

Each runtime is built from a checksum-pinned official OpenWrt SDK with
`CONFIG_BUILD_PATENTED=y`. QEMU-compatible architectures are executed under
their matching user emulator for H.264-to-JPEG and AAC-to-PCM smoke tests.
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
│   │   └── luci-videoplayer-codec-runtime-6.1.4-r2.apk
│   └── openwrt-24.10.8-r29233-443ec4032a/
│       ├── luci-app-videoplayer_1.1.0_all.ipk
│       └── luci-videoplayer-codec-runtime_6.1.4-r2_aarch64_cortex-a53.ipk
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
| `router_fps` | Router CPU output frame rate: `5`, `8` (default), or `12`; unknown values safely fall back to `8` |
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
  selectable at 5, 8, or 12 FPS; 8 FPS is the default, while 12 FPS places the
  greatest load on the router.
- Router CPU audio uses signed 16-bit stereo PCM chunks at 48 kHz and the
  browser Web Audio API. Playback must be started by a user action because of
  browser autoplay policies. Media without a usable audio stream remains
  silent, and browsers without Web Audio support continue with video only.
- Router CPU mode has no pause, seeking, duration, or timeline. Its independently
  delivered JPEG frames and audio chunks provide approximate synchronization,
  so slow routers or networks may introduce stutter, gaps, or audio/video drift.
- If router-side FFmpeg cannot start for a local file, the UI reports the
  classified failure and automatically retries that file with browser
  decoding. Automatic browser fallback starts muted; audio can be enabled with
  the player control.
- Router CPU mode can cause high CPU use, heat, stutter, and temporary LuCI
  slowdown. Reducing the output frame rate does not prevent FFmpeg from
  decoding the source stream, so high-resolution media may still overwhelm a
  low-powered router.
- The source file is read incrementally through a validated file descriptor;
  it is not copied into RAM. FFmpeg still needs working memory for compressed
  packets, decoded frames, reference frames, scaling, and JPEG output.
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
exercises successful renderer and PCM-audio lifecycle, validates browser PCM
conversion, queueing, and cleanup, checks modern and legacy missing-decoder
diagnostics, unusable V4L2 hardware decoders, bounded noisy logs, and unknown
FFmpeg failures with isolated fake processes, and builds and verifies both
packages. After those checks pass on `main`, a separate job
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
FFmpeg patches, and cross-compiles 35 private APK executables plus 36 private
IPK executables. Every binary is checked for an isolated payload and target
`libc` as its only dynamic dependency, then exercised under the matching QEMU
user emulator for H.264-to-JPEG and AAC-to-PCM output where that ISA is
faithfully supported. Octeon and embedded PowerPC use the strict static
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
