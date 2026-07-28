#!/bin/sh
# SPDX-License-Identifier: GPL-2.0-or-later

set -eu

die() {
	printf 'Validation error: %s\n' "$*" >&2
	exit 1
}

[ "$#" -eq 3 ] ||
	die "usage: validate-runtime.sh BINARY SYSROOT WORK_DIRECTORY"

binary="$1"
sysroot="$2"
work="$3"
qemu="${QEMU_AARCH64:-qemu-aarch64-static}"

[ -f "$binary" ] && [ -x "$binary" ] ||
	die "private FFmpeg binary is missing or not executable"
[ -d "$sysroot" ] ||
	die "target sysroot is missing"
command -v "$qemu" >/dev/null 2>&1 ||
	die "qemu-aarch64-static is unavailable"
command -v readelf >/dev/null 2>&1 ||
	die "readelf is unavailable"
command -v ffmpeg >/dev/null 2>&1 ||
	die "host FFmpeg is unavailable"
mkdir -p "$work"

dynamic="$work/readelf-dynamic.txt"
readelf -d "$binary" > "$dynamic"

if grep -Eq 'Shared library: \[lib(av|sw)' "$dynamic"; then
	die "private FFmpeg has a dynamic dependency on a libav library"
fi
if grep -Eq '\((RPATH|RUNPATH)\)' "$dynamic"; then
	die "private FFmpeg unexpectedly contains RPATH or RUNPATH"
fi

sed -n 's/.*Shared library: \[\([^]]*\)\].*/\1/p' "$dynamic" |
while IFS= read -r library; do
	case "$library" in
		libc.so)
			;;
		*)
			die "unexpected dynamic dependency: $library"
			;;
	esac
done

run_target() {
	"$qemu" -L "$sysroot" "$binary" "$@"
}

version="$work/version.txt"
run_target -hide_banner -version > "$version" 2>&1
for option in \
	--disable-shared \
	--enable-static \
	--disable-autodetect \
	--disable-network \
	--disable-avdevice
do
	grep -F -- "$option" "$version" >/dev/null ||
		die "FFmpeg configuration is missing $option"
done

decoders="$work/decoders.txt"
encoders="$work/encoders.txt"
demuxers="$work/demuxers.txt"
muxers="$work/muxers.txt"
filters="$work/filters.txt"

run_target -hide_banner -decoders > "$decoders" 2>&1
run_target -hide_banner -encoders > "$encoders" 2>&1
run_target -hide_banner -demuxers > "$demuxers" 2>&1
run_target -hide_banner -muxers > "$muxers" 2>&1
run_target -hide_banner -filters > "$filters" 2>&1

has_component() {
	awk -v name="$2" '
		{
			count = split($2, aliases, ",")
			for (i = 1; i <= count; i++)
				if (aliases[i] == name)
					found = 1
		}
		END { exit found ? 0 : 1 }
	' "$1"
}

for decoder in h264 hevc vc1 mpeg4 vp8 vp9 av1 mjpeg
do
	has_component "$decoders" "$decoder" ||
		die "native decoder is missing: $decoder"
done
has_component "$encoders" mjpeg ||
	die "MJPEG encoder is missing"
for demuxer in mov matroska avi mpegts
do
	has_component "$demuxers" "$demuxer" ||
		die "demuxer is missing: $demuxer"
done
has_component "$muxers" image2 ||
	die "image2 muxer is missing"
for filter in fps scale format
do
	has_component "$filters" "$filter" ||
		die "filter is missing: $filter"
done

if awk '$2 ~ /_v4l2m2m$/ { found = 1 } END { exit found ? 0 : 1 }' "$decoders"; then
	die "a V4L2 M2M wrapper decoder was unexpectedly enabled"
fi

sample="$work/h264-sample.mp4"
frame="$work/frame.jpg"
ffmpeg \
	-hide_banner -loglevel error -y \
	-f lavfi -i "testsrc=size=160x90:rate=5:duration=1" \
	-c:v libx264 -pix_fmt yuv420p -an "$sample"

(
	exec 3< "$sample"
	run_target \
		-y -hide_banner -loglevel error -nostats -nostdin \
		-protocol_whitelist file,pipe -threads 1 \
		-fflags +genpts -err_detect ignore_err \
		-i /proc/self/fd/3 -map 0:V:0 -an -sn -dn -map_metadata -1 \
		-filter_threads 1 \
		-vf "fps=3,scale=160:90:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=fast_bilinear,format=yuvj420p" \
		-frames:v 1 -threads 1 -c:v mjpeg -q:v 8 \
		-f image2 -update 1 -atomic_writing 1 "$frame"
)

[ -s "$frame" ] ||
	die "H.264 decode-to-JPEG smoke test produced no frame"
magic="$(od -An -tx1 -N2 "$frame" | tr -d ' \n')"
[ "$magic" = "ffd8" ] ||
	die "smoke-test output is not a JPEG file"

printf '%s\n' "Private codec runtime validation passed."
