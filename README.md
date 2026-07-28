# luci-app-videoplayer

A joke but functional video player for **OpenWrt**, integrated into **LuCI**.
Local videos can either be decoded normally by the client browser or decoded
and converted into a low-frame-rate JPEG preview by the router CPU with
FFmpeg. In both cases, the output stays inside the LuCI web interface. The
application does not use HDMI or a framebuffer.

Current source package version: **1.1.0**. The latest published GitHub release
is still **1.0.0**; the pinned quick installer below intentionally installs
that published release until 1.1.0 release assets exist.

## Features

| Mode | How it works |
|---|---|
| Browser decoding | Browse local storage and stream the original file to the HTML5 `<video>` element with HTTP Range support |
| Router CPU rendering | FFmpeg decodes a local file on the router and publishes an experimental silent JPEG preview at up to 3 FPS |
| Remote URLs | Play `http://` and `https://` URLs directly in the browser; remote URLs are never fetched by FFmpeg on the router |
| Interface | **Services → Video Player** page in LuCI |

The local browser recognizes common containers and raw streams, including
MP4/M4V/MOV, WebM, MKV, AVI/DivX, Ogg, MPEG/VOB, MPEG-TS/M2TS/MTS, FLV/F4V,
WMV/ASF, 3GP/3G2, RealMedia, and raw H.264/H.265 files. Extension matching is
case-insensitive. MP4 with H.264 video and AAC audio offers the broadest
client-browser compatibility. Router CPU mode depends on the decoders enabled
in the installed OpenWrt FFmpeg build, so it may support a different subset.
Directory entries are sorted on the router in a stable bytewise order and
returned in pages of 100 entries. A link to the parent directory is available
on every page.

```text
LuCI (main.js)
    │ ubus/rpcd
    ▼
luci.videoplayer ── authenticated list / resolve / renderer control
    │
    ├── Browser mode ── /cgi-bin/videoplayer-stream?token=…
    │                    └── original file with HTTP Range (206)
    │
    └── Router mode ─── FFmpeg worker ── atomic JPEG in /tmp
                         └── /cgi-bin/videoplayer-frame?token=…

UCI videoplayer.main.media_path ── root of the accessible media library
```

LuCI calls ACL-protected backend methods. Browser resolution and renderer
status require read permission; starting or stopping the CPU renderer requires
write permission. Read-only LuCI accounts automatically fall back to browser
decoding. The backend validates the path and issues a short-lived opaque
token. The CGI endpoint accepts only this token, never a file path supplied by
the browser. Tokens are stored in 4,096 fixed bucket slots, preventing their
count and lookup cost from growing without bound. If a random collision
selects a slot containing an unexpired token, the backend chooses another slot
instead of overwriting it.

Router CPU mode has a separate single-session runtime. Only one FFmpeg worker
may run at a time, and selecting another local video replaces the previous
session. Each session uses its own random token directory under `/tmp`; frames
are written with FFmpeg's atomic image update mode. The UI renews a short
heartbeat while it is receiving frames. Closing the page or losing the client
stops CPU work after the heartbeat timeout, and every session also has an
absolute expiry.

## Requirements

The package directly depends on `luci-base`, `uhttpd`, `jshn`,
`coreutils-stat`, and `ffmpeg`. The application itself contains no
CPU-specific binaries, so its architecture remains `all` for IPK and `noarch`
for APK; the package manager selects the architecture-specific FFmpeg
dependencies.

FFmpeg is large for router software. Depending on architecture and repository
configuration, `libffmpeg-full` alone may consume roughly 14–23 MiB after
installation, before its other dependencies. Router CPU mode also requires an
FFmpeg build containing the native MJPEG encoder, the `image2` muxer, and the
`fps` and `scale` filters. The UI checks these capabilities before enabling a
CPU-rendered session.

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

## Building and Verifying Packages Locally

Python 3.10 or newer is sufficient for rapid local development:

```sh
python scripts/build-packages.py --check-reproducible
python scripts/build-packages.py --verify-only
```

The builder uses `SOURCE_DATE_EPOCH` (default: `0`), so identical sources
produce byte-for-byte identical packages. Example with an explicit timestamp:

```sh
SOURCE_DATE_EPOCH=1767225600 python scripts/build-packages.py --check-reproducible
```

In PowerShell:

```powershell
$env:SOURCE_DATE_EPOCH = '1767225600'
python scripts/build-packages.py --check-reproducible
```

The resulting files are written to `dist/`:

| File | Package manager | OpenWrt |
|---|---|---|
| `luci-app-videoplayer-1.1.0.apk` | `apk` | 25.12+ / snapshots |
| `luci-app-videoplayer_1.1.0_all.ipk` | `opkg` | 24.10 and compatible releases that use `opkg` |

The IPK uses the gzip-compressed GNU tar format expected by OpenWrt 24.10.
`Installed-Size` is calculated in the same way as by the standard
`ipkg-build` script: from the size of the uncompressed `data.tar`.

The locally built APK is unsigned, and its minimal built-in builder is intended
for development and testing. For a public package repository, use the official
OpenWrt SDK/Buildroot and its standard `apk mkpkg` tool. It creates and signs a
package in the format expected by the selected OpenWrt release.

## Installing a Prebuilt Local Package

OpenWrt 25.12+:

```sh
scp -O dist/luci-app-videoplayer-1.1.0.apk root@192.168.1.1:/tmp/
ssh root@192.168.1.1
apk add --allow-untrusted /tmp/luci-app-videoplayer-1.1.0.apk
```

OpenWrt 24.10 (`opkg`):

```sh
scp -O dist/luci-app-videoplayer_1.1.0_all.ipk root@192.168.1.1:/tmp/
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
dependencies, so install a compatible `ffmpeg` package on the router first.

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
	option max_depth '8'
```

| Option | Description |
|---|---|
| `enabled` | Enable or disable the streamer |
| `media_path` | Root directory of the local media library |
| `allow_remote` | Show the remote URL field in the interface |
| `render_mode` | Local playback mode: `browser` or `router`; unknown values safely fall back to `browser` |
| `max_depth` | Maximum traversal depth for nested directories |

The `uci-defaults` script is idempotent: it restores a missing section and adds
only missing options without overwriting user-defined values.
`/etc/config/videoplayer` is declared as a conffile, so the package manager
treats it as user configuration during upgrades.

## Removing the Package

```sh
# OpenWrt with apk
apk del luci-app-videoplayer

# OpenWrt with opkg
opkg remove luci-app-videoplayer
```

The post-removal script clears LuCI caches and temporary player state
(stream tokens, renderer sessions, and locks), then reloads rpcd. Videos are
never deleted. How the configuration file is handled during removal depends
on the package manager and whether the file has been modified.

## Limitations and Security

- This is a web interface, not a hardware HDMI player.
- Browser mode codec support depends on the client browser.
- Router CPU mode is an experimental silent preview capped at 640×360 and
  approximately 3 FPS. It has no audio, pause, seeking, duration, or timeline.
- Router CPU mode can cause high CPU use, heat, stutter, and temporary LuCI
  slowdown. Reducing the output frame rate does not prevent FFmpeg from
  decoding the source stream, so high-resolution media may still overwhelm a
  low-powered router.
- Official OpenWrt FFmpeg builds may omit patented decoders such as H.264.
  A file that works in browser mode can therefore fail in router CPU mode.
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
exercises the renderer lifecycle with an isolated fake FFmpeg process, and
builds and verifies both packages. It does not publish anything or upload
files to a router.

## Repository Structure

```text
openwrt-video-player/
├── .github/workflows/package-check.yml
├── README.md
├── LICENSE
├── tests/renderer-behavior.sh
├── scripts/
│   ├── build-packages.py
│   ├── install-from-github.sh
│   ├── install-to-router.sh
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
        └── www/cgi-bin/videoplayer-frame
```

## License

[GPL-2.0-or-later](LICENSE).
