#!/bin/sh
# SPDX-License-Identifier: GPL-2.0-or-later

set -eu

die() {
	printf 'Validation error: %s\n' "$*" >&2
	exit 1
}

[ "$#" -eq 8 ] ||
	die "usage: validate-runtime.sh BINARY SYSROOT WORK_DIRECTORY QEMU_EXECUTABLE VALIDATION_MODE CONFIG_H CONFIG_COMPONENTS_H MJPEG_RELAY"

binary="$1"
sysroot="$2"
work="$3"
qemu="$4"
validation_mode="$5"
main_config="$6"
component_config="$7"
relay="$8"
validation_timeout="${VALIDATION_TIMEOUT:-180}"
qemu_cpu_model="${QEMU_CPU_MODEL:-}"

if [ ! -f "$binary" ] || [ ! -x "$binary" ]; then
	die "private FFmpeg binary is missing or not executable"
fi
if [ ! -f "$relay" ] || [ -L "$relay" ] || [ ! -x "$relay" ]; then
	die "frame-aligned MJPEG relay is missing, unsafe, or not executable"
fi
[ -f "$main_config" ] ||
	die "FFmpeg config.h is missing"
[ -f "$component_config" ] ||
	die "FFmpeg config_components.h is missing"
command -v readelf >/dev/null 2>&1 ||
	die "readelf is unavailable"
mkdir -p "$work"
case "$validation_timeout" in
	""|*[!0-9]*)
		die "VALIDATION_TIMEOUT must be a positive integer"
		;;
	0)
		die "VALIDATION_TIMEOUT must be greater than zero"
		;;
esac
case "$qemu_cpu_model" in
	""|*[!A-Za-z0-9_.+-]*)
		[ -z "$qemu_cpu_model" ] ||
			die "QEMU_CPU_MODEL contains an unsafe character"
		;;
esac

require_config_value() {
	config_file="$1"
	config_symbol="$2"
	config_value="$3"
	grep -Eq \
		"^#define[[:space:]]+${config_symbol}[[:space:]]+${config_value}$" \
		"$config_file" ||
		die "$config_symbol is not set to $config_value"
}

for enabled_option in \
	CONFIG_STATIC \
	CONFIG_SWRESAMPLE
do
	require_config_value "$main_config" "$enabled_option" 1
done
for disabled_option in \
	CONFIG_SHARED \
	CONFIG_AUTODETECT \
	CONFIG_NETWORK \
	CONFIG_AVDEVICE
do
	require_config_value "$main_config" "$disabled_option" 0
done

for component in \
	H264_DECODER HEVC_DECODER VC1_DECODER MPEG4_DECODER VP8_DECODER \
	VP9_DECODER AV1_DECODER MJPEG_DECODER AAC_DECODER AC3_DECODER \
	EAC3_DECODER ALAC_DECODER DCA_DECODER FLAC_DECODER MP3_DECODER \
	OPUS_DECODER PCM_S16LE_DECODER TRUEHD_DECODER VORBIS_DECODER \
	MJPEG_ENCODER PCM_S16LE_ENCODER MOV_DEMUXER MATROSKA_DEMUXER \
	AVI_DEMUXER MPEGTS_DEMUXER IMAGE2_MUXER MPJPEG_MUXER PCM_S16LE_MUXER \
	TEE_MUXER \
	FPS_FILTER SCALE_FILTER FORMAT_FILTER ARESAMPLE_FILTER \
	AFORMAT_FILTER APAD_FILTER ASETNSAMPLES_FILTER
do
	require_config_value "$component_config" "CONFIG_$component" 1
done
for wrapper in \
	H263_V4L2M2M_DECODER H264_V4L2M2M_DECODER HEVC_V4L2M2M_DECODER \
	MPEG1_V4L2M2M_DECODER MPEG2_V4L2M2M_DECODER MPEG4_V4L2M2M_DECODER \
	VC1_V4L2M2M_DECODER VP8_V4L2M2M_DECODER VP9_V4L2M2M_DECODER
do
	require_config_value "$component_config" "CONFIG_$wrapper" 0
done

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

relay_dynamic="$work/readelf-relay-dynamic.txt"
readelf -d "$relay" > "$relay_dynamic"
if grep -Eq '\((RPATH|RUNPATH)\)' "$relay_dynamic"; then
	die "frame-aligned MJPEG relay unexpectedly contains RPATH or RUNPATH"
fi
sed -n 's/.*Shared library: \[\([^]]*\)\].*/\1/p' "$relay_dynamic" |
while IFS= read -r library; do
	case "$library" in
		libc.so)
			;;
		*)
			die "unexpected MJPEG relay dynamic dependency: $library"
			;;
	esac
done

case "$validation_mode" in
	static)
		printf '%s\n' \
			"Private codec runtime static validation passed (QEMU execution unavailable for this ISA)."
		exit 0
		;;
	qemu)
		;;
	*)
		die "unknown validation mode: $validation_mode"
		;;
esac

[ -d "$sysroot" ] ||
	die "target sysroot is missing"
command -v "$qemu" >/dev/null 2>&1 ||
	die "$qemu is unavailable"
command -v timeout >/dev/null 2>&1 ||
	die "timeout is unavailable"
command -v ffmpeg >/dev/null 2>&1 ||
	die "host FFmpeg is unavailable"

run_target_binary() {
	target_binary="$1"
	shift
	if [ -n "$qemu_cpu_model" ]; then
		timeout "$validation_timeout" \
			"$qemu" -cpu "$qemu_cpu_model" -L "$sysroot" \
			"$target_binary" "$@"
	else
		timeout "$validation_timeout" "$qemu" -L "$sysroot" \
			"$target_binary" "$@"
	fi
}

run_target() {
	run_target_binary "$binary" "$@"
}

# Start inside a newline-free truncated JPEG which is larger than the header
# buffer. The successor relay must resynchronize at the next line-start boundary
# in one pass and forward the following complete frame and closing marker.
relay_boundary="videoplayer-0123456789abcdef0123456789abcdef"
relay_input="$work/relay-resync-input.mjpeg"
relay_output="$work/relay-resync-output.mjpeg"
relay_expected="$work/relay-resync-expected.mjpeg"
relay_prefetched_input="$work/relay-prefetched-input.mjpeg"
relay_prefetched_output="$work/relay-prefetched-output.mjpeg"
dd if=/dev/zero bs=20000 count=1 2>/dev/null > "$relay_input"
printf '\r\n--%s\r\nContent-Type: image/jpeg\r\nContent-Length: 4\r\n\r\n\377\330\377\331\r\n--%s--\r\n' \
	"$relay_boundary" "$relay_boundary" >> "$relay_input"
printf '%s\r\nContent-Type: image/jpeg\r\nContent-Length: 4\r\n\r\n\377\330\377\331\r\n--%s--\r\n' \
	"--$relay_boundary" "$relay_boundary" > "$relay_expected"
run_target_binary "$relay" "$relay_boundary" 0 3600 \
	"$work/no-terminal-marker" 1-1 25 < "$relay_input" > "$relay_output"
cmp "$relay_expected" "$relay_output" ||
	die "frame-aligned MJPEG relay failed its binary resynchronization smoke test"

# When the worker already claimed the first multipart boundary, stdin starts at
# the part headers. The relay must delay publication until the complete JPEG is
# validated and must emit exactly one replacement boundary, never an empty part.
printf 'Content-Type: image/jpeg\r\nContent-Length: 4\r\n\r\n\377\330\377\331\r\n--%s--\r\n' \
	"$relay_boundary" > "$relay_prefetched_input"
run_target_binary "$relay" "$relay_boundary" 1 3600 \
	"$work/no-terminal-marker" 1-2 25 \
	< "$relay_prefetched_input" > "$relay_prefetched_output"
cmp "$relay_expected" "$relay_prefetched_output" ||
	die "frame-aligned MJPEG relay duplicated its prefetched boundary"

set +e
run_target_binary "$relay" "$relay_boundary" 0 3600 \
	"$work/no-terminal-marker" invalid-nonce 25 \
	< /dev/null > "$work/relay-invalid-nonce.txt" 2>&1
relay_invalid_nonce_rc=$?
set -e
[ "$relay_invalid_nonce_rc" -eq 64 ] ||
	die "frame-aligned MJPEG relay accepted an invalid request nonce"

# A full PCM ring can pause the unified FFmpeg producer between video frames.
# The relay must still end its current CGI response on the wall deadline without
# consuming any byte of the next boundary, leaving a clean successor handoff.
relay_stall_fifo="$work/relay-stall.fifo"
relay_stall_output="$work/relay-stall-output.mjpeg"
relay_stall_expected="$work/relay-stall-expected.mjpeg"
mkfifo -m 0600 "$relay_stall_fifo"
(sleep 5) > "$relay_stall_fifo" &
relay_stall_writer=$!
set +e
run_target_binary "$relay" "$relay_boundary" 0 1 \
	"$work/no-terminal-marker" 1-3 25 \
	< "$relay_stall_fifo" > "$relay_stall_output"
relay_stall_rc=$?
set -e
kill "$relay_stall_writer" 2>/dev/null || :
wait "$relay_stall_writer" 2>/dev/null || :
[ "$relay_stall_rc" -eq 2 ] ||
	die "frame-aligned MJPEG relay ignored its between-frame deadline"
printf '%s\r\n' "--$relay_boundary--" > "$relay_stall_expected"
cmp "$relay_stall_expected" "$relay_stall_output" ||
	die "frame-aligned MJPEG relay did not close a stalled clean segment"

version="$work/version.txt"
run_target -hide_banner -version > "$version" 2>&1
for option in \
	--disable-shared \
	--enable-static \
	--disable-autodetect \
	--disable-network \
	--disable-avdevice \
	--enable-swresample
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

for decoder in \
	h264 hevc vc1 mpeg4 vp8 vp9 av1 mjpeg \
	aac ac3 eac3 alac dca flac mp3 opus pcm_s16le truehd vorbis
do
	has_component "$decoders" "$decoder" ||
		die "native decoder is missing: $decoder"
done
has_component "$encoders" mjpeg ||
	die "MJPEG encoder is missing"
has_component "$encoders" pcm_s16le ||
	die "PCM S16LE encoder is missing"
for demuxer in mov matroska avi mpegts
do
	has_component "$demuxers" "$demuxer" ||
		die "demuxer is missing: $demuxer"
done
for muxer in image2 mpjpeg s16le tee
do
	has_component "$muxers" "$muxer" ||
		die "muxer is missing: $muxer"
done
for filter in fps scale format aresample aformat apad asetnsamples
do
	has_component "$filters" "$filter" ||
		die "filter is missing: $filter"
done

if awk '$2 ~ /_v4l2m2m$/ { found = 1 } END { exit found ? 0 : 1 }' "$decoders"; then
	die "a V4L2 M2M wrapper decoder was unexpectedly enabled"
fi

sample="$work/h264-sample.mp4"
long_audio_sample="$work/h264-short-video-long-audio.mp4"
video_stream="$work/video.mjpeg"
audio_pcm="$work/audio.pcm"
tee_video_stream="$work/tee-video.mjpeg"
tee_audio_pcm="$work/tee-audio.pcm"
[ ! -e "$audio_pcm" ] ||
	die "audio smoke-test output already exists: $audio_pcm"
ffmpeg \
	-hide_banner -loglevel error -y \
	-f lavfi -i "testsrc=size=160x90:rate=5:duration=1" \
	-f lavfi -i "sine=frequency=1000:sample_rate=44100:duration=1" \
	-map 0:v:0 -map 1:a:0 \
	-c:v libx264 -pix_fmt yuv420p \
	-c:a aac -b:a 96k -shortest "$sample"
ffmpeg \
	-hide_banner -loglevel error -y \
	-f lavfi -i "testsrc=size=160x90:rate=5:duration=1.13" \
	-f lavfi -i "anullsrc=r=44100:cl=stereo:d=20" \
	-map 0:v:0 -map 1:a:0 \
	-c:v libx264 -pix_fmt yuv420p \
	-c:a aac -b:a 24k "$long_audio_sample"


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
		-f mpjpeg -boundary_tag videoplayer-validation "$video_stream"
)

[ -s "$video_stream" ] ||
	die "H.264 decode-to-MJPEG smoke test produced no stream"
first_line="$(
	sed -n '1 { s/\r$//; p; q; }' "$video_stream"
)"
[ "$first_line" = "--videoplayer-validation" ] ||
	die "MJPEG smoke-test output has the wrong boundary"
prefix_hex="$(
	od -An -tx1 -N512 "$video_stream" | tr -d ' \n'
)"
case "$prefix_hex" in
	*0d0a0d0affd8*) ;;
	*) die "MJPEG smoke-test output has no JPEG part" ;;
esac

(
	exec 3< "$sample"
	run_target \
		-y -hide_banner -loglevel error -nostats -nostdin \
		-protocol_whitelist file,pipe -threads 1 \
		-fflags +genpts -err_detect ignore_err \
		-i /proc/self/fd/3 -map 0:a:0 -vn -sn -dn -map_metadata -1 \
		-filter_threads 1 \
		-af "aresample=48000:async=1:first_pts=0,aformat=sample_fmts=s16:channel_layouts=stereo,asetnsamples=n=12000:p=1" \
		-c:a pcm_s16le \
		-f s16le "$audio_pcm"
)

[ -s "$audio_pcm" ] ||
	die "AAC-to-PCM smoke test produced no audio"
audio_size="$(wc -c < "$audio_pcm" | tr -d '[:space:]')"
[ "$audio_size" -ge 192000 ] ||
	die "AAC-to-PCM smoke test produced only $audio_size bytes"
[ $((audio_size % 48000)) -eq 0 ] ||
	die "PCM smoke-test size is not an exact number of 48,000-byte chunks"

# Exercise the exact unified output topology used by the router renderer. The
# apad/shortest pair makes video authoritative while tee sends each selected
# stream to its own transport. asetnsamples follows apad so even the terminal
# padded PCM block remains exactly 48,000 bytes.
(
	exec 3< "$long_audio_sample"
	run_target \
		-y -hide_banner -loglevel error -nostats -nostdin \
		-filter_threads 2 \
		-protocol_whitelist file,pipe -threads 4 \
		-fflags +genpts -err_detect ignore_err -i /proc/self/fd/3 \
		-protocol_whitelist file,pipe -threads 1 \
		-fflags +genpts -err_detect ignore_err -i /proc/self/fd/3 \
		-map 0:V:0 -map 1:a:0 -sn -dn -map_metadata -1 \
		-vf "fps=fps=5:start_time=0,scale=160:90:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=fast_bilinear,format=yuvj420p" \
		-af "aresample=48000:async=1:first_pts=0,aformat=sample_fmts=s16:channel_layouts=stereo,apad,asetnsamples=n=12000:p=1" \
		-threads:v 2 -threads:a 1 \
		-c:v mjpeg -q:v 8 -c:a pcm_s16le -shortest -flush_packets 1 \
		-f tee \
		"[select=v:f=mpjpeg:boundary_tag=videoplayer-validation]$tee_video_stream|[select=a:f=s16le:onfail=ignore]$tee_audio_pcm"
)

[ -s "$tee_video_stream" ] ||
	die "unified tee smoke test produced no MJPEG stream"
[ -s "$tee_audio_pcm" ] ||
	die "unified tee smoke test produced no PCM audio"
tee_audio_size="$(wc -c < "$tee_audio_pcm" | tr -d '[:space:]')"
[ $((tee_audio_size % 48000)) -eq 0 ] ||
	die "unified tee PCM is not an exact number of 48,000-byte chunks"
[ "$tee_audio_size" -le $((32 * 48000)) ] ||
	die "overlong audio filled the complete router PCM ring after video EOF"

printf '%s\n' "Private codec runtime validation passed."
