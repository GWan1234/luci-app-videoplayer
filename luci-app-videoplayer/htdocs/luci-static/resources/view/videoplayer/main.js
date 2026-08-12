'use strict';
'require view';
'require ui';
'require uci';
'require rpc';
'require request';

const callStatus  = rpc.declare({ object: 'luci.videoplayer', method: 'get_status' });
const callList    = rpc.declare({ object: 'luci.videoplayer', method: 'list', params: [ 'path', 'offset', 'limit' ] });
const callRendererList = rpc.declare({ object: 'luci.videoplayer', method: 'list_renderer', params: [ 'path', 'offset', 'limit' ] });
const callResolve = rpc.declare({ object: 'luci.videoplayer', method: 'resolve', params: [ 'path' ] });
const callStartRenderer = rpc.declare({ object: 'luci.videoplayer', method: 'start_renderer', params: [ 'path' ] });
const callResolveAudio = rpc.declare({ object: 'luci.videoplayer', method: 'resolve_audio', params: [ 'token' ] });
const callRendererStatus = rpc.declare({ object: 'luci.videoplayer', method: 'renderer_status', params: [ 'token' ] });
const callStopRenderer   = rpc.declare({
	object: 'luci.videoplayer',
	method: 'stop_renderer',
	params: [ 'token' ],
	nobatch: true
});
const PAGE_SIZE = 100;
const CPU_ROUTER_FPS_OPTIONS = [ 5, 8, 12, 15, 20, 24, 30, 48, 50, 60 ];
const CPU_ROUTER_PROFILE_OPTIONS = [ 'fast', 'quality' ];
const CPU_STREAM_ATTEMPT_TIMEOUT_MS = 5000;
const CPU_STREAM_IDLE_TIMEOUT_MS = 15000;
const CPU_STREAM_STATUS_INTERVAL_MS = 3000;
const CPU_STREAM_PROBE_INTERVAL_MS = 100;
const CPU_STREAM_HANDOFF_GRACE_MS = 250;
const CPU_STREAM_OUTAGE_TIMEOUT_MS = 15000;
const CPU_STREAM_MAX_RECONNECT_MS = 3000;
const CPU_BUFFERED_RESPONSE_TIMEOUT_MS = 60000;
const CPU_TERMINAL_DRAIN_TIMEOUT_MS = 120000;
const CPU_TERMINAL_FIRST_FRAME_TIMEOUT_MS = 15000;
const CPU_AUDIO_SAMPLE_RATE = 48000;
const CPU_AUDIO_CHANNELS = 2;
const CPU_AUDIO_FRAMES_PER_CHUNK = 48000;
const CPU_AUDIO_CHUNK_BYTES = 192000;
const CPU_AUDIO_CHUNK_MS = 1000;
const CPU_AUDIO_BATCH_MAX_CHUNKS = 2;
const CPU_AUDIO_REQUEST_TIMEOUT_MS = 2500;
const CPU_AUDIO_BUSY_RETRY_MS = CPU_AUDIO_REQUEST_TIMEOUT_MS + 500;
const CPU_AUDIO_NOT_READY_MIN_MS = 50;
const CPU_AUDIO_NOT_READY_MAX_MS = CPU_AUDIO_CHUNK_MS;
const CPU_AUDIO_START_TIMEOUT_MS = 10000;
const CPU_AUDIO_DRAIN_TIMEOUT_MS = 5000;
const CPU_AUDIO_INITIAL_LEAD_SECONDS = 0.12;
const CPU_AUDIO_MAX_LEAD_SECONDS = 2;
const CPU_MAX_MEDIA_OFFSET_MS = 21605000;
const CPU_MJPEG_MAX_HEADER_BYTES = 4096;
const CPU_MJPEG_MAX_FRAME_BYTES = 4 * 1024 * 1024;
const CPU_AV_SYNC_INTERVAL_MS = 100;
const CPU_AV_STALL_MIN_MS = 350;
const CPU_AV_RATE_WINDOW_MS = 500;
const CPU_AV_HARD_DRIFT_SECONDS = 0.10;
const CPU_AV_PCM_REBASE_DRIFT_SECONDS = 0.25;
const CPU_AV_PCM_REBASE_INTERVAL_MS = 500;
const CPU_AV_HIDDEN_HOLD_MS = 500;
const CPU_AV_BUFFER_TOLERANCE_SECONDS = 0.25;
const CPU_AV_MIN_ESTIMATED_RATE = 0.001;
const CPU_BUFFER_INITIAL_SECONDS = 120;
const CPU_BUFFER_HIGH_WATER_SECONDS = 180;
const CPU_BUFFER_REBUFFER_SECONDS = 30;
const CPU_BUFFER_HARD_LIMIT_BYTES = 512 * 1024 * 1024;
const CPU_BUFFER_SEGMENT_RESERVE_BYTES = 20 * 1024 * 1024;
const CPU_BUFFER_POLL_MS = 100;
const CPU_BUFFER_COUNTER_INTERVAL_MS = 250;
const CPU_RENDER_RATE_SAMPLE_MS = 1000;
const CPU_BUFFER_UNDERRUN_GUARD_SECONDS = 0.25;

function cpuMonotonicNow() {
	if (window.performance && typeof window.performance.now === 'function')
		return window.performance.now();
	return Date.now();
}

function concatBytes(left, right) {
	if (!left || !left.length)
		return right.slice();
	if (!right || !right.length)
		return left;
	const joined = new Uint8Array(left.length + right.length);
	joined.set(left, 0);
	joined.set(right, left.length);
	return joined;
}

function asciiBytes(value) {
	value = String(value || '');
	const bytes = new Uint8Array(value.length);
	for (let i = 0; i < value.length; i++)
		bytes[i] = value.charCodeAt(i) & 0x7f;
	return bytes;
}

function findBytes(haystack, needle, start) {
	start = Math.max(0, Number(start) || 0);
	if (!needle.length)
		return start <= haystack.length ? start : -1;
	for (let i = start; i + needle.length <= haystack.length; i++) {
		let matched = true;
		for (let j = 0; j < needle.length; j++) {
			if (haystack[i + j] !== needle[j]) {
				matched = false;
				break;
			}
		}
		if (matched)
			return i;
	}
	return -1;
}

function bytesToAscii(bytes) {
	let text = '';
	for (let i = 0; i < bytes.length; i++) {
		if (bytes[i] > 0x7f)
			throw new Error(_('The router returned non-ASCII MJPEG headers.'));
		text += String.fromCharCode(bytes[i]);
	}
	return text;
}

function formatSize(bytes) {
	const n = Number(bytes) || 0;
	if (n < 1024) return n + ' B';
	if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
	if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
	return (n / 1073741824).toFixed(2) + ' GB';
}

function flagOn(v) {
	return v === true || v === 1 || v === '1';
}

function normalizeRenderMode(value) {
	return value === 'router' ? 'router' : 'browser';
}

function normalizeRouterFps(value) {
	value = Number(value);
	return CPU_ROUTER_FPS_OPTIONS.indexOf(value) !== -1 ? value : 8;
}

function normalizeRouterProfile(value) {
	value = String(value || '').toLowerCase();
	return CPU_ROUTER_PROFILE_OPTIONS.indexOf(value) !== -1 ? value : 'fast';
}

function normalizeRouterFpsForProfile(value, profile) {
	const fps = normalizeRouterFps(value);

	return normalizeRouterProfile(profile) === 'fast' && fps > 8 ? 8 : fps;
}

function errorText(err) {
	if (err && err.message)
		return err.message;
	if (err != null)
		return String(err);
	return _('Unknown error');
}

function blobToArrayBuffer(blob) {
	if (!blob)
		return Promise.reject(new Error(_('The router returned an empty audio chunk.')));
	if (typeof blob.arrayBuffer === 'function')
		return blob.arrayBuffer();
	return new Promise(function (resolve, reject) {
		const reader = new FileReader();
		reader.onload = function () { resolve(reader.result); };
		reader.onerror = function () {
			reject(reader.error || new Error(_('Unable to read the audio chunk.')));
		};
		reader.readAsArrayBuffer(blob);
	});
}

function formatCpuDuration(seconds) {
	seconds = Number(seconds);
	if (!Number.isFinite(seconds) || seconds < 0)
		return '?';
	seconds = Math.floor(seconds);
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor(seconds % 3600 / 60);
	const remainder = seconds % 60;
	const pair = function (value) {
		return value < 10 ? '0' + value : String(value);
	};

	return hours > 0
		? hours + ':' + pair(minutes) + ':' + pair(remainder)
		: pair(minutes) + ':' + pair(remainder);
}

/*
 * addTimeLimitedNotification() is unavailable in older LuCI releases.
 * Keep the same call shape and remove the fallback notification ourselves.
 */
function notify(title, content, timeout, className) {
	const args = [ title, content, timeout ];
	let node;

	if (className)
		args.push(className);

	if (typeof ui.addTimeLimitedNotification === 'function')
		return ui.addTimeLimitedNotification.apply(ui, args);

	args.splice(2, 1);
	node = ui.addNotification.apply(ui, args);

	if (node && timeout > 0) {
		window.setTimeout(function () {
			if (!node.parentNode)
				return;

			if (node.classList) {
				node.classList.remove('fade-in');
				node.classList.add('fade-out');
			}

			window.setTimeout(function () {
				if (node.parentNode)
					node.parentNode.removeChild(node);
			}, 300);
		}, timeout);
	}

	return node;
}

return view.extend({
	load: function () {
		return Promise.all([
			uci.load('videoplayer'),
			callStatus().then(function (status) {
				return { status: status || {}, error: null };
			}).catch(function (err) {
				return { status: null, error: err };
			})
		]);
	},

	render: function (data) {
		const statusResult = data[1] || {};
		const status = statusResult.status || {};
		const self = this;
		const canWriteSettings = typeof L.hasViewPermission !== 'function' ||
			L.hasViewPermission() === true;
		const nextPlayGeneration = typeof self._playGeneration === 'number'
			? self._playGeneration + 1
			: 1;
		const nextBrowseRequestId = typeof self._browseRequestId === 'number'
			? self._browseRequestId + 1
			: 1;
		const previousCpuSession = typeof self._detachCpuSession === 'function'
			? self._detachCpuSession(true)
			: null;

		if (self._pendingCpuAudio &&
		    typeof self._disposeCpuAudio === 'function')
			self._disposeCpuAudio(self._pendingCpuAudio);
		self._pendingCpuAudio = null;
		if (typeof self._stopRendererBestEffort === 'function')
			self._stopRendererBestEffort(previousCpuSession);
		if (typeof self._clearVideoElement === 'function')
			self._clearVideoElement();
		if (typeof self._clearCpuBrowserAudioElement === 'function')
			self._clearCpuBrowserAudioElement();
		if (self._pageHideHandler)
			window.removeEventListener('pagehide', self._pageHideHandler);
		if (self._visibilityHandler &&
		    typeof document.removeEventListener === 'function')
			document.removeEventListener(
				'visibilitychange', self._visibilityHandler
			);

		const configuredEnabled = uci.get('videoplayer', 'main', 'enabled');
		const configuredMediaPath = uci.get('videoplayer', 'main', 'media_path');
		const configuredAllowRemote = uci.get('videoplayer', 'main', 'allow_remote');
		const configuredRenderMode = uci.get('videoplayer', 'main', 'render_mode');
		const configuredRouterProfile = uci.get('videoplayer', 'main', 'router_profile');
		const configuredRouterFps = uci.get('videoplayer', 'main', 'router_fps');
		const formMediaPath = configuredMediaPath !== undefined
			? String(configuredMediaPath)
			: (status.media_path || '/mnt/video');
		const formLocalEnabled = configuredEnabled !== undefined
			? flagOn(configuredEnabled)
			: (status.enabled !== undefined ? flagOn(status.enabled) : true);
		const formRemoteAllowed = configuredAllowRemote !== undefined
			? flagOn(configuredAllowRemote)
			: (status.allow_remote !== undefined ? flagOn(status.allow_remote) : true);
		const formRenderMode = normalizeRenderMode(
			configuredRenderMode !== undefined ? configuredRenderMode : status.render_mode
		);
		const formRouterProfile = normalizeRouterProfile(
			configuredRouterProfile !== undefined
				? configuredRouterProfile
				: status.router_profile
		);
		const formRouterFps = normalizeRouterFpsForProfile(
			configuredRouterFps !== undefined ? configuredRouterFps : status.router_fps,
			formRouterProfile
		);
		/*
		 * LuCI Save stages UCI changes without activating them. Keep the form on
		 * those staged values, while the player continues to reflect the active
		 * configuration reported by the backend until Save & Apply completes.
		 */
		const activeLocalEnabled = status.enabled !== undefined
			? flagOn(status.enabled)
			: formLocalEnabled;
		const activeRemoteAllowed = status.allow_remote !== undefined
			? flagOn(status.allow_remote)
			: formRemoteAllowed;
		const activeRenderMode = normalizeRenderMode(
			status.render_mode !== undefined ? status.render_mode : formRenderMode
		);
		const activeRouterProfile = normalizeRouterProfile(
			status.router_profile !== undefined
				? status.router_profile
				: formRouterProfile
		);
		const activeRouterFps = normalizeRouterFpsForProfile(
			status.router_fps !== undefined ? status.router_fps : formRouterFps,
			activeRouterProfile
		);
		const rendererAvailable = status.renderer_available === undefined
			? null
			: flagOn(status.renderer_available);

		self._cwd = '';
		self._offset = 0;
		self._limit = PAGE_SIZE;
		self._hasMore = false;
		self._browseLoading = false;
		self._browseRequestId = nextBrowseRequestId;
		self._playGeneration = nextPlayGeneration;
		self._localResolvePending = false;
		self._currentSrc = null;
		self._currentLabel = '';
		self._currentKind = null;
		self._currentRenderMode = null;
		self._cpuSession = null;
		self._localEnabled = activeLocalEnabled;
		self._allowRemote = activeRemoteAllowed;
		self._renderMode = activeRenderMode;
		self._routerProfile = activeRouterProfile;
		self._routerFps = activeRouterFps;
		self._rendererAvailable = rendererAvailable;
		self._canWriteSettings = canWriteSettings;
		self._statusLoadError = statusResult.error || null;
		self._status = {
			media_path: status.media_path || formMediaPath,
			enabled: status.enabled !== undefined ? status.enabled : activeLocalEnabled,
			allow_remote: status.allow_remote !== undefined ? status.allow_remote : activeRemoteAllowed,
			render_mode: activeRenderMode,
			router_profile: activeRouterProfile,
			router_fps: activeRouterFps,
			renderer_available: status.renderer_available,
			renderer_reason: status.renderer_reason,
			media_path_valid: status.media_path_valid,
			media_path_exists: status.media_path_exists,
			media_path_readable: status.media_path_readable
		};

		const root = E('div', { class: 'cbi-map', id: 'videoplayer-root' }, [
			E('style', {}, `
				#videoplayer-root .vp-player-wrap {
					background: #0b0b0f;
					border-radius: 8px;
					padding: 8px;
					margin-bottom: 10px;
				}
				#videoplayer-root video#videoplayer-video,
				#videoplayer-root img.videoplayer-cpu-frame,
				#videoplayer-root canvas.videoplayer-cpu-canvas {
					width: 100%;
					max-height: 70vh;
					background: #000;
					border-radius: 4px;
					display: block;
					object-fit: contain;
				}
				#videoplayer-root [hidden] { display: none !important; }
				#videoplayer-root video#videoplayer-video:fullscreen,
				#videoplayer-root img#videoplayer-cpu-frame:fullscreen,
				#videoplayer-root canvas#videoplayer-cpu-canvas:fullscreen,
				#videoplayer-root video#videoplayer-video:-webkit-full-screen,
				#videoplayer-root img#videoplayer-cpu-frame:-webkit-full-screen,
				#videoplayer-root canvas#videoplayer-cpu-canvas:-webkit-full-screen {
					width: 100vw;
					height: 100vh;
					max-height: none;
					border-radius: 0;
					object-fit: contain;
					background: #000;
				}
				#videoplayer-root .vp-player-wrap:fullscreen,
				#videoplayer-root .vp-player-wrap:-webkit-full-screen {
					width: 100vw;
					height: 100vh;
					padding: 0;
					border-radius: 0;
					background: #000;
				}
				#videoplayer-root .vp-player-wrap:fullscreen img.videoplayer-cpu-frame,
				#videoplayer-root .vp-player-wrap:-webkit-full-screen img.videoplayer-cpu-frame,
				#videoplayer-root .vp-player-wrap:fullscreen canvas.videoplayer-cpu-canvas,
				#videoplayer-root .vp-player-wrap:-webkit-full-screen canvas.videoplayer-cpu-canvas {
					width: 100vw;
					height: 100vh;
					max-height: none;
					border-radius: 0;
				}
				#videoplayer-root .vp-toolbar {
					display: flex;
					flex-wrap: wrap;
					gap: 8px;
					margin: 8px 0;
					align-items: center;
				}
				#videoplayer-root .vp-cpu-progress {
					display: flex;
					flex-wrap: wrap;
					gap: 8px 24px;
					margin: 6px 0;
					font-variant-numeric: tabular-nums;
				}
				#videoplayer-root .vp-path {
					font-family: monospace;
					word-break: break-all;
				}
				#videoplayer-root .vp-file-name,
				#videoplayer-root .vp-file-name > * {
					min-width: 0;
					overflow-wrap: anywhere;
					word-break: break-word;
				}
				#videoplayer-root input.vp-wide {
					width: 100%;
					max-width: 48em;
				}
				#videoplayer-filetable .td {
					vertical-align: middle;
					overflow-wrap: break-word;
				}
				#videoplayer-filetable .tr.placeholder .td { width: 100%; }
				#videoplayer-filetable .vp-col-name { width: 40%; }
				#videoplayer-filetable .vp-col-type { width: 12%; }
				#videoplayer-filetable .vp-col-size { width: 12%; }
				#videoplayer-filetable .vp-col-modified { width: 22%; }
				#videoplayer-filetable .vp-col-action { width: 14%; }
				#videoplayer-root .vp-page-info {
					min-width: 8em;
					text-align: center;
				}
				@media screen and (max-width: 700px) {
					#videoplayer-root .vp-toolbar > .vp-path {
						flex: 1 1 100%;
					}
					#videoplayer-filetable .vp-col-name,
					#videoplayer-filetable .vp-col-type,
					#videoplayer-filetable .vp-col-size,
					#videoplayer-filetable .vp-col-modified,
					#videoplayer-filetable .vp-col-action {
						width: auto;
					}
					#videoplayer-filetable .vp-col-action .btn {
						min-width: 6em;
					}
				}
			`),

			E('h2', {}, _('Video Player')),
			E('div', { class: 'cbi-map-descr' },
				_('Play videos in LuCI using normal browser decoding or experimental CPU rendering on the router.')),

			/* Settings */
			E('h3', {}, _('Settings')),
			E('div', { class: 'cbi-section' }, [
				E('div', { class: 'cbi-section-node' }, [
					E('div', { class: 'cbi-value' }, [
						E('label', {
							class: 'cbi-value-title',
							for: 'vp-render-mode'
						}, _('Rendering mode')),
						E('div', { class: 'cbi-value-field' }, [
							E('select', {
								id: 'vp-render-mode',
								class: 'cbi-input-select',
								disabled: canWriteSettings ? null : 'disabled',
								'aria-describedby': 'vp-render-mode-desc vp-render-mode-status'
							}, [
								E('option', {
									value: 'browser',
									selected: formRenderMode === 'browser' ? 'selected' : null
								}, _('Browser decoding (recommended)')),
								E('option', {
									value: 'router',
									selected: formRenderMode === 'router' ? 'selected' : null
								}, _('Router CPU rendering (experimental, browser fallback)'))
							]),
							E('div', {
								id: 'vp-render-mode-desc',
								class: 'cbi-value-description'
							}, _('Local files only. The router renders synchronized MJPEG video and PCM audio as quickly as it can. The browser waits for a two-minute buffer (or the whole file when shorter), then draws frames on one persistent canvas while normal-pitch audio provides the playback clock. Rendering continues ahead during playback and pauses for a 30-second refill if the buffer runs dry. This mode has no pause or seeking and may heavily load the router. If synchronized buffering is unavailable, the whole player falls back to browser decoding. Remote URLs always use browser decoding.')),
							E('div', {
								id: 'vp-render-mode-status',
								class: rendererAvailable === false
									? 'cbi-value-description alert-message warning'
									: 'cbi-value-description',
								role: 'status'
							}, rendererAvailable === false
								? _('Router CPU rendering is unavailable: %s').format(
									status.renderer_reason || _('FFmpeg capability check failed'))
								: '')
						])
					]),
					E('div', { class: 'cbi-value' }, [
						E('label', {
							class: 'cbi-value-title',
							for: 'vp-router-profile'
						}, _('Router rendering profile')),
						E('div', { class: 'cbi-value-field' }, [
							E('select', {
								id: 'vp-router-profile',
								class: 'cbi-input-select',
								disabled: canWriteSettings ? null : 'disabled',
								'aria-describedby': 'vp-router-profile-desc',
								change: ui.createHandlerFn(self, 'handleRouterProfileChange')
							}, [
								E('option', {
									value: 'fast',
									selected: formRouterProfile === 'fast' ? 'selected' : null
								}, _('Fast — 480×270, JPEG q12 (optimized)')),
								E('option', {
									value: 'quality',
									selected: formRouterProfile === 'quality' ? 'selected' : null
								}, _('Quality — 640×360, JPEG q8'))
							]),
							E('div', {
								id: 'vp-router-profile-desc',
								class: 'cbi-value-description'
							}, _('Fast is the default and is optimized for faster rendering at 480×270 with JPEG q12; it caps output at 8 FPS. Quality uses 640×360 with JPEG q8 and costs substantially more CPU, network bandwidth, and browser memory.'))
						])
					]),
					E('div', { class: 'cbi-value' }, [
						E('label', {
							class: 'cbi-value-title',
							for: 'vp-router-fps'
						}, _('Router output frame rate')),
						E('div', { class: 'cbi-value-field' }, [
							E('select', {
								id: 'vp-router-fps',
								class: 'cbi-input-select',
								disabled: canWriteSettings ? null : 'disabled',
								'aria-describedby': 'vp-router-fps-desc'
							}, CPU_ROUTER_FPS_OPTIONS.map(function (fps) {
								return E('option', {
									value: String(fps),
									selected: formRouterFps === fps ? 'selected' : null,
									disabled: formRouterProfile === 'fast' && fps > 8
										? 'disabled'
										: null
								}, _('%d FPS').format(fps));
							})),
							E('div', {
								id: 'vp-router-fps-desc',
								class: 'cbi-value-description'
							}, _('Used only for router CPU rendering. Fast mode permits 5 or 8 FPS and automatically clamps stale higher settings to 8 FPS. Quality mode permits the full list up to 60 FPS. Higher output rates render more JPEGs and can sharply reduce rendering speed.'))
						])
					]),
					E('div', { class: 'cbi-value' }, [
						E('label', {
							class: 'cbi-value-title',
							for: 'vp-enabled'
						}, _('Enable local streamer')),
						E('div', { class: 'cbi-value-field' }, [
							E('input', {
								id: 'vp-enabled',
								type: 'checkbox',
								checked: formLocalEnabled ? 'checked' : null,
								disabled: canWriteSettings ? null : 'disabled',
								'aria-describedby': 'vp-enabled-desc'
							}),
							E('div', {
								id: 'vp-enabled-desc',
								class: 'cbi-value-description'
							}, _('Controls browsing and streaming of files stored on the router. Remote URLs are controlled separately.'))
						])
					]),
					E('div', { class: 'cbi-value' }, [
						E('label', {
							class: 'cbi-value-title',
							for: 'vp-media-path'
						}, _('Local media directory')),
						E('div', { class: 'cbi-value-field' }, [
							E('input', {
								id: 'vp-media-path',
								type: 'text',
								class: 'cbi-input-text vp-wide',
								value: formMediaPath,
								placeholder: '/mnt/video',
								required: 'required',
								readonly: canWriteSettings ? null : 'readonly',
								'aria-readonly': canWriteSettings ? 'false' : 'true',
								'aria-invalid': 'false',
								'aria-describedby': 'vp-media-path-desc vp-media-path-error'
							}),
							E('div', {
								id: 'vp-media-path-desc',
								class: 'cbi-value-description'
							}, _('Absolute path on the router (USB mount recommended). The filesystem root (/) is not allowed.')),
							E('div', {
								id: 'vp-media-path-error',
								class: 'cbi-value-description',
								role: 'alert',
								'aria-live': 'assertive'
							})
						])
					]),
					E('div', { class: 'cbi-value' }, [
						E('label', {
							class: 'cbi-value-title',
							for: 'vp-allow-remote'
						}, _('Allow remote URLs')),
						E('div', { class: 'cbi-value-field' }, [
							E('input', {
								id: 'vp-allow-remote',
								type: 'checkbox',
								checked: formRemoteAllowed ? 'checked' : null,
								disabled: canWriteSettings ? null : 'disabled',
								'aria-describedby': 'vp-allow-remote-desc'
							}),
							E('div', {
								id: 'vp-allow-remote-desc',
								class: 'cbi-value-description'
							}, _('If disabled, only local files can be played from this page.'))
						])
					]),
					canWriteSettings ? '' : E('div', {
						class: 'cbi-value-description',
						role: 'status'
					}, _('Settings are read-only for the current LuCI account.'))
				])
			]),

			/* Player */
			E('h3', {}, _('Player')),
			E('div', { class: 'cbi-section' }, [
				E('div', { class: 'cbi-section-node' }, [
					E('div', {
						id: 'videoplayer-player-wrap',
						class: 'vp-player-wrap'
					}, [
						E('video', {
							id: 'videoplayer-video',
							controls: 'controls',
							preload: 'metadata',
							playsinline: 'playsinline',
							controlslist: 'nodownload',
							'aria-label': _('Video player'),
							error: function (ev) { self._handleVideoError(ev); },
							ended: function (ev) { self._handleVideoEnded(ev); },
							waiting: function (ev) { self._handleVideoWaiting(ev); },
							playing: function (ev) { self._handleVideoPlaying(ev); },
							volumechange: function (ev) { self._handleVolumeChange(ev); }
						}, _('Your browser does not support HTML5 video.')),
						E('audio', {
							id: 'videoplayer-cpu-audio',
							hidden: 'hidden',
							preload: 'auto',
							'aria-hidden': 'true'
						}),
						E('img', {
							id: 'videoplayer-cpu-frame',
							class: 'videoplayer-cpu-frame',
							hidden: 'hidden',
							'alt': _('Continuous router-rendered video stream')
						}),
						E('canvas', {
							id: 'videoplayer-cpu-canvas',
							class: 'videoplayer-cpu-canvas',
							hidden: 'hidden',
							width: '640',
							height: '360',
							role: 'img',
							'aria-label': _('Buffered router-rendered video')
						})
					]),
					E('div', {
						id: 'videoplayer-nowplaying',
						class: 'cbi-value-description',
						role: 'status',
						'aria-live': 'polite',
						'aria-atomic': 'true'
					}, _('Nothing playing. Choose a local file or enter a remote URL.')),
					E('div', {
						id: 'vp-cpu-progress',
						class: 'vp-cpu-progress cbi-value-description',
						hidden: 'hidden'
					}, [
						E('span', {}, [
							E('strong', {}, _('Rendered time:')), ' ',
							E('span', { id: 'vp-cpu-rendered-time' }, '00:00 / ?')
						]),
						E('span', {}, [
							E('strong', {}, _('Played time:')), ' ',
							E('span', { id: 'vp-cpu-played-time' }, '00:00 / ?')
						]),
						E('span', {}, [
							E('strong', {}, _('Render speed:')), ' ',
							E('span', { id: 'vp-cpu-render-speed' }, _('Measuring…'))
						]),
						E('span', {}, [
							E('strong', {}, _('Buffered ahead:')), ' ',
							E('span', { id: 'vp-cpu-buffered-ahead' }, '00:00')
						])
					]),
					E('div', { class: 'vp-toolbar' }, [
						E('button', {
							type: 'button',
							class: 'btn cbi-button cbi-button-action',
							click: ui.createHandlerFn(self, 'handleStop')
						}, _('Stop')),
						E('button', {
							id: 'vp-mute-btn',
							type: 'button',
							class: 'btn cbi-button',
							'aria-pressed': 'false',
							click: ui.createHandlerFn(self, 'handleMute')
						}, _('Mute')),
						E('button', {
							type: 'button',
							class: 'btn cbi-button',
							click: ui.createHandlerFn(self, 'handleFullscreen')
						}, _('Fullscreen'))
					]),
					E('div', {
						id: 'vp-cpu-player-note',
						class: 'cbi-value-description',
						hidden: 'hidden'
					}, _('Router CPU mode has no pause or seeking. It renders at least two minutes ahead, keeps video and audio on one normal-speed clock, and shows separate rendered and played time counters.'))
				])
			]),

			/* Remote */
			E('h3', {}, _('Remote media')),
			E('div', { class: 'cbi-section' }, [
				E('div', { class: 'cbi-section-node' }, [
					E('div', { class: 'cbi-value' }, [
						E('label', {
							class: 'cbi-value-title',
							for: 'videoplayer-remote-url'
						}, _('Media URL')),
						E('div', { class: 'cbi-value-field' }, [
							E('input', {
								id: 'videoplayer-remote-url',
								type: 'url',
								class: 'cbi-input-text vp-wide',
								placeholder: 'https://example.com/video.mp4',
								disabled: activeRemoteAllowed ? null : 'disabled',
								'aria-invalid': 'false',
								'aria-describedby': 'vp-remote-url-desc vp-remote-url-error',
								keydown: function (ev) {
									if (ev.key === 'Enter' || ev.keyCode === 13) {
										ev.preventDefault();
										self._playRemote();
									}
								}
							}),
							E('div', {
								id: 'vp-remote-url-desc',
								class: 'cbi-value-description'
							}, _('Direct link to MP4/WebM. Remote media is always loaded by the browser, even when Router CPU mode is selected; server policy, codec support, or missing Range support may prevent playback.')),
							E('div', {
								id: 'vp-remote-url-error',
								class: 'cbi-value-description',
								role: 'alert',
								'aria-live': 'assertive'
							})
						])
					]),
					E('div', { class: 'vp-toolbar' }, [
						E('button', {
							id: 'vp-play-remote-btn',
							type: 'button',
							class: 'btn cbi-button cbi-button-apply',
							disabled: activeRemoteAllowed ? null : 'disabled',
							click: function (ev) {
								return self.handlePlayRemote(ev);
							}
						}, _('Play remote URL'))
					])
				])
			]),

			/* Local browser */
			E('h3', {}, _('Local media')),
			E('div', { class: 'cbi-section' }, [
				E('div', { class: 'cbi-section-node' }, [
					E('div', { class: 'vp-toolbar' }, [
						E('strong', {
							id: 'videoplayer-cwd',
							class: 'vp-path',
							tabindex: '-1'
						}, self._formatCwdLabel('')),
						E('button', {
							id: 'vp-root-btn',
							type: 'button',
							class: 'btn cbi-button',
							disabled: activeLocalEnabled ? null : 'disabled',
							click: function (ev) {
								ev.preventDefault();
								return self._browse('', 0, { focusCwd: true });
							}
						}, _('Root')),
						E('button', {
							id: 'vp-refresh-btn',
							type: 'button',
							class: 'btn cbi-button',
							disabled: activeLocalEnabled ? null : 'disabled',
							click: function (ev) {
								ev.preventDefault();
								return self._browse(self._cwd, 0, {
									focusControlId: 'vp-refresh-btn'
								});
							}
						}, _('Refresh'))
					]),
					E('div', {
						id: 'videoplayer-status-line',
						class: 'cbi-value-description',
						role: 'status',
						'aria-live': 'polite',
						'aria-atomic': 'true'
					}, self._mediaStatusText(self._status)),
					E('div', {
						class: 'table',
						id: 'videoplayer-filetable',
						role: 'table',
						'aria-label': _('Local media files'),
						'aria-busy': 'false'
					}, [
						E('div', { class: 'tr table-titles', role: 'row' }, [
							E('div', { class: 'th vp-col-name', role: 'columnheader' }, _('Name')),
							E('div', { class: 'th vp-col-type', role: 'columnheader' }, _('Type')),
							E('div', { class: 'th vp-col-size', role: 'columnheader' }, _('Size')),
							E('div', { class: 'th vp-col-modified', role: 'columnheader' }, _('Modified')),
							E('div', { class: 'th vp-col-action', role: 'columnheader' }, _('Action'))
						])
					]),
					E('div', { class: 'vp-toolbar' }, [
						E('button', {
							id: 'vp-prev-page',
							type: 'button',
							class: 'btn cbi-button',
							disabled: 'disabled',
							'aria-label': _('Previous page of files'),
							click: function (ev) {
								ev.preventDefault();
								return self._browse(
									self._cwd,
									Math.max(0, self._offset - self._limit),
									{ focusControlId: 'vp-prev-page' }
								);
							}
						}, _('Previous')),
						E('span', {
							id: 'vp-page-info',
							class: 'vp-page-info',
							tabindex: '-1',
							role: 'status',
							'aria-live': 'polite',
							'aria-atomic': 'true'
						}, _('Page 1')),
						E('button', {
							id: 'vp-next-page',
							type: 'button',
							class: 'btn cbi-button',
							disabled: 'disabled',
							'aria-label': _('Next page of files'),
							click: function (ev) {
								ev.preventDefault();
								return self._browse(
									self._cwd,
									self._offset + self._limit,
									{ focusControlId: 'vp-next-page' }
								);
							}
						}, _('Next'))
					])
				])
			]),

			E('div', { class: 'cbi-section-descr', style: 'margin-top:1em;' }, [
				E('p', {}, [
					E('strong', {}, _('Notes:')), ' ',
					_('Prefer H.264 + AAC in MP4 for browser mode. Router CPU mode can decode only codecs enabled in the installed OpenWrt FFmpeg build and automatically falls back to browser decoding when FFmpeg cannot start. Store media on USB if possible.')
				])
			])
		]);

		/* Defer initial listing until DOM is attached */
		window.setTimeout(function () {
			self._syncRouterProfileControls();
			self._syncRemoteControls();
			self._updateRendererStatus();
			self._setPlayerSurface('none');
			if (self._canBrowseLocal())
				self._browse('', 0);
			else
				self._renderLocalUnavailable();
		}, 0);

		self._pageHideHandler = function () {
			self.handleStop();
		};
		window.addEventListener('pagehide', self._pageHideHandler);
		self._visibilityHandler = function () {
			self._handleCpuVisibilityChange();
		};
		if (typeof document.addEventListener === 'function')
			document.addEventListener(
				'visibilitychange', self._visibilityHandler
			);

		return root;
	},

	handleRouterProfileChange: function () {
		this._syncRouterProfileControls();
	},

	_syncRouterProfileControls: function () {
		const profileEl = document.getElementById('vp-router-profile');
		const fpsEl = document.getElementById('vp-router-fps');
		const profile = normalizeRouterProfile(
			profileEl ? profileEl.value : this._routerProfile
		);

		if (profileEl)
			profileEl.value = profile;
		if (!fpsEl)
			return;
		if (fpsEl.options) {
			for (let i = 0; i < fpsEl.options.length; i++) {
				const option = fpsEl.options[i];

				option.disabled = profile === 'fast' && Number(option.value) > 8;
			}
		}
		fpsEl.value = String(normalizeRouterFpsForProfile(fpsEl.value, profile));
	},

	handleSave: function () {
		const self = this;
		const enabledEl = document.getElementById('vp-enabled');
		const pathEl = document.getElementById('vp-media-path');
		const remoteEl = document.getElementById('vp-allow-remote');
		const renderModeEl = document.getElementById('vp-render-mode');
		const routerProfileEl = document.getElementById('vp-router-profile');
		const routerFpsEl = document.getElementById('vp-router-fps');
		let path = (pathEl && pathEl.value || '').trim();
		const renderMode = normalizeRenderMode(renderModeEl && renderModeEl.value);
		const routerProfile = normalizeRouterProfile(
			routerProfileEl && routerProfileEl.value
		);
		const routerFps = normalizeRouterFpsForProfile(
			routerFpsEl && routerFpsEl.value,
			routerProfile
		);

		if (!self._canWriteSettings) {
			notify(null, _('Settings are read-only for the current LuCI account.'), 5000, 'warning');
			return Promise.resolve();
		}

		self._clearFieldError(pathEl, 'vp-media-path-error');

		if (renderMode === 'router' && self._rendererAvailable === false) {
			notify(null, E('p', {},
				_('Router CPU rendering is unavailable: %s').format(
					(self._status && self._status.renderer_reason) ||
					_('FFmpeg capability check failed'))),
			7000, 'error');
			return Promise.resolve();
		}

		if (!path || path.charAt(0) !== '/') {
			const message = _('Media path must be an absolute path (start with /).');
			self._setFieldError(pathEl, 'vp-media-path-error', message);
			notify(null, E('p', {}, message), 5000, 'error');
			return Promise.resolve();
		}

		if (/^\/+$/.test(path)) {
			const message = _('The filesystem root (/) cannot be used as the media directory.');
			self._setFieldError(pathEl, 'vp-media-path-error', message);
			notify(null, E('p', {}, message), 5000, 'error');
			return Promise.resolve();
		}

		path = path.replace(/\/+$/, '');
		if (pathEl)
			pathEl.value = path;

		const localEnabled = !!(enabledEl && enabledEl.checked);
		const remoteAllowed = !!(remoteEl && remoteEl.checked);

		uci.set('videoplayer', 'main', 'enabled', localEnabled ? '1' : '0');
		uci.set('videoplayer', 'main', 'media_path', path);
		uci.set('videoplayer', 'main', 'allow_remote', remoteAllowed ? '1' : '0');
		uci.set('videoplayer', 'main', 'render_mode', renderMode);
		uci.set('videoplayer', 'main', 'router_profile', routerProfile);
		uci.set('videoplayer', 'main', 'router_fps', String(routerFps));

		return uci.save().then(function () {
			/* Active player state changes only after LuCI applies and reloads. */
			return true;
		}, function (err) {
			notify(null, E('p', {}, _('Save failed: %s').format(errorText(err))), 7000, 'error');
			return false;
		});
	},

	handleSaveApply: function (ev, mode) {
		return this.handleSave(ev).then(function (saved) {
			if (saved !== true)
				return false;

			/* Use LuCI's native modal, checked apply and rollback protection. */
			ui.changes.apply(mode == '0');
			return true;
		});
	},

	handleReset: function () {
		const enabledEl = document.getElementById('vp-enabled');
		const pathEl = document.getElementById('vp-media-path');
		const remoteEl = document.getElementById('vp-allow-remote');
		const renderModeEl = document.getElementById('vp-render-mode');
		const routerProfileEl = document.getElementById('vp-router-profile');
		const routerFpsEl = document.getElementById('vp-router-fps');
		const stagedEnabled = uci.get('videoplayer', 'main', 'enabled');
		const stagedPath = uci.get('videoplayer', 'main', 'media_path');
		const stagedAllowRemote = uci.get('videoplayer', 'main', 'allow_remote');
		const stagedRenderMode = uci.get('videoplayer', 'main', 'render_mode');
		const stagedRouterProfile = uci.get('videoplayer', 'main', 'router_profile');
		const stagedRouterFps = uci.get('videoplayer', 'main', 'router_fps');
		const stagedProfile = normalizeRouterProfile(
			stagedRouterProfile !== undefined
				? stagedRouterProfile
				: ((this._status && this._status.router_profile) || this._routerProfile)
		);
		const stagedFps = normalizeRouterFpsForProfile(
			stagedRouterFps !== undefined
				? stagedRouterFps
				: ((this._status && this._status.router_fps) || this._routerFps),
			stagedProfile
		);

		if (enabledEl)
			enabledEl.checked = flagOn(
				stagedEnabled !== undefined ? stagedEnabled : this._localEnabled
			);
		if (pathEl)
			pathEl.value = stagedPath !== undefined
				? String(stagedPath)
				: ((this._status && this._status.media_path) || '/mnt/video');
		if (remoteEl)
			remoteEl.checked = flagOn(
				stagedAllowRemote !== undefined
					? stagedAllowRemote
					: this._allowRemote
			);
		if (renderModeEl)
			renderModeEl.value = normalizeRenderMode(
				stagedRenderMode !== undefined ? stagedRenderMode : this._renderMode
			);
		if (routerProfileEl)
			routerProfileEl.value = stagedProfile;
		if (routerFpsEl)
			routerFpsEl.value = String(stagedFps);

		this._clearFieldError(pathEl, 'vp-media-path-error');
		this._syncRouterProfileControls();
		return Promise.resolve();
	},

	handleStop: function () {
		this._stopPlayback();
		this._setNowPlaying(_('Stopped.'));
		return Promise.resolve();
	},

	handleMute: function () {
		const v = document.getElementById('videoplayer-video');
		const button = document.getElementById('vp-mute-btn');

		if (this._currentRenderMode === 'router') {
			const self = this;
			const session = this._cpuSession;
			const audio = session && session.audio;
			const browserAudio = session && session.browserAudio;
			if (audio && audio.active && audio.gain) {
				const suspended = audio.resumeFailed ||
					(!audio.bufferPaused && audio.context && audio.context.state &&
					 audio.context.state !== 'running');
				if (!audio.muted && !suspended) {
					audio.muted = true;
					try {
						audio.gain.gain.setValueAtTime(
							0,
							audio.context.currentTime
						);
					}
					catch (err) {
						audio.gain.gain.value = 0;
					}
					self._syncCpuMuteControl();
					notify(null, _('Muted'), 2000);
					return Promise.resolve();
				}
				if (session.bufferedPlayback && audio.bufferPaused && audio.muted) {
					audio.muted = false;
					try {
						audio.gain.gain.setValueAtTime(
							1, audio.context.currentTime
						);
					}
					catch (err) { audio.gain.gain.value = 1; }
					self._syncCpuMuteControl();
					notify(null, _('Unmuted'), 2000);
					return Promise.resolve(true);
				}

				const resumeAttempt = (Number(audio.resumeAttempt) || 0) + 1;
				let resumeResult;
				audio.resumeAttempt = resumeAttempt;
				if (suspended)
					audio.resumeRebasePending = true;
				try {
					resumeResult = audio.context &&
						typeof audio.context.resume === 'function'
						? audio.context.resume()
						: undefined;
				}
				catch (err) {
					resumeResult = Promise.reject(err);
				}
				return Promise.resolve(resumeResult).then(function () {
					if (!self._isCurrentCpuSession(session) ||
					    session.audio !== audio || !audio.active ||
					    audio.resumeAttempt !== resumeAttempt)
						return false;
					if (audio.context && audio.context.state &&
					    audio.context.state !== 'running')
						throw new Error(_('Audio output is still suspended.'));
					audio.resumeFailed = false;
					audio.muted = false;
					if (suspended && audio.resumeRebasePending &&
					    !session.bufferedPlayback) {
						audio.resumeRebasePending = false;
						self._rebaseCpuAudio(session, audio);
					}
					try {
						audio.gain.gain.setValueAtTime(
							1,
							audio.context.currentTime
						);
					}
					catch (err) {
						audio.gain.gain.value = 1;
					}
					self._syncCpuMuteControl();
					if (session.bufferedPlayback) {
						self._maybeStartCpuBufferedPlayback(session);
						self._scheduleCpuBufferedPresentation(session, 0);
					}
					notify(null, _('Unmuted'), 2000);
					return true;
				}).catch(function (err) {
					if (!self._isCurrentCpuSession(session) ||
					    session.audio !== audio || !audio.active ||
					    audio.resumeAttempt !== resumeAttempt)
						return false;
					audio.resumeFailed = true;
					audio.muted = true;
					try { audio.gain.gain.value = 0; }
					catch (gainError) {}
					self._syncCpuMuteControl();
					notify(null, E('p', {},
						_('The browser blocked audio output: %s')
							.format(errorText(err))),
					5000, 'warning');
					return false;
				});
			}
			if (browserAudio && browserAudio.active &&
			    browserAudio.element) {
				if (!browserAudio.muted && !browserAudio.needsGesture &&
				    (browserAudio.playing || browserAudio.playPending ||
				     browserAudio.syncPaused)) {
					browserAudio.playAttempt =
						(Number(browserAudio.playAttempt) || 0) + 1;
					browserAudio.playPending = false;
					browserAudio.muted = true;
					browserAudio.element.muted = true;
					self._updateCpuAudioPresentation(session);
					notify(null, _('Muted'), 2000);
					return Promise.resolve();
				}
				if (browserAudio.waitingForVideo) {
					notify(
						null,
						session.bufferedPlayback
							? _('Browser audio will start when buffered playback is ready.')
							: _('Browser audio will start with the first video frame.'),
						2000,
						'info'
					);
					return Promise.resolve();
				}
				browserAudio.muted = false;
				browserAudio.needsGesture = false;
				browserAudio.element.muted = false;
				if (browserAudio.syncPaused) {
					self._updateCpuAudioPresentation(session);
					notify(null, _('Unmuted; audio will resume with video.'), 2000);
					return Promise.resolve();
				}
				browserAudio.playPromise = self._playCpuBrowserAudio(
					session, browserAudio, true
				);
				return browserAudio.playPromise.then(function (started) {
					if (started)
						notify(null, _('Unmuted'), 2000);
				});
			}
			if (browserAudio && browserAudio.active &&
			    browserAudio.resolving) {
				notify(null, _('Browser audio is still being prepared.'), 2000, 'info');
				return Promise.resolve();
			}
			{
				notify(null, _('Audio is unavailable for this router-rendered video.'), 3000, 'warning');
				return Promise.resolve();
			}
		}

		if (v) {
			v.muted = !v.muted;
			this._syncMuteControl(v, button);
			notify(null, v.muted ? _('Muted') : _('Unmuted'), 2000);
		}
		return Promise.resolve();
	},

	handleFullscreen: function () {
		const v = document.getElementById('videoplayer-video');
		const wrap = document.getElementById('videoplayer-player-wrap');
		const target = this._currentRenderMode === 'router' ? wrap : v;
		let request;

		if (!target)
			return Promise.resolve();

		try {
			if (document.fullscreenElement || document.webkitFullscreenElement) {
				if (document.exitFullscreen)
					request = document.exitFullscreen();
				else if (document.webkitExitFullscreen)
					request = document.webkitExitFullscreen();
			}
			else if (target.requestFullscreen) {
				request = target.requestFullscreen();
			}
			else if (target.webkitRequestFullscreen) {
				request = target.webkitRequestFullscreen();
			}
			else if (this._currentRenderMode !== 'router' && v.webkitEnterFullscreen) {
				request = v.webkitEnterFullscreen();
			}
			else {
				notify(null, _('Fullscreen is not supported by this browser.'), 4000, 'warning');
			}
		}
		catch (err) {
			notify(null, E('p', {}, _('Fullscreen failed: %s').format(errorText(err))), 5000, 'warning');
			return Promise.resolve();
		}

		if (request && typeof request.catch === 'function') {
			return request.catch(function (err) {
				notify(null, E('p', {}, _('Fullscreen failed: %s').format(errorText(err))), 5000, 'warning');
			});
		}

		return Promise.resolve();
	},

	handlePlayRemote: function (ev) {
		const self = this;
		const button = ev && ev.currentTarget;
		let result;

		if (ev)
			ev.preventDefault();
		if (button) {
			button.disabled = true;
			button.classList.add('spinning');
		}

		/* Invoke synchronously so a direct remote play retains user activation. */
		try {
			result = self._playRemote();
		}
		catch (err) {
			result = Promise.reject(err);
		}

		return Promise.resolve(result).finally(function () {
			if (button)
				button.classList.remove('spinning');
			self._syncRemoteControls();
		});
	},

	_setFieldError: function (input, errorId, message) {
		const errorEl = document.getElementById(errorId);
		if (input) {
			input.setAttribute('aria-invalid', 'true');
			input.focus();
		}
		if (errorEl)
			errorEl.textContent = message;
	},

	_clearFieldError: function (input, errorId) {
		const errorEl = document.getElementById(errorId);
		if (input)
			input.setAttribute('aria-invalid', 'false');
		if (errorEl)
			errorEl.textContent = '';
	},

	_mediaStatusText: function (status) {
		status = status || {};
		const path = status.media_path || '/mnt/video';

		if (!this._localEnabled)
			return _('Local streamer is disabled.');

		if (this._statusLoadError)
			return _('Unable to read local streamer status: %s').format(errorText(this._statusLoadError));

		if (this._mediaPathExplicitlyInvalid(status))
			return _('Media directory is invalid or unsafe: %s').format(path);

		if (status.media_path_exists !== undefined && !flagOn(status.media_path_exists))
			return _('Media directory does not exist: %s — create it or change the path in Settings.').format(path);

		if (status.media_path_readable !== undefined && !flagOn(status.media_path_readable))
			return _('Media directory is not readable: %s').format(path);

		if (status.media_path_exists === undefined || status.media_path_readable === undefined)
			return _('Configured media directory: %s').format(path);

		return _('Browsing files under: %s').format(path);
	},

	_formatCwdLabel: function (cwd) {
		const base = String(
			(this._status && this._status.media_path) || '/mnt/video'
		).replace(/\/+$/, '');
		if (!cwd) return base + '/';
		return base + '/' + cwd;
	},

	_mediaPathExplicitlyInvalid: function (status) {
		status = status || this._status;
		const value = status && status.media_path_valid;
		return value === false || value === 0 || value === '0';
	},

	_canBrowseLocal: function () {
		return this._localEnabled && !this._mediaPathExplicitlyInvalid();
	},

	_syncRemoteControls: function () {
		const input = document.getElementById('videoplayer-remote-url');
		const button = document.getElementById('vp-play-remote-btn');
		if (input)
			input.disabled = !this._allowRemote;
		if (button)
			button.disabled = !this._allowRemote;
	},

	_syncLocalControls: function () {
		const rootButton = document.getElementById('vp-root-btn');
		const refreshButton = document.getElementById('vp-refresh-btn');
		const prevButton = document.getElementById('vp-prev-page');
		const nextButton = document.getElementById('vp-next-page');
		const disabled = !this._canBrowseLocal() || this._browseLoading;

		if (rootButton)
			rootButton.disabled = disabled;
		if (refreshButton)
			refreshButton.disabled = disabled;
		if (prevButton)
			prevButton.disabled = disabled || this._offset <= 0;
		if (nextButton)
			nextButton.disabled = disabled || !this._hasMore;
	},

	_updateRendererStatus: function () {
		const statusEl = document.getElementById('vp-render-mode-status');

		if (!statusEl)
			return;
		statusEl.className = 'cbi-value-description';

		if (this._renderMode === 'router' && !this._canWriteSettings) {
			statusEl.className += ' alert-message warning';
			statusEl.textContent = _('This read-only LuCI account cannot start the router CPU renderer. Local videos will use browser decoding.');
		}
		else if (this._rendererAvailable === false) {
			statusEl.className += ' alert-message warning';
			statusEl.textContent = _('Router CPU rendering is unavailable: %s').format(
				(this._status && this._status.renderer_reason) ||
				_('FFmpeg capability check failed')
			);
		}
		else if (this._rendererAvailable === true && this._renderMode === 'router') {
			statusEl.textContent = this._routerProfile === 'quality'
				? _('The FFmpeg output pipeline is available. Quality profile uses 640×360 JPEG q8 at a target of %d FPS. Synchronized router-decoded PCM is the primary audio path; browser-decoded original audio is the fallback.').format(this._routerFps)
				: _('The FFmpeg output pipeline is available. Fast profile uses optimized 480×270 JPEG q12 at a target of %d FPS. Synchronized router-decoded PCM is the primary audio path; browser-decoded original audio is the fallback.').format(this._routerFps);
		}
		else {
			statusEl.textContent = '';
		}
	},

	_updatePageInfo: function (entryCount, loading) {
		const pageInfo = document.getElementById('vp-page-info');
		if (!pageInfo)
			return;

		if (!this._localEnabled) {
			pageInfo.textContent = _('Local streamer disabled');
			return;
		}

		if (this._mediaPathExplicitlyInvalid()) {
			pageInfo.textContent = _('Media directory invalid');
			return;
		}

		const limit = this._limit > 0 ? this._limit : PAGE_SIZE;
		const page = Math.floor(this._offset / limit) + 1;

		if (loading) {
			pageInfo.textContent = _('Loading page %d…').format(page);
		}
		else if (entryCount > 0) {
			pageInfo.textContent = _('Page %d — items %d–%d').format(
				page,
				this._offset + 1,
				this._offset + entryCount
			);
		}
		else {
			pageInfo.textContent = _('Page %d').format(page);
		}
	},

	_clearFileTable: function (table) {
		while (table && table.children.length > 1)
			table.removeChild(table.lastChild);
	},

	_appendTableMessage: function (table, text, className) {
		const content = className
			? E('span', { class: className }, text)
			: text;

		table.appendChild(E('div', { class: 'tr placeholder', role: 'row' }, [
			E('div', {
				class: 'td',
				role: 'cell',
				'aria-colspan': '5'
			}, content)
		]));
	},

	_restoreBrowseFocus: function (cwdEl, shouldRestore, controlId) {
		let target = null;

		if (!shouldRestore)
			return;

		if (controlId)
			target = document.getElementById(controlId);
		if (!target || target.disabled)
			target = controlId ? document.getElementById('vp-page-info') : cwdEl;
		if (!target || !document.documentElement.contains(target))
			return;

		try {
			target.focus();
		}
		catch (err) {
			/* Old browsers may reject focus() on a detached node. */
		}
	},

	_renderLocalUnavailable: function () {
		const table = document.getElementById('videoplayer-filetable');
		const line = document.getElementById('videoplayer-status-line');
		const message = this._mediaStatusText(this._status);

		this._browseRequestId++;
		this._browseLoading = false;
		this._offset = 0;
		this._hasMore = false;

		if (table) {
			table.setAttribute('aria-busy', 'false');
			this._clearFileTable(table);
			this._appendTableMessage(table, message);
		}
		if (line)
			line.textContent = message;

		this._updatePageInfo(0, false);
		this._syncLocalControls();
	},

	_browse: function (path, offset, options) {
		const self = this;
		const table = document.getElementById('videoplayer-filetable');
		const cwdEl = document.getElementById('videoplayer-cwd');
		const line = document.getElementById('videoplayer-status-line');
		const opts = options || {};

		if (!table)
			return Promise.resolve();

		if (!self._canBrowseLocal()) {
			self._renderLocalUnavailable();
			return Promise.resolve();
		}

		path = String(path || '').replace(/^\/+/, '');
		offset = parseInt(offset, 10);
		if (!isFinite(offset) || offset < 0)
			offset = 0;

		const requestId = ++self._browseRequestId;
		const listMode = self._renderMode === 'router' &&
			self._canWriteSettings &&
			self._rendererAvailable !== false
				? 'router'
				: 'browser';
		const listRequest = listMode === 'router' ? callRendererList : callList;
		const activeElement = document.activeElement;
		const restoreFocus = !!opts.focusCwd || !!opts.focusControlId ||
			!!(activeElement && table.contains(activeElement));

		self._offset = offset;
		self._hasMore = false;
		self._browseLoading = true;
		table.setAttribute('aria-busy', 'true');
		self._clearFileTable(table);
		self._appendTableMessage(table, _('Loading…'));

		if (line)
			line.textContent = _('Loading directory: %s').format(self._formatCwdLabel(path));
		self._updatePageInfo(0, true);
		self._syncLocalControls();

		return listRequest(path, offset, PAGE_SIZE).then(function (res) {
			if (requestId !== self._browseRequestId)
				return;

			res = res || {};
			self._browseLoading = false;
			self._cwd = (res.path != null) ? res.path : (path || '');
			self._offset = parseInt(res.offset, 10);
			if (!isFinite(self._offset) || self._offset < 0)
				self._offset = offset;

			self._limit = parseInt(res.limit, 10);
			if (!isFinite(self._limit) || self._limit <= 0)
				self._limit = PAGE_SIZE;

			self._hasMore = flagOn(res.has_more);
			if (cwdEl)
				cwdEl.textContent = self._formatCwdLabel(self._cwd);

			table.setAttribute('aria-busy', 'false');
			self._clearFileTable(table);

			if (res.error) {
				self._hasMore = false;
				self._appendTableMessage(table, res.error, 'alert-message warning');
				if (line)
					line.textContent = res.error;
				self._updatePageInfo(0, false);
				self._syncLocalControls();
				self._restoreBrowseFocus(cwdEl, restoreFocus, opts.focusControlId);
				return;
			}

			const entries = Array.isArray(res.entries) ? res.entries : [];
			if (!entries.length) {
				self._appendTableMessage(table,
					listMode === 'router'
						? _('No regular files were found in this directory.')
						: _('No supported video files were found in this directory.'));
				if (line)
					line.textContent = _('Directory loaded: %s').format(self._formatCwdLabel(self._cwd));
				self._updatePageInfo(0, false);
				self._syncLocalControls();
				self._restoreBrowseFocus(cwdEl, restoreFocus, opts.focusControlId);
				return;
			}

			entries.forEach(function (ent) {
				const isDir = ent.type === 'dir';
				const name = String(ent.name || '');
				table.appendChild(E('div', { class: 'tr', role: 'row' }, [
					E('div', {
						class: 'td vp-col-name vp-file-name',
						'data-title': _('Name'),
						role: 'cell'
					}, [
						isDir ? E('strong', {}, ent.name) : E('span', {}, ent.name)
					]),
					E('div', {
						class: 'td vp-col-type',
						'data-title': _('Type'),
						role: 'cell'
					},
						isDir ? _('Folder') : _('Video')),
					E('div', {
						class: 'td vp-col-size',
						'data-title': _('Size'),
						role: 'cell'
					},
						isDir ? '—' : formatSize(ent.size)),
					E('div', {
						class: 'td vp-col-modified',
						'data-title': _('Modified'),
						role: 'cell'
					},
						ent.mtime || '—'),
					E('div', {
						class: 'td vp-col-action',
						'data-title': _('Action'),
						role: 'cell'
					}, [
						isDir
							? E('button', {
								type: 'button',
								class: 'btn cbi-button',
								'aria-label': _('Open folder %s').format(name),
								click: ui.createHandlerFn(self, function () {
									const p = self._entryPath(ent);
									return self._browse(p, 0, { focusCwd: true });
								})
							}, _('Open'))
							: E('button', {
								type: 'button',
								class: 'btn cbi-button cbi-button-action',
								'aria-label': _('Play video %s').format(name),
								click: ui.createHandlerFn(self, function () {
									return self._playLocal(self._entryPath(ent), ent.name);
								})
							}, _('Play'))
					])
				]));
			});

			if (line)
				line.textContent = _('Browsing files under: %s').format(self._formatCwdLabel(self._cwd));
			const childEntryCount = entries.filter(function (ent) {
				return ent.name !== '..';
			}).length;
			self._updatePageInfo(childEntryCount, false);
			self._syncLocalControls();
			self._restoreBrowseFocus(cwdEl, restoreFocus, opts.focusControlId);
		}).catch(function (err) {
			if (requestId !== self._browseRequestId)
				return;

			self._browseLoading = false;
			self._hasMore = false;
			table.setAttribute('aria-busy', 'false');
			self._clearFileTable(table);

			const message = _('Failed to list directory: %s').format(errorText(err));
			self._appendTableMessage(table, message, 'alert-message error');
			if (line)
				line.textContent = message;
			self._updatePageInfo(0, false);
			self._syncLocalControls();
			self._restoreBrowseFocus(cwdEl, restoreFocus, opts.focusControlId);
		});
	},

	_setNowPlaying: function (text) {
		const np = document.getElementById('videoplayer-nowplaying');
		if (np) np.textContent = text;
	},

	/* Build relative path for a list entry (defensive: path/name/cwd). */
	_entryPath: function (ent) {
		if (!ent) return '';
		if (ent.path != null && String(ent.path).length)
			return String(ent.path).replace(/^\/+/, '');
		if (ent.name === '..')
			return this._cwd ? this._cwd.replace(/\/?[^/]+$/, '') : '';
		if (ent.name) {
			if (this._cwd)
				return this._cwd + '/' + ent.name;
			return String(ent.name);
		}
		return '';
	},

	_clearVideoElement: function () {
		const video = document.getElementById('videoplayer-video');

		if (!video)
			return;

		video.pause();
		video.removeAttribute('src');
		video.load();
	},

	_createCpuAudio: function () {
		const AudioContextClass = window.AudioContext || window.webkitAudioContext;
		const self = this;
		let context, gain, resumeResult, audio;

		if (typeof AudioContextClass !== 'function')
			return null;
		try {
			context = new AudioContextClass();
			gain = context.createGain();
			gain.gain.value = 1;
			gain.connect(context.destination);
			const unlock = context.createBufferSource();
			unlock.buffer = context.createBuffer(1, 1, context.sampleRate);
			unlock.connect(gain);
			unlock.start(0);
			audio = {
				active: true,
				context: context,
				gain: gain,
				muted: false,
				resumeFailed: false,
				resumeAttempt: 0,
				resumeRebasePending: !!context.state &&
					context.state !== 'running',
				bufferPaused: false,
				suspendGeneration: 0,
				suspendPromise: null,
				resumePromise: null,
				pollGeneration: 0,
				timer: null,
				inFlight: false,
				inFlightGeneration: null,
				sequence: null,
				startedAt: Date.now(),
				hasDecoded: false,
				ended: false,
				nextPlayTime: 0,
				errors: 0,
				missingSynchronizedChunks: 0,
				videoHeld: false,
				warned: false,
				sources: []
			};
			context.onstatechange = function () {
				const session = self._cpuSession &&
					self._cpuSession.audio === audio
					? self._cpuSession
					: null;

				if (!audio.active)
					return;
				if (session && session.bufferedPlayback) {
					if (context.state === 'closed') {
						self._disableCpuAudio(
							session,
							_('The browser closed the router-decoded PCM output.')
						);
						return;
					}
					audio.resumeFailed = !audio.bufferPaused && !!context.state &&
						context.state !== 'running';
					if (context.state === 'running') {
						audio.resumeRebasePending = false;
						self._maybeStartCpuBufferedPlayback(session);
						self._scheduleCpuBufferedPresentation(session, 0);
					}
					self._updateCpuAudioPresentation(session);
					return;
				}
				audio.resumeFailed = !!context.state &&
					context.state !== 'running';
				if (audio.resumeFailed) {
					audio.resumeRebasePending = true;
				}
				else if (context.state === 'running' &&
				         audio.resumeRebasePending) {
					audio.resumeRebasePending = false;
					if (session && !session.finishing)
						self._rebaseCpuAudio(session, audio);
				}
				if (session)
					self._updateCpuAudioPresentation(session);
			};
			/* This runs synchronously from the Play click, before the RPC
			 * promise, so browser autoplay policy can unlock the context. */
			const resumeAttempt = ++audio.resumeAttempt;
			resumeResult = context.resume();
			if (resumeResult && typeof resumeResult.then === 'function') {
				resumeResult.then(function () {
					if (!audio.active || audio.resumeAttempt !== resumeAttempt)
						return;
					audio.resumeFailed = !!context.state &&
						context.state !== 'running';
					if (self._cpuSession &&
					    self._cpuSession.audio === audio)
						self._updateCpuAudioPresentation(self._cpuSession);
				}, function () {
					if (!audio.active || audio.resumeAttempt !== resumeAttempt)
						return;
					audio.resumeFailed = context.state !== 'running';
					if (self._cpuSession &&
					    self._cpuSession.audio === audio)
						self._updateCpuAudioPresentation(self._cpuSession);
				});
			}
		}
		catch (err) {
			if (context && typeof context.close === 'function') {
				try { context.close(); }
				catch (closeError) {}
			}
			return null;
		}

		return audio;
	},

	_disposeCpuAudio: function (audio) {
		if (!audio)
			return;
		audio.active = false;
		if (audio.timer != null)
			window.clearTimeout(audio.timer);
		audio.timer = null;
		audio.inFlight = false;
		audio.inFlightGeneration = null;
		(audio.sources || []).forEach(function (source) {
			try { source.onended = null; source.stop(); }
			catch (err) {}
			try { source.disconnect(); }
			catch (err) {}
		});
		audio.sources = [];
		if (audio.gain) {
			try { audio.gain.disconnect(); }
			catch (err) {}
		}
		if (audio.context && typeof audio.context.close === 'function') {
			try {
				audio.context.onstatechange = null;
				const result = audio.context.close();
				if (result && typeof result.catch === 'function')
					result.catch(function () {});
			}
			catch (err) {}
		}
	},

	_clearCpuBrowserAudioElement: function (element) {
		element = element || document.getElementById('videoplayer-cpu-audio');
		if (!element)
			return;

		element.onloadedmetadata = null;
		element.onplaying = null;
		element.onpause = null;
		element.onended = null;
		element.onerror = null;
		try { element.pause(); }
		catch (err) {}
		element.muted = false;
		try { element.playbackRate = 1; }
		catch (err) {}
		try { element.removeAttribute('src'); }
		catch (err) { element.src = ''; }
		try { element.load(); }
		catch (err) {}
		if (this._cpuBrowserAudioOwner &&
		    this._cpuBrowserAudioOwner.element === element)
			this._cpuBrowserAudioOwner = null;
	},

	_disposeCpuBrowserAudio: function (browserAudio) {
		if (!browserAudio)
			return;
		browserAudio.active = false;
		browserAudio.resolving = false;
		browserAudio.playing = false;
		browserAudio.ended = true;
		if (browserAudio.syncPauseClearTimer != null)
			window.clearTimeout(browserAudio.syncPauseClearTimer);
		browserAudio.syncPauseClearTimer = null;
		browserAudio.syncPausePending = false;
		browserAudio.playAttempt = (Number(browserAudio.playAttempt) || 0) + 1;
		if (this._cpuBrowserAudioOwner === browserAudio) {
			this._clearCpuBrowserAudioElement(browserAudio.element);
			this._cpuBrowserAudioOwner = null;
		}
		browserAudio.element = null;
	},

	_updateCpuAudioPresentation: function (session) {
		const note = document.getElementById('vp-cpu-player-note');
		const pcm = session && session.audio && session.audio.active
			? session.audio
			: null;
		const pcmSuspended = pcm && (
			pcm.resumeFailed ||
			(pcm.context && pcm.context.state &&
			 pcm.context.state !== 'running')
		);
		const browserAudio = session && session.browserAudio &&
			session.browserAudio.active
			? session.browserAudio
			: null;

		this._syncCpuMuteControl();
		if (session && session.bufferedPlayback) {
			if (note) {
				if (session.bufferState === 'buffering') {
					note.textContent = pcm
						? _('The router is rendering video and PCM audio into a browser buffer. Playback starts after two minutes are ready, or after the whole file is rendered when it is shorter.')
						: (browserAudio
							? _('The router is rendering a two-minute video buffer while the browser prepares the original audio track. Playback starts when the video buffer is ready, or after the whole file is rendered when it is shorter.')
							: _('The router is rendering a two-minute video buffer. Playback starts when it is ready, or after the whole file is rendered when it is shorter.'));
				}
				else if (session.bufferState === 'rebuffering' ||
				         session.bufferState === 'hidden' ||
				         session.bufferState === 'resuming') {
					note.textContent = _('Playback is paused on the last complete canvas frame while the router refills the synchronized buffer. Audio always resumes at normal pitch.');
				}
				else if (pcm) {
					note.textContent = _('Video is drawn on a persistent canvas from router-rendered JPEG frames. Router-decoded PCM audio is the master clock and always plays at normal speed and pitch.');
				}
				else if (browserAudio) {
					note.textContent = _('Video is rendered by the router and drawn on a persistent canvas. The original audio track is played by the browser at normal speed as the master clock.');
				}
				else {
					note.textContent = _('Video is rendered ahead by the router and drawn on a persistent canvas. This file has no usable audio track.');
				}
			}
			return;
		}
		if (note && session) {
			if (pcm) {
				note.textContent = pcmSuspended
					? _('The continuous MJPEG video stream is rendered by the router CPU. PCM audio is ready; press Unmute to allow browser audio output.')
					: _('The continuous MJPEG video stream is rendered by the router CPU. Audio is decoded to PCM by the router and played by this browser.');
			}
			else if (browserAudio) {
				if (browserAudio.resolving || browserAudio.waitingForVideo) {
					note.textContent = _('The continuous MJPEG video stream is rendered by the router CPU. Preparing browser-decoded audio…');
				}
				else {
					note.textContent = browserAudio.needsGesture || browserAudio.muted
						? _('The continuous MJPEG video stream is rendered by the router CPU. Audio is decoded by the browser; press Unmute to enable sound.')
						: _('The continuous MJPEG video stream is rendered by the router CPU while audio is decoded and played by the browser.');
				}
			}
			else if (session.audioFailureReason) {
				note.textContent = _('Audio is unavailable: %s').format(
					session.audioFailureReason
				);
			}
		}
		if (!session || !session.firstFrameSeen ||
		    !this._isCurrentCpuSession(session))
			return;
		if (pcm) {
			this._setNowPlaying(
				_('Router CPU playback: %s (%s profile, target %d FPS, PCM audio)')
					.format(session.label, session.profile || 'fast', session.fps)
			);
		}
		else if (browserAudio) {
			this._setNowPlaying(
				_('Router CPU playback: %s (%s profile, target %d FPS, browser audio)')
					.format(session.label, session.profile || 'fast', session.fps)
			);
		}
		else {
			this._setNowPlaying(
				_('Router CPU playback: %s (%s profile, target %d FPS, silent)')
					.format(session.label, session.profile || 'fast', session.fps)
			);
		}
	},

	_cpuAudioPositionForVideo: function (session) {
		const mediaTime = this._cpuVideoTarget(session);
		let sequence;

		if (!session || session.streamTransportMode !== 'fetch' ||
		    !Number.isFinite(mediaTime))
			return null;
		sequence = Math.max(0, Math.floor(
			mediaTime * 1000 / CPU_AUDIO_CHUNK_MS
		));
		return {
			sequence: sequence,
			offset: Math.min(
				CPU_AUDIO_CHUNK_MS / 1000 - 0.001,
				Math.max(
					0,
					mediaTime - sequence * CPU_AUDIO_CHUNK_MS / 1000
				)
			)
		};
	},

	_cpuAudioSequenceForVideo: function (session) {
		const position = this._cpuAudioPositionForVideo(session);

		return position ? position.sequence : null;
	},

	_cpuAudioOffsetForVideo: function (session, sequence) {
		const position = this._cpuAudioPositionForVideo(session);

		if (!position || position.sequence !== sequence ||
		    !Number.isInteger(sequence) || sequence < 0)
			return 0;
		return position.offset;
	},

	_cpuPcmMediaTime: function (audio) {
		const context = audio && audio.context;
		const now = context && Number(context.currentTime);
		const sources = audio && audio.sources || [];

		if (!Number.isFinite(now))
			return null;
		for (let i = 0; i < sources.length; i++) {
			const source = sources[i];
			const startAt = Number(source.videoplayerStartAt);
			const endAt = Number(source.videoplayerEndAt);
			const mediaStart = Number(source.videoplayerMediaStart);
			const rate = Number(source.videoplayerPlaybackRate);

			if (!Number.isFinite(startAt) || !Number.isFinite(endAt) ||
			    !Number.isFinite(mediaStart) || !Number.isFinite(rate) || rate <= 0)
				continue;
			if (now < startAt)
				return mediaStart;
			if (now <= endAt)
				return mediaStart + (now - startAt) * rate;
		}
		return null;
	},

	_cpuVideoStallMs: function (session) {
		const targetFps = Math.max(1, Number(session && session.fps) || 1);
		const rate = session && Number.isFinite(session.videoPlaybackRate)
			? Math.max(CPU_AV_MIN_ESTIMATED_RATE, session.videoPlaybackRate)
			: 1;
		const effectiveFps = targetFps * rate;

		/* A selected 60 FPS is only the media-time scale. If the router can
		 * actually present one frame per second, a 350 ms timeout would chop PCM
		 * between every pair of valid frames. Allow roughly 2.5 observed frame
		 * intervals, without exceeding the transport's own inactivity window. */
		return Math.min(
			CPU_STREAM_IDLE_TIMEOUT_MS - 1000,
			Math.max(CPU_AV_STALL_MIN_MS, 2500 / effectiveFps)
		);
	},

	_cpuVideoTarget: function (session, now) {
		const mediaTime = session && session.videoMediaTime;
		const frameAt = session && session.videoFrameAt;
		const rate = session && Number.isFinite(session.videoPlaybackRate)
			? session.videoPlaybackRate
			: (session && session.streamTransportMode === 'fetch' ? 0 : 1);
		const stallMs = session
			? this._cpuVideoStallMs(session)
			: CPU_AV_STALL_MIN_MS;

		if (!Number.isFinite(mediaTime) || !Number.isFinite(frameAt))
			return null;
		now = Number.isFinite(now) ? now : cpuMonotonicNow();
		return Math.max(0, mediaTime + Math.min(
			Math.max(0, now - frameAt),
			stallMs
		) * Math.max(0, rate) / 1000);
	},

	_positionCpuBrowserAudio: function (session, browserAudio, force) {
		const element = browserAudio && browserAudio.element;
		const startedAt = session && session.firstFrameAt;
		const offsetReceivedAt = browserAudio &&
			browserAudio.offsetReceivedAt;
		const mediaOffsetMs = browserAudio &&
			browserAudio.mediaOffsetMs;
		const videoTarget = this._cpuVideoTarget(session);
		let target, drift;

		if (!element)
			return;
		if (session && session.bufferedPlayback) {
			try {
				element.defaultPlaybackRate = 1;
				element.playbackRate = 1;
				if ('preservesPitch' in element)
					element.preservesPitch = true;
				if (force)
					element.currentTime = Math.max(
						0, Number(session.playedSeconds) || 0
					);
			}
			catch (err) {}
			return;
		}
		if (Number.isFinite(videoTarget)) {
			target = videoTarget;
		}
		else if (session && session.streamTransportMode === 'fetch') {
			/* The fetch transport starts audio from the first JPEG that was
			 * actually decoded. A server wall-clock offset would reintroduce the
			 * very FIFO/browser backlog that this clock is designed to remove. */
			return;
		}
		else if (Number.isFinite(startedAt)) {
			target = Math.max(
				0,
				(Number.isFinite(session.nativeMediaBase)
					? session.nativeMediaBase
					: 0) +
				(Date.now() - startedAt) / 1000
			);
		}
		else if (Number.isFinite(offsetReceivedAt) &&
		    Number.isFinite(mediaOffsetMs)) {
			target = Math.max(
				0,
				(mediaOffsetMs +
				 Date.now() - offsetReceivedAt) /
					1000
			);
		}
		else {
			return;
		}
		if (Number.isFinite(element.duration) && element.duration > 0)
			target = Math.min(target, Math.max(0, element.duration - 0.05));
		drift = Number(element.currentTime) - target;
		try {
			if (force || !Number.isFinite(element.currentTime) ||
			    Math.abs(drift) > CPU_AV_HARD_DRIFT_SECONDS) {
				element.currentTime = target;
				drift = 0;
			}
			/* Never correct synchronization by resampling sound. Pausing or a
			 * bounded hard seek may be noticeable, but it preserves pitch and is
			 * preferable to changing voices on every transport jitter sample. */
			element.defaultPlaybackRate = 1;
			element.playbackRate = 1;
			if ('preservesPitch' in element)
				element.preservesPitch = true;
		}
		catch (err) {
			/* loadedmetadata retries this for browsers that reject early seeks. */
		}
	},

	_pauseCpuBrowserAudioForSync: function (session, browserAudio) {
		if (!this._isCurrentCpuSession(session) || !browserAudio ||
		    session.browserAudio !== browserAudio || !browserAudio.active ||
		    !browserAudio.element)
			return;
		if (browserAudio.syncPauseClearTimer != null)
			window.clearTimeout(browserAudio.syncPauseClearTimer);
		browserAudio.syncPauseClearTimer = null;
		browserAudio.syncPausePending = true;
		browserAudio.syncPaused = true;
		browserAudio.playAttempt =
			(Number(browserAudio.playAttempt) || 0) + 1;
		browserAudio.playPending = false;
		try { browserAudio.element.pause(); }
		catch (err) {}
		browserAudio.playing = false;
	},

	_scheduleCpuAvSync: function (session, delay) {
		const self = this;

		if (!self._isCurrentCpuSession(session) || session.finishing)
			return;
		if (session.avSyncTimer != null)
			window.clearTimeout(session.avSyncTimer);
		session.avSyncTimer = window.setTimeout(function () {
			session.avSyncTimer = null;
			self._pollCpuAvSync(session);
		}, Math.max(0, Number(delay) || 0));
	},

	_pollCpuAvSync: function (session) {
		const browserAudio = session && session.browserAudio;
		const now = cpuMonotonicNow();
		const stallMs = this._cpuVideoStallMs(session);

		if (!this._isCurrentCpuSession(session) || session.finishing ||
		    session.bufferedPlayback)
			return;
		const videoStalled = Number.isFinite(session.videoFrameAt) &&
			now - session.videoFrameAt >= stallMs;

		if (browserAudio && browserAudio.active && browserAudio.element &&
		    Number.isFinite(session.videoFrameAt)) {
			if (videoStalled) {
				if (!browserAudio.syncPaused &&
				    (browserAudio.playing || browserAudio.playPending)) {
					this._pauseCpuBrowserAudioForSync(session, browserAudio);
				}
			}
			else {
				this._positionCpuBrowserAudio(session, browserAudio, false);
			}
		}
		else if (session.audio && session.audio.active &&
		         Number.isFinite(session.videoMediaTime)) {
			if (videoStalled) {
				const audio = session.audio;

				if (!audio.videoHeld) {
					audio.videoHeld = true;
					audio.pollGeneration =
						(Number(audio.pollGeneration) || 0) + 1;
					if (audio.timer != null)
						window.clearTimeout(audio.timer);
					audio.timer = null;
					audio.inFlight = false;
					audio.inFlightGeneration = null;
					this._resetCpuAudioQueue(audio);
					if (audio.ended)
						this._finishCpuAudioDrain(session, audio);
				}
				this._scheduleCpuAvSync(session, CPU_AV_SYNC_INTERVAL_MS);
				return;
			}
			const pcmTime = this._cpuPcmMediaTime(session.audio);
			const videoTime = this._cpuVideoTarget(session, now);

			if (Number.isFinite(pcmTime) && Number.isFinite(videoTime) &&
			    Math.abs(pcmTime - videoTime) >
				CPU_AV_PCM_REBASE_DRIFT_SECONDS &&
			    (!Number.isFinite(session.audio.lastVideoRebaseAt) ||
			     now - session.audio.lastVideoRebaseAt >=
				CPU_AV_PCM_REBASE_INTERVAL_MS)) {
				session.audio.lastVideoRebaseAt = now;
				this._rebaseCpuAudio(session, session.audio);
			}
		}
		this._scheduleCpuAvSync(session, CPU_AV_SYNC_INTERVAL_MS);
	},

	_activatePendingCpuAudio: function (session) {
		const audio = session && session.pendingAudio;
		let position;

		if (!this._isCurrentCpuSession(session) || session.finishing ||
		    document.hidden || !audio || !audio.active || session.audio)
			return false;
		if (!session.bufferedPlayback && session.streamTransportMode === 'fetch' &&
		    (!Number.isFinite(session.videoMediaTime) ||
		     !Number.isFinite(session.videoPlaybackRate)))
			return false;
		session.pendingAudio = null;
		session.audio = audio;
		audio.startedAt = Date.now();
		if (session.bufferedPlayback) {
			audio.sequence = 0;
			audio.fetchSequence = 0;
			audio.playSequence = null;
			audio.bufferedChunks = Object.create(null);
			audio.bufferedBytes = 0;
			audio.bufferedUntil = 0;
			audio.batchMaxChunks = Math.max(
				1,
				Math.min(
					CPU_AUDIO_BATCH_MAX_CHUNKS,
					Number(session.audioBatchMaxChunks) || 1
				)
			);
			audio.producerEnded = false;
			audio.bufferPaused = false;
			audio.errors = 0;
			audio.ended = false;
			audio.inFlight = false;
			audio.inFlightGeneration = null;
			audio.nextPlayTime = 0;
			audio.sources = [];
			this._scheduleCpuAudioPoll(session, 0);
			this._updateCpuAudioPresentation(session);
			return true;
		}
		position = this._cpuAudioPositionForVideo(session);
		audio.sequence = position ? position.sequence : null;
		audio.startOffsetSequence = audio.sequence;
		audio.startOffsetSeconds = position ? position.offset : 0;
		audio.errors = 0;
		audio.missingSynchronizedChunks = 0;
		audio.ended = false;
		audio.inFlight = false;
		audio.inFlightGeneration = null;
		this._resetCpuAudioQueue(audio);
		this._scheduleCpuAudioPoll(session, 0);
		this._updateCpuAudioPresentation(session);
		return true;
	},

	_failCpuBrowserAudio: function (session, browserAudio, message) {
		let pcmActivated = false;
		let bufferedPosition;

		if (!session || !browserAudio ||
		    session.browserAudio !== browserAudio)
			return;
		if (session.bufferedPlayback &&
		    (session.bufferState === 'playing' ||
		     session.bufferState === 'resuming')) {
			bufferedPosition = this._cpuBufferedPlaybackTime(session);
			session.playedSeconds = bufferedPosition;
			session.playClockMediaBase = bufferedPosition;
			session.playClockContextAt = null;
			if (session.bufferState === 'playing')
				session.playClockWallAt = cpuMonotonicNow();
			else {
				session.playClockWallAt = null;
				session.bufferState = 'rebuffering';
			}
		}
		session.browserAudio = null;
		session.browserAudioFailed = true;
		session.audioFailureReason = String(
			message || _('The browser could not play this audio track.')
		);
		this._disposeCpuBrowserAudio(browserAudio);
		if (!this._isCurrentCpuSession(session))
			return;
		if (session.finishing) {
			const finishing = session.finishing;
			session.finishing = null;
			if (session.finishTimer != null)
				window.clearTimeout(session.finishTimer);
			session.finishTimer = null;
			this._finishCpuPlayback(
				session, finishing.message, finishing.isError, true);
			return;
		}
		if (session.bufferedPlayback && session.pendingAudio) {
			/* A buffered session cannot join fresh sequence-zero PCM to a media
			 * clock that is already in progress. Continue silently instead. */
			const pending = session.pendingAudio;

			session.pendingAudio = null;
			this._disposeCpuAudio(pending);
			this._startCpuAudioDrainer(
				session,
				pending.url,
				Math.max(0, Number(pending.fetchSequence) || 0),
				pending.batchMaxChunks
			);
		}
		else {
			pcmActivated = this._activatePendingCpuAudio(session);
		}
		if (!session.browserAudioWarned) {
			session.browserAudioWarned = true;
			notify(null, E('p', {},
				pcmActivated
					? _('%s Using router-decoded PCM audio instead.')
						.format(session.audioFailureReason)
					: session.audioFailureReason),
			7000, pcmActivated ? 'info' : 'warning');
		}
		this._updateCpuAudioPresentation(session);
		if (session.bufferedPlayback) {
			this._maybeStartCpuBufferedPlayback(session);
			this._scheduleCpuBufferedPresentation(session, 0);
		}
	},

	_playCpuBrowserAudio: function (session, browserAudio, fromGesture) {
		const self = this;
		const element = browserAudio && browserAudio.element;
		const attempt = browserAudio
			? (Number(browserAudio.playAttempt) || 0) + 1
			: 0;
		let playResult;

		if (!self._isCurrentCpuSession(session) || !browserAudio ||
		    session.browserAudio !== browserAudio || !browserAudio.active ||
		    !element)
			return Promise.resolve(false);
		browserAudio.playAttempt = attempt;
		browserAudio.playPending = true;
		self._positionCpuBrowserAudio(session, browserAudio);
		const attemptIsCurrent = function () {
			return self._isCurrentCpuSession(session) &&
				session.browserAudio === browserAudio &&
				browserAudio.active &&
				browserAudio.playAttempt === attempt;
		};
		try {
			playResult = element.play();
		}
		catch (err) {
			playResult = Promise.reject(err);
		}
		return Promise.resolve(playResult).then(function () {
			if (!attemptIsCurrent())
				return false;
			browserAudio.playPending = false;
			browserAudio.playing = true;
			browserAudio.resolving = false;
			if (fromGesture) {
				browserAudio.needsGesture = false;
				browserAudio.muted = false;
				element.muted = false;
			}
			self._updateCpuAudioPresentation(session);
			return true;
		}, function (err) {
			if (!attemptIsCurrent())
				return false;
			browserAudio.playPending = false;
			browserAudio.playing = false;
			browserAudio.needsGesture = true;
			browserAudio.muted = true;
			element.muted = true;
			self._updateCpuAudioPresentation(session);

			if (fromGesture) {
				notify(null, E('p', {},
					_('The browser still blocked audio playback: %s')
						.format(errorText(err))),
				5000, 'warning');
				return false;
			}

			/* Muted media is allowed to start in browsers that block delayed
			 * audible playback. Keeping its clock running lets the user's
			 * later Unmute click enable sound without restarting the video. */
			if (!attemptIsCurrent())
				return false;
			browserAudio.playPending = true;
			try {
				playResult = element.play();
			}
			catch (mutedError) {
				playResult = Promise.reject(mutedError);
			}
			return Promise.resolve(playResult).then(function () {
				if (!attemptIsCurrent())
					return null;
				browserAudio.playPending = false;
				browserAudio.playing = true;
				return true;
			}, function () {
				if (!attemptIsCurrent())
					return null;
				browserAudio.playPending = false;
				browserAudio.playing = false;
				return false;
			}).then(function (mutedStarted) {
				if (attemptIsCurrent() && mutedStarted !== null &&
				    !session.browserAudioPrompted) {
					session.browserAudioPrompted = true;
					notify(null,
						mutedStarted
							? _('Browser audio is ready. Press Unmute to enable sound.')
							: _('Automatic audio playback was blocked. Press Unmute to start it.'),
						5000, mutedStarted ? 'info' : 'warning');
				}
				return false;
			});
		});
	},

	_startCpuBrowserAudioFallback: function (session, message) {
		const self = this;
		let browserAudio;

		if (!self._isCurrentCpuSession(session) || session.finishing)
			return Promise.resolve(false);
		if (session.browserAudio && session.browserAudio.active)
			return session.browserAudio.promise || Promise.resolve(true);

		browserAudio = {
			active: true,
			resolving: true,
			waitingForVideo: false,
			playing: false,
			playPending: false,
			playAttempt: 0,
			playPromise: null,
			ended: false,
			muted: false,
			needsGesture: false,
			syncPaused: false,
			syncPausePending: false,
			syncPauseClearTimer: null,
			mediaOffsetMs: null,
			offsetReceivedAt: null,
			element: null,
			promise: null
		};
		session.browserAudio = browserAudio;
		session.audioFailureReason = String(
			message || _('Router-decoded audio is unavailable.')
		);
		self._updateCpuAudioPresentation(session);

		browserAudio.promise = callResolveAudio(session.token).then(function (res) {
			const url = String(res && res.stream_url || '');
			const element = document.getElementById('videoplayer-cpu-audio');
			const urlMatch = url.match(
				/^\/cgi-bin\/videoplayer-stream\?renderer=([0-9a-f]{32})&audio=([0-9a-f]{32})$/
			);
			const mediaOffsetMs = Number(res && res.media_offset_ms);

			if (!self._isCurrentCpuSession(session) ||
			    session.browserAudio !== browserAudio || !browserAudio.active)
				return false;
			if (!res || res.error)
				throw new Error(String(res && res.error || _('Unable to create an audio stream.')));
			if (normalizeRenderMode(res.render_mode) !== 'browser' ||
			    res.stream_type !== 'html5-video' ||
			    !urlMatch ||
			    urlMatch[1] !== session.token ||
			    urlMatch[2] === session.token ||
			    !Number.isInteger(mediaOffsetMs) ||
			    mediaOffsetMs < 0 ||
			    mediaOffsetMs > CPU_MAX_MEDIA_OFFSET_MS)
				throw new Error(_('The router returned an invalid browser-audio stream.'));
			if (!element || typeof element.play !== 'function')
				throw new Error(_('This browser has no usable audio element.'));

			self._clearCpuBrowserAudioElement(element);
			self._cpuBrowserAudioOwner = browserAudio;
			browserAudio.element = element;
			browserAudio.resolving = false;
			browserAudio.mediaOffsetMs = mediaOffsetMs;
			browserAudio.offsetReceivedAt = Date.now();
			element.preload = 'auto';
			element.muted = false;
			try {
				element.defaultPlaybackRate = 1;
				element.playbackRate = 1;
				if ('preservesPitch' in element)
					element.preservesPitch = true;
			}
			catch (err) {}
			element.onloadedmetadata = function () {
				if (self._isCurrentCpuSession(session) &&
				    session.browserAudio === browserAudio)
					self._positionCpuBrowserAudio(session, browserAudio);
			};
			element.onplaying = function () {
				if (!self._isCurrentCpuSession(session) ||
				    session.browserAudio !== browserAudio)
					return;
				if (browserAudio.syncPaused || document.hidden) {
					self._pauseCpuBrowserAudioForSync(session, browserAudio);
					self._updateCpuAudioPresentation(session);
					return;
				}
				if (browserAudio.syncPausePending) {
					if (browserAudio.syncPauseClearTimer != null)
						window.clearTimeout(browserAudio.syncPauseClearTimer);
					browserAudio.syncPauseClearTimer = window.setTimeout(function () {
						browserAudio.syncPauseClearTimer = null;
						browserAudio.syncPausePending = false;
					}, CPU_AV_SYNC_INTERVAL_MS);
				}
				browserAudio.playing = true;
				self._updateCpuAudioPresentation(session);
			};
			element.onpause = function () {
				if (!self._isCurrentCpuSession(session) ||
				    session.browserAudio !== browserAudio ||
				    browserAudio.ended)
					return;
				if (browserAudio.syncPausePending || browserAudio.syncPaused) {
					browserAudio.syncPausePending = false;
					if (browserAudio.syncPauseClearTimer != null)
						window.clearTimeout(browserAudio.syncPauseClearTimer);
					browserAudio.syncPauseClearTimer = null;
					browserAudio.playing = false;
					self._updateCpuAudioPresentation(session);
					return;
				}
				browserAudio.playAttempt =
					(Number(browserAudio.playAttempt) || 0) + 1;
				browserAudio.playPending = false;
				browserAudio.playing = false;
				browserAudio.needsGesture = true;
				self._updateCpuAudioPresentation(session);
			};
			element.onended = function () {
				if (!self._isCurrentCpuSession(session) ||
				    session.browserAudio !== browserAudio)
					return;
				browserAudio.ended = true;
				browserAudio.playing = false;
				if (session.bufferedPlayback &&
				    session.bufferState === 'playing') {
					session.playedSeconds = Math.max(
						Number(session.playedSeconds) || 0,
						Number(element.currentTime) || 0
					);
					session.playClockMediaBase = session.playedSeconds;
					session.playClockWallAt = cpuMonotonicNow();
				}
				session.browserAudio = null;
				self._disposeCpuBrowserAudio(browserAudio);
				if (session.bufferedPlayback) {
					self._updateCpuAudioPresentation(session);
					self._scheduleCpuBufferedPresentation(session, 0);
					return;
				}
				if (session.finishing) {
					const finishing = session.finishing;
					session.finishing = null;
					if (session.finishTimer != null)
						window.clearTimeout(session.finishTimer);
					session.finishTimer = null;
					self._finishCpuPlayback(
						session, finishing.message, finishing.isError, true);
				}
				else {
					self._updateCpuAudioPresentation(session);
				}
			};
			element.onerror = function () {
				self._failCpuBrowserAudio(
					session,
					browserAudio,
					_('The browser could not decode the audio track; video continues silently.')
				);
			};
			element.src = url;
			try { element.load(); }
			catch (err) {}
			self._positionCpuBrowserAudio(session, browserAudio);
			browserAudio.waitingForVideo = session.bufferedPlayback
				? (document.hidden || session.bufferState === 'buffering' ||
				   session.bufferState === 'rebuffering' ||
				   session.bufferState === 'hidden')
				: (document.hidden || !session.firstFrameSeen ||
				   (session.streamTransportMode === 'fetch' &&
				    !Number.isFinite(session.videoPlaybackRate)));
			self._updateCpuAudioPresentation(session);
			if (session.bufferedPlayback)
				self._maybeStartCpuBufferedPlayback(session);
			if (!browserAudio.waitingForVideo && !browserAudio.playPending &&
			    !browserAudio.playing)
				browserAudio.playPromise = self._playCpuBrowserAudio(
					session, browserAudio, false
				);
			return true;
		}).catch(function (err) {
			if (self._isCurrentCpuSession(session) &&
			    session.browserAudio === browserAudio && browserAudio.active)
				self._failCpuBrowserAudio(
					session,
					browserAudio,
					_('Browser audio fallback failed: %s').format(errorText(err))
				);
			return false;
		});
		return browserAudio.promise;
	},

	_syncCpuMuteControl: function () {
		const button = document.getElementById('vp-mute-btn');
		const session = this._cpuSession;
		const audio = session && session.audio;
		const browserAudio = session && session.browserAudio;

		if (!button)
			return;
		if (audio && audio.active) {
			const suspended = audio.resumeFailed ||
				(!audio.bufferPaused && audio.context && audio.context.state &&
				 audio.context.state !== 'running');
			button.textContent = audio.muted || suspended ? _('Unmute') : _('Mute');
			button.setAttribute(
				'aria-pressed',
				audio.muted || suspended ? 'true' : 'false'
			);
			button.disabled = false;
			button.title = suspended
				? _('Press Unmute to allow browser audio output.')
				: '';
			return;
		}
		if (browserAudio && browserAudio.active) {
			const muted = browserAudio.muted || browserAudio.needsGesture;
			button.textContent = muted ? _('Unmute') : _('Mute');
			button.setAttribute('aria-pressed', muted ? 'true' : 'false');
			button.disabled = browserAudio.resolving ||
				browserAudio.waitingForVideo || !browserAudio.element;
			button.title = browserAudio.resolving
				? _('Preparing browser audio…')
				: (browserAudio.waitingForVideo
					? (session && session.bufferedPlayback
						? _('Browser audio will start when buffered playback is ready.')
						: _('Browser audio will start with the first video frame.'))
					: (muted ? _('Press Unmute to enable browser audio.') : ''));
			return;
		}
		{
			button.textContent = _('Mute');
			button.setAttribute('aria-pressed', 'false');
			button.disabled = true;
			button.title = _('Audio is unavailable for this router-rendered video.');
		}
	},

	_disposeCpuAudioDrainer: function (drainer) {
		if (!drainer)
			return;
		drainer.active = false;
		drainer.generation = (Number(drainer.generation) || 0) + 1;
		if (drainer.timer != null)
			window.clearTimeout(drainer.timer);
		drainer.timer = null;
		drainer.inFlight = false;
	},

	_scheduleCpuAudioDrainPoll: function (session, delay) {
		const self = this;
		const drainer = session && session.audioDrainer;

		if (!self._isCurrentCpuSession(session) || !drainer ||
		    !drainer.active || drainer.producerEnded)
			return;
		if (drainer.timer != null)
			window.clearTimeout(drainer.timer);
		drainer.timer = window.setTimeout(function () {
			drainer.timer = null;
			self._pollCpuAudioDrainer(session);
		}, Math.max(0, Number(delay) || 0));
	},

	_startCpuAudioDrainer: function (session, url, sequence, batchMaxChunks) {
		if (!this._isCurrentCpuSession(session) || !session.bufferedPlayback ||
		    !url)
			return false;
		if (session.audioDrainer && session.audioDrainer.active)
			return true;
		const drainer = {
			active: true,
			url: url,
			fetchSequence: Math.max(0, Number(sequence) || 0),
			batchMaxChunks: Math.max(
				1, Math.min(
					CPU_AUDIO_BATCH_MAX_CHUNKS,
					Number(batchMaxChunks) || 1
				)
			),
			generation: 0,
			timer: null,
			inFlight: false,
			producerEnded: false,
			errors: 0,
			busyStartedAt: null
		};
		session.audioDrainer = drainer;
		this._scheduleCpuAudioDrainPoll(session, 0);
		return true;
	},

	_pollCpuAudioDrainer: function (session) {
		const self = this;
		const drainer = session && session.audioDrainer;
		const generation = drainer ? Number(drainer.generation) || 0 : 0;
		const sequence = drainer && Number(drainer.fetchSequence);
		const count = drainer
			? Math.max(1, Math.min(
				CPU_AUDIO_BATCH_MAX_CHUNKS,
				Number(drainer.batchMaxChunks) || 1
			))
			: 1;

		if (!self._isCurrentCpuSession(session) || !drainer ||
		    !drainer.active || drainer.producerEnded || drainer.inFlight)
			return Promise.resolve();
		if (!Number.isSafeInteger(sequence) || sequence < 0) {
			self._failCpuBufferedPlayback(
				session, _('The router PCM acknowledgement cursor is invalid.')
			);
			return Promise.resolve();
		}
		drainer.inFlight = true;
		return request.get(drainer.url, {
			responseType: 'blob',
			timeout: CPU_AUDIO_REQUEST_TIMEOUT_MS,
			cache: true,
			query: { chunk: String(sequence), count: String(count) }
		}).then(function (res) {
			if (!self._isCurrentCpuSession(session) ||
			    session.audioDrainer !== drainer || !drainer.active ||
			    drainer.generation !== generation)
				return { done: true };
			if (res.status === 202) {
				drainer.busyStartedAt = null;
				drainer.errors = 0;
				return {
					retry: true,
					delay: self._nextCpuAudioNotReadyDelay(drainer)
				};
			}
			if (res.status === 204) {
				drainer.busyStartedAt = null;
				drainer.notReadyDelay = null;
				drainer.producerEnded = true;
				drainer.active = false;
				return { done: true };
			}
			if (res.status === 409 && String(
				res.headers && res.headers.get('X-Videoplayer-Audio-State') || ''
			).toLowerCase() === 'unavailable') {
				drainer.busyStartedAt = null;
				drainer.notReadyDelay = null;
				/* This authenticated state is emitted only after the worker has
				 * replaced the failed PCM chunker with its own direct FIFO sink. */
				drainer.producerEnded = true;
				drainer.active = false;
				return { done: true };
			}
			if (res.status === 409) {
				drainer.notReadyDelay = null;
				const now = Date.now();

				if (!Number.isFinite(drainer.busyStartedAt))
					drainer.busyStartedAt = now;
				/* A disposed Web Audio request cannot always be aborted. Its
				 * download may still own audio.lock when the discard drainer
				 * starts, so generic lock-busy 409s remain retryable for longer
				 * than that request's complete timeout. Persistent 409 still
				 * fails closed after this bounded overlap window. */
				if (now - drainer.busyStartedAt < CPU_AUDIO_BUSY_RETRY_MS) {
					drainer.errors = 0;
					return { retry: true, delay: 100 };
				}
				throw new Error(_('The router PCM acknowledgement stream remained busy.'));
			}
			if (res.status === 404 || res.status === 410)
				throw new Error(_('The router PCM acknowledgement stream lost its next chunk.'));
			if (!res.ok || res.status !== 200)
				throw new Error(
					_('Audio drain request failed with HTTP %d').format(res.status)
				);
			drainer.busyStartedAt = null;
			drainer.notReadyDelay = null;

			const get = function (name) {
				return String(res.headers.get(name) || '');
			};
			const responseSequenceText = get('X-Videoplayer-Audio-Sequence');
			const responseCountText = get('X-Videoplayer-Audio-Chunk-Count') || '1';
			const framesText = get('X-Videoplayer-Audio-Frames-Per-Chunk') ||
				get('X-Videoplayer-Audio-Frames');
			const totalFramesText = get('X-Videoplayer-Audio-Total-Frames');
			const responseSequence = Number(responseSequenceText);
			const responseCount = Number(responseCountText);
			const contentLength = Number(get('Content-Length'));
			if (get('Content-Type').split(';', 1)[0].trim().toLowerCase() !==
					'application/octet-stream' ||
			    get('X-Videoplayer-Audio-Format').toLowerCase() !== 's16le' ||
			    !/^(0|[1-9][0-9]{0,7})$/.test(responseSequenceText) ||
			    responseSequence !== sequence ||
			    !/^[1-2]$/.test(responseCountText) || responseCount > count ||
			    Number(get('X-Videoplayer-Audio-Sample-Rate')) !==
				CPU_AUDIO_SAMPLE_RATE ||
			    Number(get('X-Videoplayer-Audio-Channels')) !==
				CPU_AUDIO_CHANNELS ||
			    Number(framesText) !== CPU_AUDIO_FRAMES_PER_CHUNK ||
			    Number(totalFramesText) !==
				responseCount * CPU_AUDIO_FRAMES_PER_CHUNK ||
			    contentLength !== responseCount * CPU_AUDIO_CHUNK_BYTES)
				throw new Error(_('The router returned invalid PCM drain metadata.'));
			const blob = res.blob();
			if (!blob || blob.size !== contentLength)
				throw new Error(_('The router returned an invalid PCM drain batch.'));
			return blobToArrayBuffer(blob).then(function (arrayBuffer) {
				if (!(arrayBuffer instanceof ArrayBuffer) ||
				    arrayBuffer.byteLength !== contentLength)
					throw new Error(_('The router returned an invalid PCM drain batch.'));
				if (!self._isCurrentCpuSession(session) ||
				    session.audioDrainer !== drainer || !drainer.active ||
				    drainer.generation !== generation)
					return { done: true };
				drainer.fetchSequence += responseCount;
				drainer.errors = 0;
				return { retry: true, delay: 0 };
			});
		}).then(function (result) {
			if (!result || result.done ||
			    !self._isCurrentCpuSession(session) ||
			    session.audioDrainer !== drainer || !drainer.active ||
			    drainer.generation !== generation)
				return;
			self._scheduleCpuAudioDrainPoll(session, result.delay || 0);
		}).catch(function (err) {
			if (!self._isCurrentCpuSession(session) ||
			    session.audioDrainer !== drainer || !drainer.active ||
			    drainer.generation !== generation)
				return;
			drainer.errors++;
			if (drainer.errors < 3) {
				self._scheduleCpuAudioDrainPoll(
					session, Math.min(1000, 100 * Math.pow(2, drainer.errors))
				);
				return;
			}
			self._failCpuBufferedPlayback(
				session,
				_('Unable to acknowledge router PCM while browser audio is active: %s')
					.format(errorText(err))
			);
		}).finally(function () {
			drainer.inFlight = false;
		});
	},

	_disableCpuAudio: function (session, message, backendDraining) {
		const audio = session && session.audio;
		const finishing = session && session.finishing;
		let bufferedPosition;

		if (!audio)
			return Promise.resolve(false);
		if (session.bufferedPlayback) {
			bufferedPosition = this._cpuBufferedPlaybackTime(session);
			session.playedSeconds = bufferedPosition;
			session.playClockMediaBase = bufferedPosition;
			session.playClockContextAt = null;
			session.playClockWallAt = null;
			if (session.bufferState === 'playing' ||
			    session.bufferState === 'resuming')
				session.bufferState = 'rebuffering';
		}
		session.audio = null;
		this._disposeCpuAudio(audio);
		if (session.bufferedPlayback && !backendDraining)
			this._startCpuAudioDrainer(
				session,
				audio.url,
				Math.max(0, Number(audio.fetchSequence) || 0),
				audio.batchMaxChunks
			);
		session.audioFailureReason = String(
			message || _('Router-decoded PCM audio is unavailable.')
		);
		if (this._isCurrentCpuSession(session)) {
			if (finishing) {
				if (session.finishTimer != null)
					window.clearTimeout(session.finishTimer);
				session.finishTimer = null;
				session.finishing = null;
				this._finishCpuPlayback(
					session, finishing.message, finishing.isError, true);
				return Promise.resolve(false);
			}
			if (message && !session.audioWarned) {
				session.audioWarned = true;
				notify(null, E('p', {}, message), 5000, 'warning');
			}
			if (!session.browserAudioFailed)
				return this._startCpuBrowserAudioFallback(
					session, session.audioFailureReason
				);
			this._updateCpuAudioPresentation(session);
		}
		return Promise.resolve(false);
	},

	_finishCpuAudioDrain: function (session, audio) {
		if (!session || !audio || session.audio !== audio ||
		    !audio.ended || (audio.sources || []).length)
			return;

		session.audio = null;
		this._disposeCpuAudio(audio);
		if (!this._isCurrentCpuSession(session))
			return;

		if (session.finishing) {
			const finishing = session.finishing;
			if (session.finishTimer != null)
				window.clearTimeout(session.finishTimer);
			session.finishTimer = null;
			session.finishing = null;
			this._finishCpuPlayback(
				session, finishing.message, finishing.isError, true);
			return;
		}

		this._updateCpuAudioPresentation(session);
	},

	_endCpuAudioGracefully: function (session) {
		const audio = session && session.audio;

		if (!audio)
			return;
		audio.ended = true;
		if (audio.timer != null)
			window.clearTimeout(audio.timer);
		audio.timer = null;
		this._finishCpuAudioDrain(session, audio);
	},

	_handleCpuVisibilityChange: function () {
		const session = this._cpuSession;
		const now = Date.now();
		let hiddenFor = 0;

		if (!this._isCurrentCpuSession(session) || session.finishing)
			return;
		if (session.bufferedPlayback) {
			if (document.hidden) {
				session.streamHiddenAt = now;
				session.bufferHidden = true;
				if (session.bufferState === 'playing' ||
				    session.bufferState === 'resuming')
					this._enterCpuBufferedRebuffer(session, true);
				return;
			}
			session.streamHiddenAt = null;
			session.bufferHidden = false;
			if (session.pendingAudio && !session.audio)
				this._activatePendingCpuAudio(session);
			if (session.bufferState === 'hidden')
				session.bufferState = 'rebuffering';
			this._maybeStartCpuBufferedPlayback(session);
			this._scheduleCpuBufferedPresentation(session, 0);
			this._scheduleCpuStreamStatus(session, 0);
			if (!session.producerEnded && !session.streamPending &&
			    (!session.streamVisibleAttempt ||
			     session.streamVisibleAttempt.ended))
				this._scheduleCpuStreamReconnect(session, 0);
			return;
		}
		if (document.hidden) {
			session.streamHiddenAt = now;
			if (session.audio && session.audio.active &&
			    !session.audio.videoHeld) {
				session.audio.videoHeld = true;
				session.audio.pollGeneration =
					(Number(session.audio.pollGeneration) || 0) + 1;
				if (session.audio.timer != null)
					window.clearTimeout(session.audio.timer);
				session.audio.timer = null;
				session.audio.inFlight = false;
				session.audio.inFlightGeneration = null;
				this._resetCpuAudioQueue(session.audio);
				if (session.audio.ended)
					this._finishCpuAudioDrain(session, session.audio);
			}
			if (session.browserAudio && session.browserAudio.active &&
			    (session.browserAudio.playing ||
			     session.browserAudio.playPending)) {
				this._pauseCpuBrowserAudioForSync(
					session, session.browserAudio
				);
			}
			return;
		}
		if (Number.isFinite(session.streamHiddenAt))
			hiddenFor = Math.max(0, now - session.streamHiddenAt);
		session.streamHiddenAt = null;
		this._scheduleCpuStreamStatus(session, 0);
		if (session.pendingAudio &&
		    Number.isFinite(session.videoPlaybackRate) &&
		    Number.isFinite(session.videoFrameAt) &&
		    cpuMonotonicNow() - session.videoFrameAt <
			this._cpuVideoStallMs(session)) {
			this._activatePendingCpuAudio(session);
		}
		if (session.audio && session.audio.active) {
			if (session.audio.videoHeld &&
			    Number.isFinite(session.videoFrameAt) &&
			    cpuMonotonicNow() - session.videoFrameAt <
				this._cpuVideoStallMs(session)) {
				session.audio.videoHeld = false;
				this._rebaseCpuAudio(session, session.audio);
			}
			else if (!session.audio.videoHeld &&
			         hiddenFor > CPU_AV_HIDDEN_HOLD_MS) {
				this._rebaseCpuAudio(session, session.audio);
			}
		}
		if (session.browserAudio && session.browserAudio.active &&
		    (session.browserAudio.syncPaused ||
		     session.browserAudio.waitingForVideo) &&
		    ((session.streamTransportMode === 'native-mjpeg' &&
		      session.firstFrameSeen) ||
		     (Number.isFinite(session.videoFrameAt) &&
		      cpuMonotonicNow() - session.videoFrameAt <
			this._cpuVideoStallMs(session)))) {
			this._positionCpuBrowserAudio(
				session, session.browserAudio, true
			);
			session.browserAudio.waitingForVideo = false;
			session.browserAudio.syncPaused = false;
			session.browserAudio.playPromise = this._playCpuBrowserAudio(
				session, session.browserAudio, false
			);
		}
		if (session.streamTransportMode === 'fetch')
			this._scheduleCpuAvSync(session, 0);
		if (!session.streamPending &&
		    (!session.streamVisibleAttempt ||
		     session.streamVisibleAttempt.ended ||
		     (Number.isFinite(session.streamNextHandoffAt) &&
		      now >= session.streamNextHandoffAt)))
			this._scheduleCpuStreamReconnect(session, 0);
	},

	_setPlayerSurface: function (surface) {
		const video = document.getElementById('videoplayer-video');
		const frame = document.getElementById('videoplayer-cpu-frame');
		const canvas = document.getElementById('videoplayer-cpu-canvas');
		const progress = document.getElementById('vp-cpu-progress');
		const note = document.getElementById('vp-cpu-player-note');
		const mute = document.getElementById('vp-mute-btn');
		const showVideo = surface === 'video';
		const showCpu = surface === 'cpu';
		const showBufferedCpu = surface === 'cpu-buffered';

		if (video) {
			video.hidden = !showVideo;
			video.setAttribute('aria-hidden', showVideo ? 'false' : 'true');
		}
		if (frame) {
			frame.hidden = !showCpu;
			frame.setAttribute('aria-hidden', showCpu ? 'false' : 'true');
		}
		if (canvas) {
			canvas.hidden = !showBufferedCpu;
			canvas.setAttribute(
				'aria-hidden', showBufferedCpu ? 'false' : 'true'
			);
		}
		if (progress)
			progress.hidden = !showBufferedCpu;
		if (note)
			note.hidden = !(showCpu || showBufferedCpu);
		if (mute) {
			if (showCpu || showBufferedCpu)
				this._syncCpuMuteControl();
			else {
				mute.disabled = !showVideo;
				mute.title = '';
			}
		}
	},

	_canUseCpuFetchStream: function () {
		return typeof window.fetch === 'function' &&
			typeof window.AbortController === 'function' &&
			typeof window.Blob === 'function' &&
			window.URL &&
			typeof window.URL.createObjectURL === 'function' &&
			typeof window.URL.revokeObjectURL === 'function';
	},

	_canUseCpuBufferedPlayback: function () {
		const canvas = document.getElementById('videoplayer-cpu-canvas');

		if (!this._canUseCpuFetchStream() || !canvas ||
		    typeof canvas.getContext !== 'function')
			return false;
		try { return !!canvas.getContext('2d'); }
		catch (err) { return false; }
	},

	_updateCpuBufferedMetadata: function (session, source) {
		const durationMs = Number(source && source.duration_ms);
		const totalFrames = Number(source && source.total_frames);

		if (!session || !session.bufferedPlayback)
			return;
		if (!session.durationSealed &&
		    Number.isSafeInteger(durationMs) && durationMs > 0)
			session.durationSeconds = durationMs / 1000;
		if (Number.isSafeInteger(totalFrames) && totalFrames > 0)
			session.totalFrames = totalFrames;
		this._updateCpuBufferedCounters(session, true);
	},

	_sealCpuBufferedDuration: function (session) {
		const rendered = Number(session && session.renderedSeconds);

		if (!session || !session.bufferedPlayback ||
		    !session.producerEnded || session.videoProducerDrained !== true ||
		    !Number.isFinite(rendered) || rendered <= 0)
			return;
		/* Probe metadata is advisory: malformed media can print FFmpeg-like lines
		 * to stderr. Only a clean, fully drained video transport can establish the
		 * playback end used for gating and completion. */
		session.durationSeconds = rendered;
		session.durationSealed = true;
		this._updateCpuBufferedCounters(session, true);
	},

	_sampleCpuRenderRate: function (session, now) {
		const rendered = Number(session && session.renderedSeconds);
		let elapsedMs, mediaDelta, speed;

		if (!session || !session.bufferedPlayback || session.renderCapacityHeld ||
		    session.producerEnded || !Number.isFinite(rendered) || rendered <= 0)
			return;
		now = Number.isFinite(now) ? now : cpuMonotonicNow();
		if (!Number.isFinite(session.renderRateAnchorAt) ||
		    !Number.isFinite(session.renderRateAnchorSeconds) ||
		    rendered < session.renderRateAnchorSeconds) {
			session.renderRateAnchorAt = now;
			session.renderRateAnchorSeconds = rendered;
			return;
		}
		elapsedMs = now - session.renderRateAnchorAt;
		if (!Number.isFinite(elapsedMs) || elapsedMs < CPU_RENDER_RATE_SAMPLE_MS)
			return;
		mediaDelta = rendered - session.renderRateAnchorSeconds;
		speed = mediaDelta * 1000 / elapsedMs;
		if (Number.isFinite(speed) && speed >= 0) {
			session.renderSpeed = Number.isFinite(session.renderSpeed)
				? session.renderSpeed * 0.6 + speed * 0.4
				: speed;
			session.renderEffectiveFps = session.renderSpeed * Math.max(
				1, Number(session.fps) || 1
			);
		}
		session.renderRateAnchorAt = now;
		session.renderRateAnchorSeconds = rendered;
	},

	_setCpuRenderCapacityHeld: function (session, held) {
		if (!session || !session.bufferedPlayback)
			return;
		held = !!held && !session.producerEnded;
		if (!!session.renderCapacityHeld === held)
			return;
		session.renderCapacityHeld = held;
		session.renderRateAnchorAt = cpuMonotonicNow();
		session.renderRateAnchorSeconds = Math.max(
			0, Number(session.renderedSeconds) || 0
		);
		session.renderSpeed = null;
		session.renderEffectiveFps = null;
		this._updateCpuBufferedCounters(session, true);
	},

	_updateCpuBufferedCounters: function (session, force) {
		const now = cpuMonotonicNow();
		const rendered = document.getElementById('vp-cpu-rendered-time');
		const played = document.getElementById('vp-cpu-played-time');
		const speed = document.getElementById('vp-cpu-render-speed');
		const ahead = document.getElementById('vp-cpu-buffered-ahead');
		const total = Number.isFinite(session && session.durationSeconds)
			? formatCpuDuration(session.durationSeconds)
			: '?';
		let renderedSeconds, playedSeconds, targetFps;

		if (!session || !session.bufferedPlayback)
			return;
		if (!force && Number.isFinite(session.counterUpdatedAt) &&
		    now - session.counterUpdatedAt < CPU_BUFFER_COUNTER_INTERVAL_MS)
			return;
		session.counterUpdatedAt = now;
		this._sampleCpuRenderRate(session, now);
		renderedSeconds = Math.max(0, Number(session.renderedSeconds) || 0);
		playedSeconds = Math.max(0, Number(session.playedSeconds) || 0);
		targetFps = Math.max(1, Number(session.fps) || 1);
		if (session.durationSealed && Number.isFinite(session.durationSeconds)) {
			renderedSeconds = Math.min(renderedSeconds, session.durationSeconds);
			playedSeconds = Math.min(playedSeconds, session.durationSeconds);
		}
		if (rendered)
			rendered.textContent = formatCpuDuration(renderedSeconds) + ' / ' + total;
		if (played)
			played.textContent = formatCpuDuration(playedSeconds) + ' / ' + total;
		if (speed) {
			if (session.renderCapacityHeld && !session.producerEnded) {
				speed.textContent = _('Paused — buffer full (target %d FPS)')
					.format(targetFps);
			}
			else if (Number.isFinite(session.renderSpeed) &&
			         Number.isFinite(session.renderEffectiveFps)) {
				speed.textContent = _('%s× real time (%s FPS / %d FPS target)').format(
					session.renderSpeed.toFixed(2),
					session.renderEffectiveFps.toFixed(1),
					targetFps
				);
			}
			else {
				speed.textContent = _('Measuring… (target %d FPS)').format(targetFps);
			}
		}
		if (ahead)
			ahead.textContent = formatCpuDuration(this._cpuBufferedAhead(session));
	},

	_cpuBufferedAvailableUntil: function (session) {
		let available = Math.max(0, Number(session && session.renderedSeconds) || 0);
		const audio = session && session.audio;

		if (audio && audio.active && !audio.producerEnded)
			available = Math.min(
				available,
				Math.max(0, Number(audio.bufferedUntil) || 0)
			);
		return available;
	},

	_cpuBufferedAhead: function (session) {
		return Math.max(
			0,
			this._cpuBufferedAvailableUntil(session) -
				Math.max(0, Number(session && session.playedSeconds) || 0)
		);
	},

	_cpuBufferedBytes: function (session) {
		const audio = session && session.audio;

		return Math.max(0, Number(session && session.videoBufferBytes) || 0) +
			Math.max(0, Number(session && session.videoDecodeBytes) || 0) +
			Math.max(0, Number(audio && audio.bufferedBytes) || 0);
	},

	_waitForCpuBufferedCapacity: function (session, attempt) {
		/* Never leave an already-dispatched CGI body unread: uhttpd has its own
		 * absolute script timeout, and killing a relay behind buffered socket data
		 * loses the exact frame clock. Capacity is enforced between clean bounded
		 * responses by _openCpuStream(); this promise remains for the parser pump's
		 * single control path. */
		if (attempt)
			attempt.backpressured = false;
		return Promise.resolve();
	},

	_cpuBufferedTransportHasCapacity: function (session) {
		const bytes = this._cpuBufferedBytes(session);
		const byteLimit = session && session.bufferState === 'buffering'
			? CPU_BUFFER_HARD_LIMIT_BYTES - CPU_BUFFER_SEGMENT_RESERVE_BYTES
			: CPU_BUFFER_HARD_LIMIT_BYTES * 0.9;

		if (!session || !session.bufferedPlayback || session.producerEnded)
			return true;
		return Math.max(
			0,
			Number(session.renderedSeconds) - Number(session.playedSeconds)
		) < CPU_BUFFER_HIGH_WATER_SECONDS &&
			bytes < byteLimit;
	},

	_cpuInitialBufferCannotProgress: function (session) {
		return !!(session && session.bufferedPlayback &&
			session.bufferState === 'buffering' && !session.producerEnded &&
			Number(session.renderedSeconds) < CPU_BUFFER_INITIAL_SECONDS &&
			this._cpuBufferedBytes(session) >=
				CPU_BUFFER_HARD_LIMIT_BYTES -
				CPU_BUFFER_SEGMENT_RESERVE_BYTES);
	},

	_markCpuBufferedAttemptReady: function (session, attempt) {
		if (!this._isCurrentCpuSession(session) || !session.bufferedPlayback ||
		    attempt.cancelled || attempt.ready)
			return;
		if (session.streamPending !== attempt)
			return;
		attempt.ready = true;
		session.streamPending = null;
		session.streamVisibleAttempt = attempt;
		session.streamOutageStartedAt = null;
		session.streamErrors = 0;
		session.streamWarned = false;
		session.streamFetchErrors = 0;
		session.streamNextHandoffAt =
			attempt.openedAt + session.streamSegmentMs +
			CPU_STREAM_HANDOFF_GRACE_MS;
		if (session.streamRefreshTimer != null)
			window.clearTimeout(session.streamRefreshTimer);
		session.streamRefreshTimer = null;
		/* The frame-aligned CGI relay closes itself between complete JPEG parts.
		 * Never abort or pause a dispatched response at a local watermark: every
		 * active body is drained to its bounded clean close, and capacity gates only
		 * the next request. */
	},

	_acceptCpuBufferedFrame: function (session, attempt, bytes, sequence) {
		const frameBytes = Number(bytes && bytes.byteLength) || 0;
		const frameDuration = 1 / Math.max(1, Number(session && session.fps) || 1);

		if (!this._isCurrentCpuSession(session) || !session.bufferedPlayback ||
		    attempt.cancelled || !frameBytes)
			return;
		if (this._cpuBufferedBytes(session) + frameBytes >
		    CPU_BUFFER_HARD_LIMIT_BYTES) {
			this._failCpuBufferedPlayback(
				session,
				_('The two-minute router render buffer exceeded the 512 MiB browser memory safety limit.')
			);
			return;
		}
		this._markCpuBufferedAttemptReady(session, attempt);
		session.videoFrames.push({
			bytes: bytes,
			sequence: sequence,
			mediaTime: sequence * frameDuration
		});
		session.lastBufferedFrameSequence = Math.max(
			Number(session.lastBufferedFrameSequence) || 0,
			sequence
		);
		session.videoBufferBytes += frameBytes;
		session.renderedSeconds = Math.max(
			Number(session.renderedSeconds) || 0,
			(sequence + 1) * frameDuration
		);
		session.streamLastFrameAt = Date.now();
		this._updateCpuBufferedCounters(session, false);
		this._maybeStartCpuBufferedPlayback(session);
	},

	_invalidateCpuTerminalDrainEvidence: function (session, attempt) {
		if (!session || !attempt || !attempt.terminalDrain ||
		    attempt.terminalCheck || attempt.bodyEndedClean === true)
			return;
		if (session.videoTerminalDrainCandidateId === attempt.streamId)
			session.videoTerminalDrainBodyClean = false;
	},

	_disposeCpuFetchAttempt: function (attempt, session) {
		if (!attempt || attempt.mode !== 'fetch')
			return;
		this._invalidateCpuTerminalDrainEvidence(session, attempt);
		attempt.cancelled = true;
		if (attempt.reader && typeof attempt.reader.cancel === 'function') {
			try {
				const cancelled = attempt.reader.cancel();
				if (cancelled && typeof cancelled.catch === 'function')
					cancelled.catch(function () {});
			}
			catch (err) {}
		}
		attempt.reader = null;
		if (attempt.controller) {
			try { attempt.controller.abort(); }
			catch (err) {}
		}
		attempt.controller = null;
		if (attempt.backpressureTimer != null)
			window.clearTimeout(attempt.backpressureTimer);
		attempt.backpressureTimer = null;
		if (attempt.backpressureResolve)
			attempt.backpressureResolve();
		attempt.backpressureResolve = null;
		if (attempt.decodeInFlight) {
			const decoding = attempt.decodeInFlight;
			decoding.node.onload = null;
			decoding.node.onerror = null;
			try { decoding.node.removeAttribute('src'); }
			catch (err) {}
			try { window.URL.revokeObjectURL(decoding.url); }
			catch (err) {}
		}
		attempt.decodeInFlight = null;
		attempt.queuedFrame = null;
		attempt.multipartBuffer = null;
	},

	_consumeCpuMjpegChunk: function (session, attempt, chunk) {
		const headerEnd = attempt.headerEnd || asciiBytes('\r\n\r\n');
		const boundary = attempt.boundaryMarker;

		if (!this._isCurrentCpuSession(session) || attempt.cancelled ||
		    !(chunk instanceof Uint8Array) || !boundary || !boundary.length)
			return;
		attempt.multipartBuffer = concatBytes(
			attempt.multipartBuffer || new Uint8Array(0),
			chunk
		);

		while (attempt.multipartBuffer.length) {
			let buffer = attempt.multipartBuffer;

			if (attempt.multipartState === 'boundary') {
				const boundaryAt = findBytes(buffer, boundary, 0);
				if (boundaryAt < 0) {
					if (buffer.length > CPU_MJPEG_MAX_HEADER_BYTES)
						throw new Error(_('The router returned an invalid MJPEG boundary.'));
					return;
				}
				if (boundaryAt > CPU_MJPEG_MAX_HEADER_BYTES)
					throw new Error(_('The router returned excessive MJPEG preamble data.'));
				buffer = buffer.slice(boundaryAt + boundary.length);
				attempt.multipartBuffer = buffer;
				attempt.multipartState = 'headers';
				continue;
			}

			if (attempt.multipartState === 'headers') {
				const headerAt = findBytes(buffer, headerEnd, 0);
				let headers, lengthMatch, typeMatch, length;

				if (headerAt < 0) {
					if (buffer.length > CPU_MJPEG_MAX_HEADER_BYTES)
						throw new Error(_('The router returned oversized MJPEG headers.'));
					return;
				}
				if (headerAt > CPU_MJPEG_MAX_HEADER_BYTES)
					throw new Error(_('The router returned oversized MJPEG headers.'));
				headers = bytesToAscii(buffer.slice(0, headerAt));
				lengthMatch = headers.match(/^content-length:\s*([0-9]+)\s*$/im);
				typeMatch = headers.match(/^content-type:\s*image\/jpeg\s*$/im);
				length = lengthMatch ? Number(lengthMatch[1]) : NaN;
				if (!typeMatch || !Number.isSafeInteger(length) || length < 4 ||
				    length > CPU_MJPEG_MAX_FRAME_BYTES)
					throw new Error(_('The router returned invalid MJPEG frame metadata.'));
				attempt.multipartLength = length;
				attempt.multipartBuffer = buffer.slice(
					headerAt + headerEnd.length
				);
				attempt.multipartState = 'body';
				continue;
			}

			if (attempt.multipartState === 'body') {
				const length = attempt.multipartLength;
				if (buffer.length < length + 2)
					return;
				if (buffer[length] !== 13 || buffer[length + 1] !== 10 ||
				    buffer[0] !== 0xff || buffer[1] !== 0xd8 ||
				    buffer[length - 2] !== 0xff || buffer[length - 1] !== 0xd9)
					throw new Error(_('The router returned a damaged MJPEG frame.'));

				const sequence = session.streamFrameSequence++;
				this._queueCpuMjpegFrame(
					session,
					attempt,
					buffer.slice(0, length),
					sequence
				);
				attempt.multipartBuffer = buffer.slice(length + 2);
				attempt.multipartLength = 0;
				attempt.multipartState = 'boundary';
				continue;
			}

			throw new Error(_('The MJPEG parser entered an invalid state.'));
		}
	},

	_queueCpuMjpegFrame: function (session, attempt, bytes, sequence) {
		if (!this._isCurrentCpuSession(session) || attempt.cancelled ||
		    (session.streamPending !== attempt &&
		     session.streamVisibleAttempt !== attempt))
			return;
		if (session.bufferedPlayback) {
			this._acceptCpuBufferedFrame(session, attempt, bytes, sequence);
			return;
		}
		attempt.queuedFrame = { bytes: bytes, sequence: sequence };
		if (!attempt.decodeInFlight)
			this._decodeCpuMjpegFrame(session, attempt);
	},

	_accountCpuMjpegTruncation: function (session, attempt) {
		const buffer = attempt && attempt.multipartBuffer;
		const closing = attempt && attempt.boundaryCloseMarker;
		const cleanClose = attempt && attempt.multipartState === 'boundary' &&
			buffer instanceof Uint8Array && closing instanceof Uint8Array &&
			buffer.length === closing.length &&
			findBytes(buffer, closing, 0) === 0;
		const cleanEof = attempt && attempt.multipartState === 'boundary' &&
			buffer instanceof Uint8Array && (buffer.length === 0 || cleanClose);
		const partialFrame = attempt && (
			attempt.multipartState === 'headers' ||
			attempt.multipartState === 'body' ||
			(attempt.multipartState === 'boundary' &&
			 buffer instanceof Uint8Array && buffer.length > 0 && !cleanClose)
		);

		if (!this._isCurrentCpuSession(session))
			return false;
		if (!partialFrame || attempt.truncationAccounted)
			return !!cleanEof;
		/* The next CGI segment scans to the following multipart boundary, so
		 * exactly one partially consumed frame is discarded on the server too. */
		attempt.truncationAccounted = true;
		session.streamFrameSequence++;
		return false;
	},

	_decodeCpuMjpegFrame: function (session, attempt) {
		const self = this;
		const queued = attempt && attempt.queuedFrame;
		let node, url;

		if (!self._isCurrentCpuSession(session) || !queued ||
		    attempt.cancelled || attempt.decodeInFlight)
			return;
		attempt.queuedFrame = null;
		node = document.createElement('img');
		node.className = 'videoplayer-cpu-frame';
		node.hidden = true;
		node.setAttribute('aria-hidden', 'true');
		node.setAttribute('alt', _('Router-rendered video frame'));
		url = window.URL.createObjectURL(new window.Blob(
			[ queued.bytes ],
			{ type: 'image/jpeg' }
		));
		attempt.decodeInFlight = {
			node: node,
			url: url,
			sequence: queued.sequence
		};
		node.onload = function () {
			const decoding = attempt.decodeInFlight;
			node.onload = null;
			node.onerror = null;
			attempt.decodeInFlight = null;
			try { window.URL.revokeObjectURL(url); }
			catch (err) {}
			if (decoding && decoding.node === node &&
			    self._isCurrentCpuSession(session) && !attempt.cancelled &&
			    Number(node.naturalWidth) > 0) {
				self._presentCpuMjpegFrame(
					session, attempt, node, decoding.sequence
				);
			}
			self._decodeCpuMjpegFrame(session, attempt);
			if (attempt.transportEnded && !attempt.decodeInFlight &&
			    !attempt.queuedFrame)
				self._completeCpuFetchStream(session, attempt);
		};
		node.onerror = function () {
			node.onload = null;
			node.onerror = null;
			attempt.decodeInFlight = null;
			try { window.URL.revokeObjectURL(url); }
			catch (err) {}
			self._decodeCpuMjpegFrame(session, attempt);
			if (attempt.transportEnded && !attempt.decodeInFlight &&
			    !attempt.queuedFrame)
				self._completeCpuFetchStream(session, attempt);
		};
		node.src = url;
	},

	_presentCpuMjpegFrame: function (session, attempt, frame, sequence) {
		const previous = session && session.visibleFrame;
		const parent = previous && previous.parentNode;
		const firstFrame = !session.firstFrameSeen;
		const startingAttempt = !attempt.ready;
		const now = cpuMonotonicNow();
		const frameDuration = 1 / Math.max(1, session.fps);
		let mediaTime, rateWindowMs;

		if (!this._isCurrentCpuSession(session) || attempt.cancelled ||
		    !parent || !frame ||
		    (session.streamPending !== attempt &&
		     session.streamVisibleAttempt !== attempt))
			return;
		/* sequence is global across bounded HTTP segments. It represents the
		 * FFmpeg output timeline, so reconnect wall time must never be added to
		 * it: doing so would accumulate a permanent A/V offset every 45 seconds. */
		mediaTime = Math.max(0, sequence * frameDuration);
		if (!attempt.ready) {
			if (session.streamPending !== attempt)
				return;
			attempt.ready = true;
			session.streamPending = null;
			session.streamVisibleAttempt = attempt;
			session.streamOutageStartedAt = null;
			session.streamErrors = 0;
			session.streamWarned = false;
			if (attempt.mode === 'fetch')
				session.streamFetchErrors = 0;
			session.streamNextHandoffAt =
				attempt.openedAt + session.streamSegmentMs +
				CPU_STREAM_HANDOFF_GRACE_MS;
			if (session.streamRefreshTimer != null)
				window.clearTimeout(session.streamRefreshTimer);
			{
				const self = this;
				session.streamRefreshTimer = window.setTimeout(function () {
					session.streamRefreshTimer = null;
					if (self._isCurrentCpuSession(session) &&
					    !session.finishing &&
					    session.streamVisibleAttempt === attempt &&
					    !session.streamPending)
						self._scheduleCpuStreamReconnect(session, 0);
				}, Math.max(0, session.streamNextHandoffAt - Date.now()));
			}
		}

		if (startingAttempt && Number.isFinite(session.videoMediaTime)) {
			session.videoRateAnchorMedia = mediaTime;
			session.videoRateAnchorAt = now;
		}
		else if (!Number.isFinite(session.videoRateAnchorMedia) ||
		    !Number.isFinite(session.videoRateAnchorAt)) {
			session.videoRateAnchorMedia = mediaTime;
			session.videoRateAnchorAt = now;
		}
		rateWindowMs = Number.isFinite(session.videoPlaybackRate)
			? CPU_AV_RATE_WINDOW_MS
			: Math.max(8, Math.min(100, 500 / Math.max(1, session.fps)));
		if (mediaTime > session.videoRateAnchorMedia &&
		    now - session.videoRateAnchorAt >= rateWindowMs) {
			const observedRate = (mediaTime - session.videoRateAnchorMedia) /
				((now - session.videoRateAnchorAt) / 1000);
			if (Number.isFinite(observedRate) && observedRate > 0) {
				const boundedRate = Math.min(
					1,
					Math.max(CPU_AV_MIN_ESTIMATED_RATE, observedRate)
				);
				/* React immediately when the router slows down so audio is held
				 * before it can race ahead. Smooth only recovery/increases, which
				 * avoids audible rate jumps after one unusually fast frame. */
				session.videoPlaybackRate = Number.isFinite(session.videoPlaybackRate)
					? (boundedRate < session.videoPlaybackRate
						? boundedRate
						: session.videoPlaybackRate * 0.5 + boundedRate * 0.5)
					: boundedRate;
			}
			session.videoRateAnchorMedia = mediaTime;
			session.videoRateAnchorAt = now;
		}
		if (previous !== frame) {
			if (previous.id === 'videoplayer-cpu-frame')
				previous.removeAttribute('id');
			parent.insertBefore(frame, previous.nextSibling || null);
			frame.id = 'videoplayer-cpu-frame';
			frame.hidden = false;
			frame.setAttribute('aria-hidden', 'false');
			session.visibleFrame = frame;
			this._disposeCpuStreamNode(previous, true);
		}
		session.videoMediaTime = mediaTime;
		session.videoFrameAt = now;
		session.streamLastFrameAt = Date.now();
		if (firstFrame) {
			session.firstFrameSeen = true;
			session.firstFrameAt = session.streamLastFrameAt;
		}

		if (session.browserAudio && session.browserAudio.active) {
			const browserAudio = session.browserAudio;
			this._positionCpuBrowserAudio(
				session, browserAudio, firstFrame || browserAudio.syncPaused
			);
			if (!document.hidden &&
			    Number.isFinite(session.videoPlaybackRate) &&
			    (browserAudio.waitingForVideo || browserAudio.syncPaused)) {
				browserAudio.waitingForVideo = false;
				browserAudio.syncPaused = false;
				browserAudio.playPromise = this._playCpuBrowserAudio(
					session, browserAudio, false
				);
			}
		}
		else if (session.pendingAudio &&
		         Number.isFinite(session.videoPlaybackRate)) {
			this._activatePendingCpuAudio(session);
		}
		else if (!document.hidden &&
		         session.audio && session.audio.active &&
		         session.audio.videoHeld &&
		         Number.isFinite(session.videoPlaybackRate)) {
			session.audio.videoHeld = false;
			this._rebaseCpuAudio(session, session.audio);
		}
		this._setPlayerSurface('cpu');
		this._updateCpuAudioPresentation(session);
		this._scheduleCpuAvSync(session, CPU_AV_SYNC_INTERVAL_MS);
		if (attempt.transportEnded && !attempt.decodeInFlight &&
		    !attempt.queuedFrame)
			this._completeCpuFetchStream(session, attempt);
	},

	_cpuBufferedPlaybackTime: function (session) {
		const audio = session && session.audio;
		const browserAudio = session && session.browserAudio;
		let elapsed = 0;

		if (!session || !session.bufferedPlayback)
			return 0;
		if (session.bufferState !== 'playing')
			return Math.max(0, Number(session.playedSeconds) || 0);
		if (audio && audio.active && Number.isFinite(session.playClockContextAt)) {
			elapsed = Math.max(
				0,
				Number(audio.context.currentTime) - session.playClockContextAt
			);
		}
		else if (browserAudio && browserAudio.active && browserAudio.element &&
		         Number.isFinite(Number(browserAudio.element.currentTime))) {
			return Math.max(0, Number(browserAudio.element.currentTime));
		}
		else if (Number.isFinite(session.playClockWallAt)) {
			elapsed = Math.max(
				0,
				(cpuMonotonicNow() - session.playClockWallAt) / 1000
			);
		}
		return Math.max(
			0,
			(Number(session.playClockMediaBase) || 0) + elapsed
		);
	},

	_takeCpuBufferedFrame: function (session, targetSequence) {
		let candidate = null;

		while (session.videoFrameIndex < session.videoFrames.length) {
			const index = session.videoFrameIndex;
			const frame = session.videoFrames[index];

			if (!frame || frame.sequence <= targetSequence) {
				session.videoFrames[index] = null;
				session.videoFrameIndex++;
				if (frame) {
					if (candidate)
						session.videoBufferBytes -= candidate.bytes.byteLength;
					candidate = frame;
				}
				continue;
			}
			break;
		}
		if (session.videoFrameIndex >= 1024 &&
		    session.videoFrameIndex * 2 >= session.videoFrames.length) {
			session.videoFrames.splice(0, session.videoFrameIndex);
			session.videoFrameIndex = 0;
		}
		if (candidate) {
			session.videoBufferBytes = Math.max(
				0,
				session.videoBufferBytes - candidate.bytes.byteLength
			);
			session.videoDecodeBytes += candidate.bytes.byteLength;
		}
		return candidate;
	},

	_decodeCpuBufferedFrame: function (session, targetSequence) {
		const self = this;
		let frame;
		let node, url, generation;
		let settled = false;

		if (session.videoDecodeInFlight || !this._isCurrentCpuSession(session))
			return;
		frame = this._takeCpuBufferedFrame(session, targetSequence);
		if (!frame)
			return;
		try {
			node = document.createElement('img');
			url = window.URL.createObjectURL(new window.Blob(
				[ frame.bytes ], { type: 'image/jpeg' }
			));
		}
		catch (err) {
			session.videoDecodeBytes = Math.max(
				0,
				(Number(session.videoDecodeBytes) || 0) -
					frame.bytes.byteLength
			);
			this._failCpuBufferedPlayback(
				session,
				_('The browser could not prepare a router-rendered frame: %s')
					.format(errorText(err))
			);
			return;
		}
		generation = Number(session.videoDecodeGeneration) || 0;
		session.videoDecodeInFlight = {
			node: node,
			url: url,
			frame: frame,
			generation: generation
		};
		const finish = function (decoded) {
			if (settled)
				return;
			settled = true;
			const inFlight = session.videoDecodeInFlight;
			const byteLength = frame.bytes.byteLength;

			node.onload = null;
			node.onerror = null;
			try { window.URL.revokeObjectURL(url); }
			catch (err) {}
			if (inFlight && inFlight.node === node)
				session.videoDecodeInFlight = null;
			session.videoDecodeBytes = Math.max(
				0,
				(Number(session.videoDecodeBytes) || 0) - byteLength
			);
			if (!decoded || !self._isCurrentCpuSession(session) ||
			    generation !== session.videoDecodeGeneration ||
			    !session.canvasContext || !session.canvas ||
			    Number(node.naturalWidth) <= 0) {
				if (self._isCurrentCpuSession(session)) {
					session.lastDecodeFailureSequence = Math.max(
						Number(session.lastDecodeFailureSequence) || -1,
						frame.sequence
					);
					self._scheduleCpuBufferedPresentation(session, 0);
				}
				return;
			}
			const width = Number(node.naturalWidth) || 640;
			const height = Number(node.naturalHeight) ||
				Math.max(1, Math.round(width * 9 / 16));

			if (session.canvas.width !== width)
				session.canvas.width = width;
			if (session.canvas.height !== height)
				session.canvas.height = height;
			try {
				session.canvasContext.drawImage(
					node, 0, 0, session.canvas.width, session.canvas.height
				);
			}
			catch (err) {
				self._failCpuBufferedPlayback(
					session,
					_('The browser could not draw a router-rendered frame: %s')
						.format(errorText(err))
				);
				return;
			}
			session.displayedSequence = frame.sequence;
			session.videoMediaTime = frame.mediaTime;
			session.videoFrameAt = cpuMonotonicNow();
			if (!session.firstFrameSeen) {
				session.firstFrameSeen = true;
				session.firstFrameAt = Date.now();
				self._updateCpuAudioPresentation(session);
			}
			self._scheduleCpuBufferedPresentation(session, 0);
		};
		try {
			node.onload = function () { finish(true); };
			node.onerror = function () { finish(false); };
			node.src = url;
		}
		catch (err) {
			node.onload = null;
			node.onerror = null;
			if (session.videoDecodeInFlight &&
			    session.videoDecodeInFlight.node === node)
				session.videoDecodeInFlight = null;
			session.videoDecodeBytes = Math.max(
				0,
				(Number(session.videoDecodeBytes) || 0) -
					frame.bytes.byteLength
			);
			try { window.URL.revokeObjectURL(url); }
			catch (revokeError) {}
			this._failCpuBufferedPlayback(
				session,
				_('The browser could not prepare a router-rendered frame: %s')
					.format(errorText(err))
			);
		}
	},

	_scheduleCpuBufferedAudioChunk: function (session, audio, arrayBuffer, sequence) {
		const self = this;
		const context = audio && audio.context;
		let source = null;

		try {
			const data = new DataView(arrayBuffer);
			const buffer = context.createBuffer(
				CPU_AUDIO_CHANNELS,
				CPU_AUDIO_FRAMES_PER_CHUNK,
				CPU_AUDIO_SAMPLE_RATE
			);
			const left = buffer.getChannelData(0);
			const right = buffer.getChannelData(1);

			for (let i = 0; i < CPU_AUDIO_FRAMES_PER_CHUNK; i++) {
				left[i] = data.getInt16(i * 4, true) / 32768;
				right[i] = data.getInt16(i * 4 + 2, true) / 32768;
			}
			source = context.createBufferSource();
			const startAt = audio.nextPlayTime;
			source.buffer = buffer;
			if (source.playbackRate) {
				try {
					if (typeof source.playbackRate.setValueAtTime === 'function')
						source.playbackRate.setValueAtTime(1, startAt);
					else
						source.playbackRate.value = 1;
				}
				catch (err) {}
			}
			source.videoplayerStartAt = startAt;
			source.videoplayerEndAt = startAt + CPU_AUDIO_CHUNK_MS / 1000;
			source.videoplayerMediaStart =
				sequence * CPU_AUDIO_CHUNK_MS / 1000;
			source.videoplayerPlaybackRate = 1;
			source.connect(audio.gain);
			audio.sources.push(source);
			source.onended = function () {
				const index = audio.sources.indexOf(source);
				if (index !== -1)
					audio.sources.splice(index, 1);
				try { source.disconnect(); }
				catch (err) {}
				if (self._isCurrentCpuSession(session))
					self._scheduleCpuBufferedPresentation(session, 0);
			};
			source.start(startAt, 0);
			audio.nextPlayTime = source.videoplayerEndAt;
		}
		catch (err) {
			if (source) {
				const index = audio.sources.indexOf(source);

				source.onended = null;
				if (index !== -1)
					audio.sources.splice(index, 1);
				try { source.stop(); }
				catch (stopError) {}
				try { source.disconnect(); }
				catch (disconnectError) {}
			}
			throw err;
		}
	},

	_fillCpuBufferedAudioQueue: function (session) {
		const audio = session && session.audio;
		const context = audio && audio.context;

		if (!audio || !audio.active || !context ||
		    !Number.isInteger(audio.playSequence))
			return true;
		while (audio.nextPlayTime - Number(context.currentTime) <
		       CPU_AUDIO_MAX_LEAD_SECONDS) {
			const sequence = audio.playSequence;
			const chunk = audio.bufferedChunks[sequence];

			if (!(chunk instanceof ArrayBuffer))
				break;
			try {
				this._scheduleCpuBufferedAudioChunk(
					session, audio, chunk, sequence
				);
			}
			catch (err) {
				this._disableCpuAudio(
					session,
					_('The browser could not schedule router PCM audio: %s')
						.format(errorText(err)),
					false
				);
				return false;
			}
			delete audio.bufferedChunks[sequence];
			audio.bufferedBytes = Math.max(
				0,
				(Number(audio.bufferedBytes) || 0) - chunk.byteLength
			);
			audio.playSequence++;
		}
		return true;
	},

	_pauseCpuBufferedClock: function (session) {
		const self = this;
		const audio = session && session.audio;
		const browserAudio = session && session.browserAudio;
		let suspendGeneration;

		if (audio && audio.active && audio.context) {
			audio.bufferPaused = true;
			suspendGeneration =
				(Number(audio.suspendGeneration) || 0) + 1;
			audio.suspendGeneration = suspendGeneration;
			const suspendNow = function () {
				let result;

				if (!self._isCurrentCpuSession(session) ||
				    session.audio !== audio || !audio.active ||
				    audio.suspendGeneration !== suspendGeneration ||
				    !audio.bufferPaused)
					return false;
				if (audio.context.state !== 'running')
					return true;
				try {
					if (typeof audio.context.suspend !== 'function')
						throw new Error(_('This browser cannot suspend Web Audio safely.'));
					result = audio.context.suspend();
				}
				catch (err) { return Promise.reject(err); }
				return Promise.resolve(result).then(function () { return true; });
			};
			const pendingResume = audio.resumePromise;
			const operation = pendingResume
				? Promise.resolve(pendingResume).then(suspendNow, suspendNow)
				: suspendNow();

			audio.suspendPromise = Promise.resolve(operation).then(function (suspended) {
				return suspended !== false;
			}, function (err) {
				if (self._isCurrentCpuSession(session) &&
				    session.audio === audio && audio.active &&
				    audio.suspendGeneration === suspendGeneration) {
					self._failCpuBufferedPlayback(
						session,
						_('The browser could not pause the synchronized audio clock: %s')
							.format(errorText(err))
					);
				}
				return false;
			});
		}
		if (browserAudio && browserAudio.active && browserAudio.element) {
			browserAudio.syncPaused = true;
			this._pauseCpuBrowserAudioForSync(session, browserAudio);
		}
	},

	_enterCpuBufferedRebuffer: function (session, hidden) {
		if (!this._isCurrentCpuSession(session) || !session.bufferedPlayback ||
		    (session.bufferState !== 'playing' &&
		     session.bufferState !== 'resuming'))
			return;
		session.playedSeconds = this._cpuBufferedPlaybackTime(session);
		session.playClockMediaBase = session.playedSeconds;
		if (session.audio && session.audio.active)
			session.playClockContextAt = Number(
				session.audio.context.currentTime
			);
		session.playClockWallAt = null;
		session.bufferState = hidden ? 'hidden' : 'rebuffering';
		this._pauseCpuBufferedClock(session);
		this._setNowPlaying(
			hidden
				? _('Router CPU playback paused while this tab is hidden: %s')
					.format(session.label)
				: _('Buffering more router-rendered video: %s')
					.format(session.label)
		);
		this._updateCpuBufferedCounters(session, true);
		this._scheduleCpuBufferedPresentation(session, CPU_BUFFER_POLL_MS);
	},

	_resumeCpuBufferedPlayback: function (session) {
		const self = this;
		const audio = session && session.audio;
		const browserAudio = session && session.browserAudio;
		let resumeGeneration;

		if (!self._isCurrentCpuSession(session) || !session.bufferedPlayback ||
		    document.hidden ||
		    (session.bufferState !== 'rebuffering' &&
		     session.bufferState !== 'hidden'))
			return;
		session.bufferState = 'resuming';
		if (audio && audio.active) {
			resumeGeneration =
				(Number(session.bufferResumeGeneration) || 0) + 1;
			session.bufferResumeGeneration = resumeGeneration;
			const resumePromise = Promise.resolve(audio.suspendPromise).then(function (suspended) {
				let resumeResult;

				if (suspended === false ||
				    !self._isCurrentCpuSession(session) ||
				    session.audio !== audio || !audio.active ||
				    session.bufferState !== 'resuming' ||
				    session.bufferResumeGeneration !== resumeGeneration)
					return false;
				if (!self._fillCpuBufferedAudioQueue(session))
					return false;
				audio.bufferPaused = false;
				try {
					resumeResult = audio.context &&
						typeof audio.context.resume === 'function'
						? audio.context.resume()
						: undefined;
				}
				catch (err) {
					resumeResult = Promise.reject(err);
				}
				return Promise.resolve(resumeResult).then(function () {
					return true;
				});
			});
			audio.resumePromise = resumePromise;
			resumePromise.then(function (resumed) {
				if (!resumed || !self._isCurrentCpuSession(session) ||
				    session.audio !== audio || !audio.active ||
				    session.bufferState !== 'resuming' ||
				    session.bufferResumeGeneration !== resumeGeneration)
					return;
				audio.resumeFailed = !!audio.context.state &&
					audio.context.state !== 'running';
				if (audio.resumeFailed) {
					session.bufferState = 'rebuffering';
					self._scheduleCpuBufferedPresentation(
						session, CPU_BUFFER_POLL_MS
					);
					return;
				}
				session.bufferState = 'playing';
				self._updateCpuAudioPresentation(session);
				self._scheduleCpuBufferedPresentation(session, 0);
			}).catch(function () {
				if (!self._isCurrentCpuSession(session) ||
				    session.audio !== audio || !audio.active ||
				    session.bufferResumeGeneration !== resumeGeneration)
					return;
				audio.resumeFailed = true;
				audio.bufferPaused = false;
				session.bufferState = 'rebuffering';
				self._syncCpuMuteControl();
				self._scheduleCpuBufferedPresentation(
					session, CPU_BUFFER_POLL_MS
				);
			}).finally(function () {
				if (audio.resumePromise === resumePromise)
					audio.resumePromise = null;
			});
			return;
		}
		if (browserAudio && browserAudio.active && browserAudio.element) {
			browserAudio.syncPaused = false;
			browserAudio.waitingForVideo = false;
			try {
				browserAudio.element.playbackRate = 1;
				browserAudio.element.currentTime = session.playedSeconds;
			}
			catch (err) {}
			browserAudio.playPromise = self._playCpuBrowserAudio(
				session, browserAudio, false
			);
		}
		else {
			session.playClockWallAt = cpuMonotonicNow();
		}
		session.bufferState = 'playing';
		self._updateCpuAudioPresentation(session);
		self._scheduleCpuBufferedPresentation(session, 0);
	},

	_startCpuBufferedPlayback: function (session) {
		const self = this;
		const audio = session && session.audio;
		const browserAudio = session && session.browserAudio;

		if (!self._isCurrentCpuSession(session) || !session.bufferedPlayback ||
		    session.bufferState !== 'buffering' || document.hidden)
			return;
		if (audio && audio.active && audio.context && audio.context.state &&
		    audio.context.state !== 'running') {
			audio.resumeFailed = true;
			self._syncCpuMuteControl();
			return;
		}
		if (!audio && browserAudio && browserAudio.resolving)
			return;
		session.playedSeconds = 0;
		session.playClockMediaBase = 0;
		session.videoPlaybackRate = 1;
		session.bufferState = 'playing';
		if (audio && audio.active) {
			audio.playSequence = 0;
			audio.nextPlayTime = Number(audio.context.currentTime) +
				CPU_AUDIO_INITIAL_LEAD_SECONDS;
			session.playClockContextAt = audio.nextPlayTime;
			if (!self._fillCpuBufferedAudioQueue(session))
				return;
		}
		else if (browserAudio && browserAudio.active && browserAudio.element) {
			browserAudio.waitingForVideo = false;
			browserAudio.syncPaused = false;
			try {
				browserAudio.element.currentTime = 0;
				browserAudio.element.playbackRate = 1;
			}
			catch (err) {}
			browserAudio.playPromise = self._playCpuBrowserAudio(
				session, browserAudio, false
			);
		}
		else {
			session.playClockWallAt = cpuMonotonicNow();
		}
		self._setPlayerSurface('cpu-buffered');
		self._setNowPlaying(
			_('Playing buffered router CPU render: %s (%s profile, target %d FPS)')
				.format(session.label, session.profile || 'fast', session.fps)
		);
		self._decodeCpuBufferedFrame(session, 0);
		self._updateCpuAudioPresentation(session);
		self._updateCpuBufferedCounters(session, true);
		self._scheduleCpuBufferedPresentation(session, 0);
	},

	_maybeStartCpuBufferedPlayback: function (session) {
		const available = this._cpuBufferedAvailableUntil(session);
		const audio = session && session.audio;
		const browserAudio = session && session.browserAudio;
		const tolerance = Math.max(
			1 / Math.max(1, Number(session && session.fps) || 1),
			CPU_AV_BUFFER_TOLERANCE_SECONDS
		);
		const cleanEof = !!(session && session.producerEnded &&
			session.videoProducerDrained === true &&
			(!audio || audio.producerEnded));
		const terminalPresentationPending = !!(cleanEof && session && (
			session.videoDecodeInFlight ||
			Number(session.videoFrameIndex) <
				Number(session.videoFrames && session.videoFrames.length) ||
			Number(session.displayedSequence) <
				Number(session.lastBufferedFrameSequence)
		));
		let target, gateTolerance;

		if (!this._isCurrentCpuSession(session) || !session.bufferedPlayback)
			return;
		if (session.pendingAudio && !session.audio)
			return;
		if (!audio && browserAudio && browserAudio.resolving)
			return;
		if (audio && audio.active && audio.resumeFailed)
			return;
		if (session.bufferState === 'buffering') {
			/* Never let advisory probe duration shorten the initial gate. A short
			 * file is recognized only after video and audio reach clean EOF. */
			target = cleanEof ? available : CPU_BUFFER_INITIAL_SECONDS;
			gateTolerance = cleanEof ? tolerance : 0;
			if (available > 0 && available + gateTolerance >= target)
				this._startCpuBufferedPlayback(session);
			return;
		}
		if (session.bufferState === 'rebuffering' ||
		    session.bufferState === 'hidden') {
			if (!document.hidden && this._cpuBufferedPlaybackFinished(session)) {
				this._finishCpuPlayback(
					session,
					_('Router CPU playback ended: %s').format(session.label),
					false,
					true
				);
				return;
			}
			if (!document.hidden &&
			    (this._cpuBufferedAhead(session) >=
				CPU_BUFFER_REBUFFER_SECONDS ||
			     (cleanEof &&
			      (terminalPresentationPending ||
			       available > session.playedSeconds + 0.001))))
				this._resumeCpuBufferedPlayback(session);
		}
	},

	_cpuBufferedPlaybackFinished: function (session) {
		const tolerance = Math.min(
			0.001,
			0.1 / Math.max(1, Number(session && session.fps) || 1)
		);
		const renderedEnd = Number(session && session.renderedSeconds);
		const end = renderedEnd;
		const audio = session && session.audio;
		const lastSequence = Number(session && session.lastBufferedFrameSequence);
		const queueExhausted = !!(session &&
			Number(session.videoFrameIndex) >=
				Number(session.videoFrames && session.videoFrames.length));

		return !!(session && session.producerEnded &&
			session.videoProducerDrained === true &&
			(!audio || audio.producerEnded) &&
			Number.isFinite(end) && end > 0 &&
			Number(session.playedSeconds) + tolerance >= end &&
			Number.isSafeInteger(lastSequence) && lastSequence >= 0 &&
			Number(session.displayedSequence) >= lastSequence &&
			!session.videoDecodeInFlight && queueExhausted);
	},

	_pollCpuBufferedPresentation: function (session) {
		const audio = session && session.audio;
		let targetSequence, audioLead, missingAudio;

		if (!this._isCurrentCpuSession(session) || !session.bufferedPlayback)
			return;
		if (session.bufferState === 'playing') {
			session.playedSeconds = this._cpuBufferedPlaybackTime(session);
			if (session.durationSealed &&
			    Number.isFinite(session.durationSeconds))
				session.playedSeconds = Math.min(
					session.playedSeconds, session.durationSeconds
				);
			if (audio && audio.active) {
				if (!this._fillCpuBufferedAudioQueue(session))
					return;
				audioLead = Number(audio.nextPlayTime) -
					Number(audio.context.currentTime);
				missingAudio = !(
					audio.bufferedChunks[audio.playSequence] instanceof
					ArrayBuffer
				);
				if (!audio.producerEnded && missingAudio &&
				    audioLead < CPU_BUFFER_UNDERRUN_GUARD_SECONDS) {
					this._enterCpuBufferedRebuffer(session, false);
					return;
				}
			}
			if (session.videoProducerDrained !== true &&
			    Number(session.renderedSeconds) - session.playedSeconds <
				Math.max(
					CPU_BUFFER_UNDERRUN_GUARD_SECONDS,
					2 / Math.max(1, session.fps)
				)) {
				this._enterCpuBufferedRebuffer(session, false);
				return;
			}
			targetSequence = Math.max(
				0,
				Math.floor(session.playedSeconds * session.fps)
			);
			if (!session.videoDecodeInFlight &&
			    targetSequence > Number(session.displayedSequence))
				this._decodeCpuBufferedFrame(session, targetSequence);
			this._updateCpuBufferedCounters(session, false);
			if (session.producerEnded &&
			    session.videoProducerDrained === true &&
			    (!audio || audio.producerEnded) &&
			    !session.videoDecodeInFlight &&
			    Number(session.videoFrameIndex) >=
				Number(session.videoFrames && session.videoFrames.length) &&
			    Number(session.lastDecodeFailureSequence) >=
				Number(session.lastBufferedFrameSequence) &&
			    Number(session.displayedSequence) <
				Number(session.lastBufferedFrameSequence)) {
				this._failCpuBufferedPlayback(
					session,
					_('The browser could not decode the final router-rendered frame.')
				);
				return;
			}
			if (this._cpuBufferedPlaybackFinished(session)) {
				this._finishCpuPlayback(
					session,
					_('Router CPU playback ended: %s').format(session.label),
					false,
					true
				);
				return;
			}
		}
		else {
			this._maybeStartCpuBufferedPlayback(session);
			this._updateCpuBufferedCounters(session, false);
		}
		this._scheduleCpuBufferedPresentation(
			session,
			session.bufferState === 'playing' ? 0 : CPU_BUFFER_POLL_MS
		);
	},

	_scheduleCpuBufferedPresentation: function (session, delay) {
		const self = this;
		const callback = function () {
			session.presentationTimer = null;
			session.presentationTimerType = null;
			self._pollCpuBufferedPresentation(session);
		};

		if (!self._isCurrentCpuSession(session) || !session.bufferedPlayback ||
		    session.presentationTimer != null)
			return;
		if ((!delay || delay <= 0) && session.bufferState === 'playing' &&
		    typeof window.requestAnimationFrame === 'function') {
			session.presentationTimerType = 'animation';
			session.presentationTimer = window.requestAnimationFrame(callback);
		}
		else {
			session.presentationTimerType = 'timeout';
			session.presentationTimer = window.setTimeout(
				callback,
				Math.max(0, Number(delay) || 0)
			);
		}
	},

	_disposeCpuBufferedPlayback: function (session) {
		const decoding = session && session.videoDecodeInFlight;

		if (!session || !session.bufferedPlayback)
			return;
		if (session.presentationTimer != null) {
			if (session.presentationTimerType === 'animation' &&
			    typeof window.cancelAnimationFrame === 'function')
				window.cancelAnimationFrame(session.presentationTimer);
			else
				window.clearTimeout(session.presentationTimer);
		}
		session.presentationTimer = null;
		session.presentationTimerType = null;
		session.videoDecodeGeneration =
			(Number(session.videoDecodeGeneration) || 0) + 1;
		if (decoding) {
			decoding.node.onload = null;
			decoding.node.onerror = null;
			try { decoding.node.removeAttribute('src'); }
			catch (err) {}
			try { window.URL.revokeObjectURL(decoding.url); }
			catch (err) {}
		}
		session.videoDecodeInFlight = null;
		session.videoFrames = [];
		session.videoFrameIndex = 0;
		session.videoBufferBytes = 0;
		session.videoDecodeBytes = 0;
		if (session.audio) {
			session.audio.bufferedChunks = Object.create(null);
			session.audio.bufferedBytes = 0;
		}
	},

	_failCpuBufferedPlayback: function (session, message) {
		const self = this;

		if (!self._isCurrentCpuSession(session) || !session.bufferedPlayback ||
		    session.bufferFallbackPending)
			return;
		session.bufferFallbackPending = true;
		const relPath = session.relPath;
		const label = session.label;
		const generation = session.generation;
		const stopped = self._detachCpuSession(true);
		self._stopRendererBestEffort(stopped);
		self._setPlayerSurface('none');
		if (!relPath) {
			self._setNowPlaying(message);
			notify(null, E('p', {}, message), 8000, 'error');
			return;
		}
		notify(null, E('p', {},
			_('%s Using browser decoding instead; fallback starts muted.')
				.format(message)), 9000, 'warning');
		callResolve(relPath).then(function (res) {
			if (generation !== self._playGeneration || !res || res.error ||
			    !res.stream_url)
				throw new Error(String(res && res.error ||
					_('The streamer did not return a playback URL.')));
			return self._playInVideo(
				res.stream_url, label, generation, 'local', true
			);
		}).catch(function (err) {
			if (generation !== self._playGeneration)
				return;
			self._currentKind = null;
			self._currentRenderMode = null;
			self._currentSrc = null;
			self._setPlayerSurface('none');
			self._setNowPlaying(
				_('Unable to play %s: %s').format(label, errorText(err))
			);
			notify(null, E('p', {},
				_('Browser fallback failed: %s').format(errorText(err))),
			8000, 'error');
		});
	},

	_finalizeCpuBufferedVideoDrain: function (session) {
		const pending = session && session.streamPending;
		const visible = session && session.streamVisibleAttempt;
		const pendingActive = pending && !pending.cancelled && !pending.ended;
		const visibleActive = visible && !visible.cancelled && !visible.ended;

		if (!this._isCurrentCpuSession(session) || !session.bufferedPlayback ||
		    !session.producerEnded || session.videoProducerDrained)
			return false;
		/* An ordinary clean HTTP EOF only marks a bounded 45-second handoff. The
		 * backend confirms terminal EOF separately, after retaining its FIFO until
		 * one drain request has consumed every queued byte. */
		if (pendingActive || visibleActive)
			return true;
		if (!session.videoTerminalDrainConfirmed)
			return false;
		session.videoProducerDrained = true;
		this._sealCpuBufferedDuration(session);
		this._maybeStartCpuBufferedPlayback(session);
		this._scheduleCpuBufferedPresentation(session, 0);
		return true;
	},

	_completeCpuFetchStream: function (session, attempt) {
		const handoffDelay = session && session.bufferedPlayback
			? 0
			: CPU_STREAM_HANDOFF_GRACE_MS;

		if (!this._isCurrentCpuSession(session) || attempt.cancelled ||
		    attempt.completed)
			return;
		if (session.bufferedPlayback && attempt.responseStatus === 200 &&
		    attempt.bodyEndedClean !== true) {
			attempt.failureReason = _(
				'The buffered router video response ended before a complete handoff.'
			);
			this._handleCpuStreamFailure(session, attempt);
			return;
		}
		attempt.completed = true;
		/* Every bounded response can become the server-side terminal drainer
		 * before the slower status RPC observes `ended`. Keep the latest 200
		 * body's delivery result as the candidate for a following terminal 204.
		 * Persist this before checking `ready`: a final successor can contain only
		 * FFmpeg's closing multipart boundary, so it has no JPEG to mark ready even
		 * though its exact nonce-bound body reached a clean EOF. */
		if (session.videoTerminalDrainCandidateId === attempt.streamId)
			session.videoTerminalDrainBodyClean = attempt.bodyEndedClean === true;
		if (!attempt.ready && !(session.bufferedPlayback &&
		    attempt.responseStatus === 200 &&
		    attempt.bodyEndedClean === true)) {
			this._handleCpuStreamFailure(session, attempt);
			return;
		}
		if (session.streamProbeAttempt === attempt) {
			if (session.streamProbeTimer != null)
				window.clearTimeout(session.streamProbeTimer);
			session.streamProbeTimer = null;
			session.streamProbeAttempt = null;
		}
		attempt.ended = true;
		if (session.streamVisibleAttempt === attempt)
			session.streamVisibleAttempt = null;
		if (session.streamPending === attempt)
			session.streamPending = null;
		if (session.streamRefreshTimer != null)
			window.clearTimeout(session.streamRefreshTimer);
		session.streamRefreshTimer = null;
		session.streamNextHandoffAt = Date.now() + handoffDelay;
		this._disposeCpuFetchAttempt(attempt, session);
		this._scheduleCpuStreamStatus(session, 0);
		/* Even a drain request which reached a clean body EOF is followed by a
		 * cheap confirmation request. Only its authenticated 204 marker proves
		 * that the relay reached FIFO EOF rather than its ordinary segment limit. */
		this._scheduleCpuStreamReconnect(
			session,
			session.bufferedPlayback && session.producerEnded
				? 0
				: handoffDelay
		);
	},

	_startCpuFetchStream: function (session, attempt, requestUrl) {
		const self = this;
		const expectedBoundary = 'videoplayer-' + session.token;

		attempt.streamId = String(attempt.streamId || '');
		if (!/^[0-9]{1,16}(?:-[0-9]{1,16})?$/.test(attempt.streamId)) {
			attempt.failureReason = _('The router video request nonce is invalid.');
			self._handleCpuStreamFailure(session, attempt);
			return;
		}
		if (attempt.terminalDrain && !attempt.terminalCheck) {
			/* Invalidate any preceding bounded-body candidate before the request
			 * can consume terminal FIFO bytes. This also covers a timeout before
			 * Fetch exposes response headers. */
			attempt.priorTerminalBodyClean =
				session.videoTerminalDrainCandidateId === attempt.streamId &&
				session.videoTerminalDrainBodyClean === true;
			session.videoTerminalDrainRetryConsume = false;
			session.videoTerminalDrainCandidateId = attempt.streamId;
			session.videoTerminalDrainBodyClean = false;
		}
		attempt.controller = new window.AbortController();
		attempt.fetchPromise = window.fetch(requestUrl, {
			method: 'GET',
			credentials: 'same-origin',
			cache: 'no-store',
			signal: attempt.controller.signal
		}).then(function (response) {
			const contentType = String(
				response && response.headers &&
				response.headers.get('Content-Type') || ''
			);
			const boundaryMatch = contentType.match(
				/^multipart\/x-mixed-replace\s*;[^\r\n]*\bboundary=(?:"([^"]+)"|([^;\s]+))/i
			);

			attempt.responseStatus = Number(response && response.status) || 0;
			if (attempt.responseStatus === 200)
				attempt.responseStartedAt = Date.now();
			if (response && response.status === 202 && attempt.terminalCheck &&
			    session.producerEnded) {
				attempt.completed = true;
				attempt.ended = true;
				if (session.streamPending === attempt)
					session.streamPending = null;
				if (session.streamVisibleAttempt === attempt)
					session.streamVisibleAttempt = null;
				/* Keep the same nonce and its previous clean-body evidence. The
				 * worker may already be pinned to ready(A) while the first relay
				 * ended at a segment cap. Reissuing drain=1 with A is idempotent;
				 * inventing B would strand that worker until its safety timeout. */
				if (session.videoTerminalDrainCandidateId === attempt.streamId)
					session.videoTerminalDrainRetryConsume = true;
				self._disposeCpuFetchAttempt(attempt, session);
				self._scheduleCpuStreamReconnect(session, 0);
				return;
			}
			if (response && response.status === 204 && attempt.terminalDrain) {
				const drainState = String(response.headers && response.headers.get(
					'X-Videoplayer-Video-Drain'
				) || '').toLowerCase();
				const drainId = String(response.headers && response.headers.get(
					'X-Videoplayer-Video-Drain-ID'
				) || '');

				if (!session.producerEnded || drainState !== 'complete' ||
				    !attempt.streamId || drainId !== attempt.streamId ||
				    drainId !== session.videoTerminalDrainCandidateId) {
					attempt.failureReason = _(
						'The router returned an invalid terminal video drain acknowledgement.'
					);
					self._failCpuBufferedPlayback(session, attempt.failureReason);
					return;
				}
				/* The server marker proves that its relay consumed FIFO EOF, but
				 * not that uhttpd delivered the relay's buffered tail to this
				 * browser. Seal only after this client observed a clean terminal
				 * 200 body first; an errored/truncated body is unreplayable once
				 * the server-side marker exists. */
				const hasCleanTerminalBody =
					session.videoTerminalDrainBodyClean === true ||
					(!attempt.terminalCheck &&
					 attempt.priorTerminalBodyClean === true);

				if (!hasCleanTerminalBody) {
					attempt.failureReason = _(
						'The terminal router video response was interrupted before every frame reached the browser.'
					);
					self._failCpuBufferedPlayback(
						session, attempt.failureReason
					);
					return;
				}
				session.videoTerminalDrainBodyClean = true;
				attempt.ready = true;
				attempt.ended = true;
				attempt.completed = true;
				attempt.transportEnded = true;
				attempt.reader = null;
				if (session.streamPending === attempt)
					session.streamPending = null;
				if (session.streamVisibleAttempt === attempt)
					session.streamVisibleAttempt = null;
				session.videoTerminalDrainConfirmed = true;
				self._disposeCpuFetchAttempt(attempt, session);
				self._finalizeCpuBufferedVideoDrain(session);
				return;
			}
			if (!response || response.status !== 200 || !response.ok)
				throw new Error(_('The router video stream returned HTTP %d.').format(
					Number(response && response.status) || 0
				));
			if (attempt.terminalCheck) {
				attempt.failureReason = _(
					'The router returned a video body for a read-only drain confirmation.'
				);
				self._failCpuBufferedPlayback(session, attempt.failureReason);
				return;
			}
			if (!boundaryMatch ||
			    String(boundaryMatch[1] || boundaryMatch[2] || '') !== expectedBoundary)
				throw new Error(_('The router returned an invalid MJPEG content type.'));
			if (!response.body || typeof response.body.getReader !== 'function') {
				attempt.fetchUnsupported = true;
				throw new Error(_('This browser cannot read a continuous MJPEG stream.'));
			}
			session.videoTerminalDrainCandidateId = String(attempt.streamId || '');
			session.videoTerminalDrainBodyClean = false;

			attempt.boundaryMarker = asciiBytes('--' + expectedBoundary + '\r\n');
			attempt.boundaryCloseMarker = asciiBytes(
				'--' + expectedBoundary + '--\r\n'
			);
			attempt.headerEnd = asciiBytes('\r\n\r\n');
			attempt.multipartBuffer = new Uint8Array(0);
			attempt.multipartState = 'boundary';
			attempt.reader = response.body.getReader();
			attempt.lastProgressAt = Date.now();

			const pump = function () {
				if (!self._isCurrentCpuSession(session) || attempt.cancelled)
					return Promise.resolve();
				return attempt.reader.read().then(function (part) {
					if (!self._isCurrentCpuSession(session) || attempt.cancelled)
						return;
					if (part.done) {
						attempt.reader = null;
						attempt.bodyEndedClean =
							self._accountCpuMjpegTruncation(session, attempt);
						attempt.transportEnded = true;
						if (!attempt.decodeInFlight && !attempt.queuedFrame)
							self._completeCpuFetchStream(session, attempt);
						return;
					}
					if (!(part.value instanceof Uint8Array))
						throw new Error(_('The browser returned invalid MJPEG stream data.'));
					attempt.lastProgressAt = Date.now();
					self._consumeCpuMjpegChunk(session, attempt, part.value);
					return self._waitForCpuBufferedCapacity(
						session, attempt
					).then(pump);
				});
			};
			return pump();
		}).catch(function (err) {
			if (!self._isCurrentCpuSession(session) || attempt.cancelled)
				return;
			self._accountCpuMjpegTruncation(session, attempt);
			attempt.bodyEndedClean = false;
			if (session.videoTerminalDrainCandidateId === attempt.streamId)
				session.videoTerminalDrainBodyClean = false;
			attempt.failureReason = errorText(err);
			self._handleCpuStreamFailure(session, attempt);
		});
	},

	_disposeCpuStreamNode: function (node, removeNode) {
		if (!node)
			return;
		node.onload = null;
		node.onerror = null;
		try { node.removeAttribute('src'); }
		catch (err) { node.src = ''; }
		if (removeNode && node.parentNode) {
			try { node.parentNode.removeChild(node); }
			catch (err) {}
		}
	},

	_clearCpuStreamRequest: function (session, clearFrame) {
		const visible = session && (
			session.visibleFrame ||
			document.getElementById('videoplayer-cpu-frame')
		);

		if (!session)
			return;
		if (session.streamProbeTimer != null)
			window.clearTimeout(session.streamProbeTimer);
		session.streamProbeTimer = null;
		session.streamProbeAttempt = null;
		if (session.streamRefreshTimer != null)
			window.clearTimeout(session.streamRefreshTimer);
		session.streamRefreshTimer = null;
		if (session.streamReconnectTimer != null)
			window.clearTimeout(session.streamReconnectTimer);
		session.streamReconnectTimer = null;
		if (session.streamPending) {
			if (session.streamPending.mode === 'fetch')
				this._disposeCpuFetchAttempt(session.streamPending, session);
			else
				this._disposeCpuStreamNode(session.streamPending.node, true);
			session.streamPending = null;
		}
		if (session.streamVisibleAttempt) {
			if (session.streamVisibleAttempt.mode === 'fetch') {
				this._disposeCpuFetchAttempt(
					session.streamVisibleAttempt, session
				);
			}
			else if (session.streamVisibleAttempt.node) {
				session.streamVisibleAttempt.node.onload = null;
				session.streamVisibleAttempt.node.onerror = null;
			}
			session.streamVisibleAttempt = null;
		}
		session.streamNextHandoffAt = null;
		if (clearFrame && visible)
			this._disposeCpuStreamNode(visible, false);
	},

	_stopCpuStreamTransport: function (session, clearFrame) {
		if (!session)
			return;
		this._clearCpuStreamRequest(session, clearFrame);
		if (session.streamStatusTimer != null)
			window.clearTimeout(session.streamStatusTimer);
		session.streamStatusTimer = null;
	},

	_cancelCpuStream: function (session, clearFrame) {
		if (!session)
			return;
		session.active = false;
		this._disposeCpuBufferedPlayback(session);
		this._stopCpuStreamTransport(session, clearFrame);
		if (session.finishTimer != null)
			window.clearTimeout(session.finishTimer);
		session.finishTimer = null;
		if (session.avSyncTimer != null)
			window.clearTimeout(session.avSyncTimer);
		session.avSyncTimer = null;
		session.finishing = null;
		if (session.audio) {
			this._disposeCpuAudio(session.audio);
			session.audio = null;
		}
		if (session.pendingAudio) {
			this._disposeCpuAudio(session.pendingAudio);
			session.pendingAudio = null;
		}
		if (session.browserAudio) {
			this._disposeCpuBrowserAudio(session.browserAudio);
			session.browserAudio = null;
		}
		if (session.audioDrainer) {
			this._disposeCpuAudioDrainer(session.audioDrainer);
			session.audioDrainer = null;
		}
	},

	_detachCpuSession: function (clearFrame) {
		const session = this._cpuSession;

		if (!session)
			return null;
		this._cpuSession = null;
		this._cancelCpuStream(session, clearFrame !== false);
		return session;
	},

	_stopRendererBestEffort: function (session) {
		if (!session || !session.token)
			return;
		callStopRenderer(session.token).catch(function () {});
	},

	_stopPlayback: function () {
		this._playGeneration++;
		if (this._pendingCpuAudio) {
			this._disposeCpuAudio(this._pendingCpuAudio);
			this._pendingCpuAudio = null;
		}
		const session = this._detachCpuSession(true);
		this._stopRendererBestEffort(session);
		this._clearVideoElement();
		this._clearCpuBrowserAudioElement();
		this._currentSrc = null;
		this._currentKind = null;
		this._currentRenderMode = null;
		this._currentLabel = '';
		this._setPlayerSurface('none');
	},

	_preparePlaybackSurface: function () {
		if (this._pendingCpuAudio) {
			this._disposeCpuAudio(this._pendingCpuAudio);
			this._pendingCpuAudio = null;
		}
		const session = this._detachCpuSession(true);

		this._stopRendererBestEffort(session);
		this._clearVideoElement();
		this._clearCpuBrowserAudioElement();
		this._currentSrc = null;
		this._currentRenderMode = null;
		this._setPlayerSurface('none');
	},

	_playInVideo: function (url, label, generation, kind, startMuted) {
		const self = this;
		const video = document.getElementById('videoplayer-video');

		if (!video || generation !== self._playGeneration)
			return Promise.resolve();

		self._preparePlaybackSurface();
		self._currentKind = kind;
		self._currentRenderMode = 'browser';
		self._currentLabel = label || url;
		self._setPlayerSurface('video');
		video.src = url;
		if (startMuted) {
			video.muted = true;
			self._syncMuteControl(video);
		}
		self._currentSrc = video.src || url;
		self._setNowPlaying(_('Loading in browser: %s').format(self._currentLabel));

		video.load();
		let p;
		try {
			p = video.play();
		}
		catch (err) {
			if (generation === self._playGeneration) {
				self._setNowPlaying(_('Playback could not start: %s').format(self._currentLabel));
				notify(null,
					E('p', {}, _('Playback failed: %s').format(errorText(err))),
					8000, 'warning');
			}
			return Promise.resolve();
		}

		if (p && typeof p.catch === 'function') {
			return p.catch(function (err) {
				if (generation !== self._playGeneration)
					return;

				self._setNowPlaying(_('Playback could not start: %s').format(self._currentLabel));
				notify(null,
					E('p', {}, _('Playback failed: %s').format(errorText(err))),
					8000, 'warning');
			});
		}

		return Promise.resolve();
	},

	_isCurrentCpuSession: function (session) {
		return !!session &&
			this._cpuSession === session &&
			session.active &&
			session.generation === this._playGeneration &&
			this._currentKind === 'local' &&
			this._currentRenderMode === 'router';
	},

	_markCpuStreamStarted: function (session, attempt) {
		const frame = attempt && attempt.node;
		const previous = session && session.visibleFrame;

		if (!this._isCurrentCpuSession(session) || !attempt || !frame ||
		    session.streamPending !== attempt || attempt.ready)
			return;
		attempt.ready = true;
		session.streamPending = null;
		if (session.streamProbeTimer != null)
			window.clearTimeout(session.streamProbeTimer);
		session.streamProbeTimer = null;
		if (previous && previous !== frame) {
			previous.onload = null;
			previous.onerror = null;
			if (previous.id === 'videoplayer-cpu-frame')
				previous.removeAttribute('id');
		}
		frame.id = 'videoplayer-cpu-frame';
		frame.hidden = false;
		frame.setAttribute('aria-hidden', 'false');
		session.visibleFrame = frame;
		session.streamVisibleAttempt = attempt;
		if (previous && previous !== frame)
			this._disposeCpuStreamNode(previous, true);
		session.streamLastFrameAt = Date.now();
		session.streamOutageStartedAt = null;
		session.streamErrors = 0;
		session.streamWarned = false;
		session.streamNextHandoffAt =
			attempt.openedAt + session.streamSegmentMs +
			CPU_STREAM_HANDOFF_GRACE_MS;
		if (session.streamRefreshTimer != null)
			window.clearTimeout(session.streamRefreshTimer);
		{
			const self = this;
			session.streamRefreshTimer = window.setTimeout(function () {
				session.streamRefreshTimer = null;
				if (self._isCurrentCpuSession(session) &&
				    !session.finishing &&
				    session.streamVisibleAttempt === attempt &&
				    !session.streamPending)
					self._scheduleCpuStreamReconnect(session, 0);
			}, Math.max(0, session.streamNextHandoffAt - Date.now()));
		}
		if (!session.firstFrameSeen) {
			session.firstFrameSeen = true;
			session.firstFrameAt = session.streamLastFrameAt;
			if (session.browserAudio &&
			    session.browserAudio.active &&
			    session.browserAudio.waitingForVideo) {
				if (document.hidden) {
					session.browserAudio.syncPaused = true;
				}
				else {
					session.browserAudio.waitingForVideo = false;
					session.browserAudio.syncPaused = false;
					session.browserAudio.playPromise =
						this._playCpuBrowserAudio(
							session, session.browserAudio, false
						);
				}
			}
		}
		this._setPlayerSurface('cpu');
		this._updateCpuAudioPresentation(session);
	},

	_scheduleCpuStreamProbe: function (session, attempt) {
		const self = this;
		const isFetch = attempt && attempt.mode === 'fetch';

		if (!self._isCurrentCpuSession(session) || session.finishing ||
		    !attempt || attempt.ended || attempt.completed ||
		    (isFetch
			? (session.streamPending !== attempt &&
			   session.streamVisibleAttempt !== attempt)
			: (attempt.ready || session.streamPending !== attempt)))
			return;
		if (session.streamProbeTimer != null)
			window.clearTimeout(session.streamProbeTimer);
		session.streamProbeAttempt = attempt;
		session.streamProbeTimer = window.setTimeout(function () {
			const frame = attempt.node;
			const now = Date.now();
			let timeout, timeoutStartedAt;

			session.streamProbeTimer = null;
			if (session.streamProbeAttempt === attempt)
				session.streamProbeAttempt = null;
			if (!self._isCurrentCpuSession(session) || session.finishing ||
			    attempt.ended || attempt.completed ||
			    (isFetch
				? (session.streamPending !== attempt &&
				   session.streamVisibleAttempt !== attempt)
				: session.streamPending !== attempt))
				return;
			if (!isFetch && frame && Number(frame.naturalWidth) > 0) {
				self._markCpuStreamStarted(session, attempt);
				return;
			}
			if (session.bufferedPlayback && session.producerEnded &&
			    Number.isFinite(session.videoTerminalDrainStartedAt) &&
			    now - session.videoTerminalDrainStartedAt >=
				CPU_TERMINAL_DRAIN_TIMEOUT_MS) {
				self._handleCpuStreamFailure(session, attempt);
				return;
			}
			if (isFetch && attempt.backpressured) {
				self._scheduleCpuStreamProbe(session, attempt);
				return;
			}
			if (session.bufferedPlayback && isFetch &&
			    attempt.responseStatus === 200 && !attempt.terminalDrain) {
				/* A full PCM ring may legitimately stop FFmpeg between JPEGs.
				 * Once a buffered 200 has started, aborting at the ordinary 5/15
				 * second probe would consume an unknown number of relay frames.
				 * The server closes every nonterminal response at a frame-aligned
				 * 45-second bound; keep a fixed 60-second transport guard rather
				 * than resetting an idle timer on individual frames. */
				if (session.producerEnded && Number.isFinite(
					Number(session.videoTerminalDrainStartedAt)
				)) {
					timeout = CPU_TERMINAL_DRAIN_TIMEOUT_MS;
					timeoutStartedAt = Number(
						session.videoTerminalDrainStartedAt
					);
				}
				else {
					timeout = CPU_BUFFERED_RESPONSE_TIMEOUT_MS;
					timeoutStartedAt = Number(
						attempt.responseStartedAt
					) || attempt.openedAt;
				}
			}
			else {
				timeout = attempt.terminalDrain
					? (isFetch && !attempt.ready
						? CPU_TERMINAL_FIRST_FRAME_TIMEOUT_MS
						: CPU_STREAM_IDLE_TIMEOUT_MS)
					: (isFetch && attempt.ready
						? CPU_STREAM_IDLE_TIMEOUT_MS
						: CPU_STREAM_ATTEMPT_TIMEOUT_MS);
				timeoutStartedAt = isFetch && attempt.ready
					? Number(attempt.lastProgressAt) || attempt.openedAt
					: attempt.openedAt;
			}
			if (now - timeoutStartedAt >= timeout) {
				self._handleCpuStreamFailure(session, attempt);
				return;
			}
			self._scheduleCpuStreamProbe(session, attempt);
		}, CPU_STREAM_PROBE_INTERVAL_MS);
	},

	_scheduleCpuStreamReconnect: function (session, delay) {
		const self = this;
		let reconnectDelay = Math.max(0, Number(delay) || 0);

		if (!self._isCurrentCpuSession(session) || session.finishing ||
		    (session.bufferedPlayback && session.videoProducerDrained) ||
		    session.streamPending)
			return;
		if (self._cpuInitialBufferCannotProgress(session)) {
			self._failCpuBufferedPlayback(
				session,
				_('The router could not reach the two-minute start gate within the 512 MiB browser memory safety limit.')
			);
			return;
		}
		if (session.bufferedPlayback &&
		    !self._cpuBufferedTransportHasCapacity(session)) {
			self._setCpuRenderCapacityHeld(session, true);
			reconnectDelay = Math.max(reconnectDelay, CPU_BUFFER_POLL_MS);
		}
		if (session.streamReconnectTimer != null)
			window.clearTimeout(session.streamReconnectTimer);
		session.streamReconnectTimer = window.setTimeout(function () {
			session.streamReconnectTimer = null;
			if (session.bufferedPlayback &&
			    !self._cpuBufferedTransportHasCapacity(session)) {
				self._setCpuRenderCapacityHeld(session, true);
				self._scheduleCpuStreamReconnect(
					session, CPU_BUFFER_POLL_MS
				);
				return;
			}
			if (session.bufferedPlayback)
				self._setCpuRenderCapacityHeld(session, false);
			self._openCpuStream(session);
		}, reconnectDelay);
	},

	_handleCpuStreamFailure: function (session, attempt) {
		const now = Date.now();
		const fetchStartupFailure = attempt && attempt.mode === 'fetch' &&
			!attempt.ready;
		const cleanHandoffStatusRetry = !!(
			session && session.bufferedPlayback && fetchStartupFailure &&
			session.videoTerminalDrainBodyClean === true &&
			session.videoTerminalDrainCandidateId &&
			attempt.streamId !== session.videoTerminalDrainCandidateId &&
			(Number(attempt.responseStatus) === 202 ||
			 Number(attempt.responseStatus) === 409 ||
			 Number(attempt.responseStatus) === 410)
		);
		const ambiguousBufferedResponse = !!(
			session && session.bufferedPlayback && attempt &&
			attempt.mode === 'fetch' && !attempt.terminalCheck &&
			attempt.bodyEndedClean !== true &&
			(!Number.isFinite(Number(attempt.responseStatus)) ||
			 Number(attempt.responseStatus) === 0 ||
			 Number(attempt.responseStatus) === 200)
		);
		let delay;

		if (!this._isCurrentCpuSession(session) || session.finishing ||
		    !attempt ||
		    (session.streamPending !== attempt &&
		     session.streamVisibleAttempt !== attempt))
			return;
		if (session.streamProbeAttempt === attempt) {
			if (session.streamProbeTimer != null)
				window.clearTimeout(session.streamProbeTimer);
			session.streamProbeTimer = null;
			session.streamProbeAttempt = null;
		}
		if (fetchStartupFailure && !cleanHandoffStatusRetry) {
			session.streamFetchErrors =
				(Number(session.streamFetchErrors) || 0) + 1;
			if (!session.bufferedPlayback &&
			    (attempt.fetchUnsupported || session.streamFetchErrors >= 2)) {
				session.fetchDisabled = true;
				if (!session.fetchFallbackWarned) {
					session.fetchFallbackWarned = true;
					notify(null, E('p', {},
						_('This browser cannot parse the router MJPEG stream directly. Falling back to native MJPEG playback; precise frame-clock audio synchronization may be unavailable.')),
					6000, 'warning');
				}
			}
		}
		if (session.streamPending === attempt) {
			session.streamPending = null;
			if (attempt.mode === 'fetch')
				this._disposeCpuFetchAttempt(attempt, session);
			else
				this._disposeCpuStreamNode(attempt.node, true);
		}
		if (session.streamVisibleAttempt === attempt) {
			attempt.ended = true;
			if (attempt.mode === 'fetch')
				this._disposeCpuFetchAttempt(attempt, session);
			else if (attempt.node) {
				attempt.node.onload = null;
				attempt.node.onerror = null;
			}
			if (session.streamRefreshTimer != null)
				window.clearTimeout(session.streamRefreshTimer);
			session.streamRefreshTimer = null;
			session.streamNextHandoffAt = null;
		}
		if (ambiguousBufferedResponse) {
			/* Once a 200 response has started, the FIFO relay may already have
			 * consumed several complete frames which a broken HTTP connection did
			 * not deliver. A fetch rejection before headers is equally ambiguous:
			 * CGI may already be draining behind uhttpd. Without a server-authored
			 * sequence there is no lossless retry point, so never guess or skip. */
			this._failCpuBufferedPlayback(
				session,
				attempt.failureReason
					? _('The buffered router video response was interrupted: %s')
						.format(attempt.failureReason)
					: _('The buffered router video response ended before a complete handoff.')
			);
			return;
		}
		if (session.bufferedPlayback && session.producerEnded) {
			/* Terminal EOF is an explicit backend acknowledgement, never an
			 * inference from 410 or from a preceding bounded response. Retry the
			 * drain endpoint while its worker performs the bounded final handshake. */
			session.videoTerminalDrainErrors =
				(Number(session.videoTerminalDrainErrors) || 0) + 1;
			if (!Number.isFinite(session.videoTerminalDrainStartedAt))
				session.videoTerminalDrainStartedAt = now;
			if (now - session.videoTerminalDrainStartedAt >=
			    CPU_TERMINAL_DRAIN_TIMEOUT_MS) {
				this._failCpuBufferedPlayback(
					session,
					_('The router terminal video drain could not be confirmed before its safety deadline.')
				);
				return;
			}
			this._scheduleCpuStreamStatus(session, 0);
			if (!this._finalizeCpuBufferedVideoDrain(session))
				this._scheduleCpuStreamReconnect(
					session,
					Math.min(CPU_STREAM_MAX_RECONNECT_MS, 500)
				);
			return;
		}
		if (cleanHandoffStatusRetry) {
			/* A clean bounded response is an exact FIFO checkpoint. Its immediate
			 * successor can legitimately receive 202/409 while the next relay is
			 * becoming available, or 410 when FFmpeg reached EOF before the status
			 * RPC observed `ended`. These responses carry no body and consume no
			 * frames, so verify status and retry without spending the three-strike
			 * fetch-startup budget. The ordinary outage deadline remains the bound. */
			if (!Number.isFinite(session.streamOutageStartedAt))
				session.streamOutageStartedAt = now;
			session.streamErrors++;
			if (now - session.streamOutageStartedAt >=
			    CPU_STREAM_OUTAGE_TIMEOUT_MS) {
				this._failCpuBufferedPlayback(
					session,
					_('The buffered router video stream could not be verified after a clean handoff.')
				);
				return;
			}
			this._scheduleCpuStreamStatus(session, 0);
			this._scheduleCpuStreamReconnect(session, 250);
			return;
		}
		if (!Number.isFinite(session.streamOutageStartedAt))
			session.streamOutageStartedAt = now;
		session.streamErrors++;
		if (session.bufferedPlayback &&
		    (attempt.fetchUnsupported || session.streamFetchErrors >= 3)) {
			this._failCpuBufferedPlayback(
				session,
				attempt.failureReason
					? _('The browser could not read the buffered router stream: %s')
						.format(attempt.failureReason)
					: _('The browser could not read the buffered router stream.')
			);
			return;
		}
		if (session.streamErrors >= 3 &&
		    now - session.streamOutageStartedAt >=
		    CPU_STREAM_OUTAGE_TIMEOUT_MS) {
			if (session.bufferedPlayback) {
				this._failCpuBufferedPlayback(
					session,
					_('The buffered router video stream for %s remained unavailable.')
						.format(session.label)
				);
				return;
			}
			this._finishCpuPlayback(
				session,
				_('The continuous router MJPEG stream for %s remained unavailable. Use browser rendering or try another browser.')
					.format(session.label),
				true
			);
			return;
		}
		delay = Math.min(
			CPU_STREAM_MAX_RECONNECT_MS,
			250 * Math.pow(2, Math.min(
				Math.max(0, session.streamErrors - 1), 4
			))
		);
		if (session.streamErrors >= 4 && !session.streamWarned) {
			session.streamWarned = true;
			notify(null, E('p', {},
				_('The continuous router video stream was interrupted; reconnecting.')),
			6000, 'warning');
		}
		this._scheduleCpuStreamStatus(session, 0);
		this._scheduleCpuStreamReconnect(session, delay);
	},

	_openCpuStream: function (session) {
		const self = this;
		const visible = session && (
			session.visibleFrame ||
			document.getElementById('videoplayer-cpu-frame')
		);
		const parent = visible && visible.parentNode;
		let attempt, frame, requestUrl, previousTransport, nativeBase, streamId;

		if (!self._isCurrentCpuSession(session) || session.finishing ||
		    (session.bufferedPlayback && session.videoProducerDrained) ||
		    session.streamPending)
			return;
		if (self._cpuInitialBufferCannotProgress(session)) {
			self._failCpuBufferedPlayback(
				session,
				_('The router could not reach the two-minute start gate within the 512 MiB browser memory safety limit.')
			);
			return;
		}
		if (session.bufferedPlayback &&
		    !self._cpuBufferedTransportHasCapacity(session)) {
			self._setCpuRenderCapacityHeld(session, true);
			self._scheduleCpuStreamReconnect(session, CPU_BUFFER_POLL_MS);
			return;
		}
		if (session.bufferedPlayback)
			self._setCpuRenderCapacityHeld(session, false);
		if (!visible || !parent ||
		    typeof document.createElement !== 'function' ||
		    typeof parent.insertBefore !== 'function') {
			if (session.bufferedPlayback) {
				self._failCpuBufferedPlayback(
					session,
					_('This browser cannot create the canvas stream surface required for buffered playback.')
				);
				return;
			}
			self._finishCpuPlayback(
				session,
				_('This browser cannot create the router video stream surface.'),
				true
			);
			return;
		}
		session.visibleFrame = visible;
		const reuseTerminalNonce = !!(session.bufferedPlayback &&
			session.producerEnded && session.videoTerminalDrainCandidateId);
		const terminalRetryConsume = !!(reuseTerminalNonce &&
			session.videoTerminalDrainRetryConsume);
		const terminalCheck = !!(reuseTerminalNonce && !terminalRetryConsume);
		if (reuseTerminalNonce)
			streamId = String(session.videoTerminalDrainCandidateId);
		else {
			session.streamAttempt = (Number(session.streamAttempt) || 0) + 1;
			streamId = String(session.generation) + '-' +
				String(session.streamAttempt);
		}
		requestUrl = session.streamUrl + '&stream=' + streamId;
		if (session.bufferedPlayback && session.producerEnded)
			requestUrl += terminalCheck ? '&drain=check' : '&drain=1';
		if (!session.fetchDisabled && self._canUseCpuFetchStream()) {
			session.streamTransportMode = 'fetch';
			attempt = {
				id: session.streamAttempt,
				mode: 'fetch',
				openedAt: Date.now(),
				lastProgressAt: Date.now(),
				ready: false,
				ended: false,
				cancelled: false,
				completed: false,
				transportEnded: false,
				terminalDrain: !!(session.bufferedPlayback && session.producerEnded),
				terminalCheck: terminalCheck,
				streamId: streamId,
				bodyEndedClean: false,
				decodeInFlight: null,
				queuedFrame: null,
				reader: null,
				controller: null
			};
			session.streamPending = attempt;
			self._startCpuFetchStream(session, attempt, requestUrl);
			self._scheduleCpuStreamProbe(session, attempt);
			return;
		}
		if (session.bufferedPlayback) {
			self._failCpuBufferedPlayback(
				session,
				_('This browser cannot read the continuous router stream required for synchronized buffered playback.')
			);
			return;
		}

		previousTransport = session.streamTransportMode;
		nativeBase = self._cpuVideoTarget(session, cpuMonotonicNow());
		session.streamTransportMode = 'native-mjpeg';
		if (previousTransport !== 'native-mjpeg') {
			/* Fetch supplies exact frame sequence timestamps; native multipart
			 * <img> does not. Retain only the last displayed media position as the
			 * native epoch, and discard the stale fetch clock before browser audio
			 * is allowed to start. */
			session.nativeMediaBase = Number.isFinite(nativeBase)
				? nativeBase
				: (Number.isFinite(session.videoMediaTime)
					? session.videoMediaTime
					: 0);
			session.videoMediaTime = null;
			session.videoFrameAt = null;
			session.videoPlaybackRate = null;
			session.videoRateAnchorMedia = null;
			session.videoRateAnchorAt = null;
			session.firstFrameSeen = false;
			session.firstFrameAt = null;
			session.streamLastFrameAt = null;
			if (session.streamVisibleAttempt &&
			    session.streamVisibleAttempt.mode === 'fetch') {
				const oldFetchAttempt = session.streamVisibleAttempt;

				self._disposeCpuFetchAttempt(oldFetchAttempt, session);
				session.streamVisibleAttempt = null;
				if (session.streamProbeAttempt === oldFetchAttempt) {
					if (session.streamProbeTimer != null)
						window.clearTimeout(session.streamProbeTimer);
					session.streamProbeTimer = null;
					session.streamProbeAttempt = null;
				}
			}
			if (session.streamRefreshTimer != null)
				window.clearTimeout(session.streamRefreshTimer);
			session.streamRefreshTimer = null;
			session.streamNextHandoffAt = null;
			if (session.avSyncTimer != null)
				window.clearTimeout(session.avSyncTimer);
			session.avSyncTimer = null;
			if (session.browserAudio && session.browserAudio.active) {
				session.browserAudio.waitingForVideo = true;
				if (session.browserAudio.element)
					self._pauseCpuBrowserAudioForSync(
						session, session.browserAudio
					);
			}
		}
		/* Native multipart <img> playback exposes no per-frame sequence or PTS.
		 * Running PCM at chunk=live/1x here would recreate the original audio-ahead
		 * bug on a slow router. Use the protected browser track for this emergency
		 * transport; exact PCM synchronization remains a fetch-stream feature. */
		if (session.audio && session.audio.active) {
			self._disableCpuAudio(
				session,
				_('Precise PCM synchronization is unavailable in native MJPEG fallback mode.')
			);
		}
		else if (session.pendingAudio) {
			const pending = session.pendingAudio;

			session.pendingAudio = null;
			self._disposeCpuAudio(pending);
			self._startCpuBrowserAudioFallback(
				session,
				_('Precise PCM synchronization is unavailable in native MJPEG fallback mode.')
			);
		}
		frame = document.createElement('img');
		frame.className = 'videoplayer-cpu-frame';
		frame.hidden = true;
		frame.setAttribute('aria-hidden', 'true');
		frame.setAttribute('alt', _('Continuous router-rendered video stream'));
		parent.insertBefore(frame, visible.nextSibling || null);
		attempt = {
			id: session.streamAttempt,
			mode: 'native-mjpeg',
			node: frame,
			openedAt: Date.now(),
			ready: false,
			ended: false,
			closeObserved: false
		};
		session.streamPending = attempt;
		frame.onload = function () {
			if (!self._isCurrentCpuSession(session) || session.finishing)
				return;
			if (session.streamPending === attempt && !attempt.ready) {
				self._markCpuStreamStarted(session, attempt);
				return;
			}
			/* Some browsers emit load only when a finite MJPEG response
			 * closes. Others emit it for individual parts, so only a late,
			 * once-per-attempt event may accelerate the bounded handoff. */
			if (session.streamVisibleAttempt === attempt &&
			    attempt.ready && !attempt.closeObserved &&
			    Date.now() - attempt.openedAt >=
			    session.streamSegmentMs - 1500) {
				attempt.closeObserved = true;
				if (session.streamRefreshTimer != null)
					window.clearTimeout(session.streamRefreshTimer);
				session.streamRefreshTimer = null;
				session.streamNextHandoffAt =
					Date.now() + CPU_STREAM_HANDOFF_GRACE_MS;
				self._scheduleCpuStreamReconnect(
					session, CPU_STREAM_HANDOFF_GRACE_MS);
			}
		};
		frame.onerror = function () {
			self._handleCpuStreamFailure(session, attempt);
		};
		frame.src = requestUrl;
		self._scheduleCpuStreamProbe(session, attempt);
	},

	_scheduleCpuStreamStatus: function (session, delay) {
		const self = this;

		if (!self._isCurrentCpuSession(session) || session.finishing)
			return;
		if (session.streamStatusTimer != null)
			window.clearTimeout(session.streamStatusTimer);
		session.streamStatusTimer = window.setTimeout(function () {
			session.streamStatusTimer = null;
			self._pollCpuStreamStatus(session);
		}, Math.max(0, Number(delay) || 0));
	},

	_pollCpuStreamStatus: function (session) {
		const self = this;

		if (!self._isCurrentCpuSession(session) || session.finishing)
			return Promise.resolve();
		if (session.bufferedPlayback && session.producerEnded &&
		    !session.videoProducerDrained &&
		    Number.isFinite(session.videoTerminalDrainStartedAt) &&
		    Date.now() - session.videoTerminalDrainStartedAt >=
			CPU_TERMINAL_DRAIN_TIMEOUT_MS) {
			self._failCpuBufferedPlayback(
				session,
				_('The router terminal video drain could not be confirmed before its safety deadline.')
			);
			return Promise.resolve();
		}
		if (session.streamStatusInFlight) {
			session.streamStatusAgain = true;
			return Promise.resolve();
		}
		session.streamStatusInFlight = true;
		session.streamStatusAgain = false;
		return callRendererStatus(session.token).then(function (res) {
			const state = String(res && res.state || 'error');

			if (!self._isCurrentCpuSession(session) || session.finishing)
				return;
			session.streamStatusErrors = 0;
			session.streamStatusWarned = false;
			if (session.bufferedPlayback)
				self._updateCpuBufferedMetadata(session, res);
			if (session.bufferedPlayback && state === 'ended') {
				const releaseTerminalBackpressure = function (attempt) {
					if (!attempt || attempt.mode !== 'fetch' || attempt.ended ||
					    attempt.terminalDrain)
						return;
					attempt.terminalDrain = true;
					attempt.terminalCheck = false;
					/* A successor dispatched just before EOF can already hold a
					 * non-body 409/410 response. It consumed no FIFO bytes and must
					 * not replace the preceding clean nonce which the worker may
					 * already have completed. A genuine 200 body claims its own nonce
					 * in _startCpuFetchStream() as soon as headers are accepted. */
					if (attempt.streamId && attempt.responseStatus === 200) {
						session.videoTerminalDrainCandidateId = attempt.streamId;
						session.videoTerminalDrainBodyClean = false;
					}
					attempt.backpressured = false;
					if (attempt.backpressureTimer != null)
						window.clearTimeout(attempt.backpressureTimer);
					attempt.backpressureTimer = null;
					if (attempt.backpressureResolve) {
						const resolve = attempt.backpressureResolve;
						attempt.backpressureResolve = null;
						resolve();
					}
				};

				session.producerEnded = true;
				if (!Number.isFinite(session.videoTerminalDrainStartedAt))
					session.videoTerminalDrainStartedAt = Date.now();
				/* A response opened while the producer was running can become the
				 * retained terminal FIFO drainer before this poll observes `ended`.
				 * Mark that exact response so only its clean body EOF can authorize
				 * the subsequent server-side 204 confirmation. */
				releaseTerminalBackpressure(session.streamPending);
				releaseTerminalBackpressure(session.streamVisibleAttempt);
				/* Keep an already-open response alive: the backend turns it into
				 * the terminal FIFO drainer. If the bounded response ended just
				 * before this status arrived, open the explicit drain immediately. */
				if (!self._finalizeCpuBufferedVideoDrain(session) &&
				    !session.streamPending &&
				    !(session.streamVisibleAttempt &&
				      !session.streamVisibleAttempt.ended))
					self._scheduleCpuStreamReconnect(session, 0);
				return;
			}
			if (state === 'ended' || state === 'stopped' ||
			    state === 'expired' || state === 'inactive') {
				if (session.bufferedPlayback) {
					self._failCpuBufferedPlayback(
						session,
						_('The router renderer stopped before its buffered output was complete.')
					);
					return;
				}
				return self._finishCpuPlayback(
					session,
					_('Router CPU playback ended: %s').format(session.label),
					false
				);
			}
			if (state === 'error') {
				const reason = String(res && res.reason || '').trim();
				if (session.bufferedPlayback) {
					self._failCpuBufferedPlayback(
						session,
						reason
							? _('Router CPU renderer failed for %s: %s')
								.format(session.label, reason)
							: _('Router CPU renderer failed for %s.')
								.format(session.label)
					);
					return;
				}
				return self._finishCpuPlayback(
					session,
					reason
						? _('Router CPU renderer failed for %s: %s')
							.format(session.label, reason)
						: _('Router CPU renderer failed for %s. The installed FFmpeg build may not support this video codec.')
							.format(session.label),
					true
				);
			}
			if (state !== 'running' && state !== 'starting') {
				if (session.bufferedPlayback) {
					self._failCpuBufferedPlayback(
						session,
						_('Router CPU renderer returned an invalid state for %s.')
							.format(session.label)
					);
					return;
				}
				return self._finishCpuPlayback(
					session,
					_('Router CPU renderer returned an invalid state for %s.')
						.format(session.label),
					true
				);
			}
		}).catch(function (err) {
			if (!self._isCurrentCpuSession(session) || session.finishing)
				return;
			session.streamStatusErrors++;
			if (session.streamStatusErrors >= 3 &&
			    !session.streamStatusWarned) {
				session.streamStatusWarned = true;
				notify(null, E('p', {},
					_('Unable to verify the router video stream: %s')
						.format(errorText(err))),
				6000, 'warning');
			}
		}).finally(function () {
			const runAgain = session.streamStatusAgain;

			session.streamStatusInFlight = false;
			session.streamStatusAgain = false;
			/* Keep authenticated status-touch polling alive throughout buffered
			 * playback, even after the producer drain is complete. The ended worker
			 * then retains only its validated source fd for protected browser-audio
			 * Range requests and releases it on finish/Stop or lease expiry. */
			if (self._isCurrentCpuSession(session) && !session.finishing)
				self._scheduleCpuStreamStatus(
					session,
					runAgain ? 0 : CPU_STREAM_STATUS_INTERVAL_MS
				);
		});
	},

	_finishCpuPlayback: function (session, message, isError, force) {
		if (!this._isCurrentCpuSession(session))
			return Promise.resolve();
		if (!isError && !force && session.firstFrameSeen &&
		    Number.isFinite(session.videoMediaTime) &&
		    !Number.isFinite(session.videoPlaybackRate)) {
			/* A one-frame or sub-window clip has no second presentation timestamp
			 * from which to estimate speed. Normal speed is the only useful terminal
			 * clock for either audio path. */
			session.videoPlaybackRate = 1;
		}
		if (!isError && !force && session.pendingAudio &&
		    session.firstFrameSeen && Number.isFinite(session.videoMediaTime)) {
			this._activatePendingCpuAudio(session);
		}
		if (!isError && !force && session.browserAudio &&
		    session.browserAudio.active &&
		    session.browserAudio.waitingForVideo &&
		    session.browserAudio.element &&
		    Number.isFinite(session.videoPlaybackRate)) {
			session.browserAudio.waitingForVideo = false;
			session.browserAudio.syncPaused = false;
			session.browserAudio.playPromise = this._playCpuBrowserAudio(
				session, session.browserAudio, false
			);
		}

		if (!isError && !force &&
		    ((session.audio &&
		      (session.audio.active || (session.audio.sources || []).length)) ||
		     (session.browserAudio && session.browserAudio.active &&
		      !session.browserAudio.ended &&
		      (session.browserAudio.playing ||
		       session.browserAudio.playPending ||
		       session.browserAudio.resolving ||
		       session.browserAudio.waitingForVideo)))) {
			if (!session.finishing) {
				const self = this;
				session.finishing = {
					message: message,
					isError: false
				};
				this._stopCpuStreamTransport(session, false);
				session.finishTimer = window.setTimeout(function () {
					if (self._isCurrentCpuSession(session) && session.finishing)
						self._finishCpuPlayback(session, message, false, true);
				}, CPU_AUDIO_DRAIN_TIMEOUT_MS);
			}
			return Promise.resolve();
		}

		const stopped = this._detachCpuSession(true);
		this._stopRendererBestEffort(stopped);
		this._currentSrc = null;
		this._currentKind = null;
		this._currentRenderMode = null;
		this._currentLabel = '';
		this._setPlayerSurface('none');
		this._setNowPlaying(message);
		if (isError)
			notify(null, E('p', {}, message), 8000, 'error');
		return Promise.resolve();
	},

	_scheduleCpuAudioPoll: function (session, delay) {
		const self = this;
		const audio = session && session.audio;

		if (!self._isCurrentCpuSession(session) || !audio || !audio.active ||
		    audio.ended || audio.producerEnded ||
		    (!session.bufferedPlayback && audio.videoHeld))
			return;
		if (audio.timer != null)
			window.clearTimeout(audio.timer);
		audio.timer = window.setTimeout(function () {
			audio.timer = null;
			self._pollCpuAudio(session);
		}, Math.max(0, Number(delay) || 0));
	},

	_nextCpuAudioNotReadyDelay: function (audio) {
		let delay = Number(audio && audio.notReadyDelay);

		if (!Number.isFinite(delay) || delay < CPU_AUDIO_NOT_READY_MIN_MS)
			delay = CPU_AUDIO_NOT_READY_MIN_MS;
		delay = Math.min(CPU_AUDIO_NOT_READY_MAX_MS, delay);
		if (audio)
			audio.notReadyDelay = Math.min(
				CPU_AUDIO_NOT_READY_MAX_MS,
				delay * 2
			);
		return delay;
	},

	_resetCpuAudioQueue: function (audio) {
		(audio.sources || []).forEach(function (source) {
			try { source.onended = null; source.stop(); }
			catch (err) {}
			try { source.disconnect(); }
			catch (err) {}
		});
		audio.sources = [];
		audio.nextPlayTime = 0;
	},

	_rebaseCpuAudio: function (session, audio) {
		let position;

		if (!session || !audio || !audio.active || session.audio !== audio)
			return;
		audio.pollGeneration =
			(Number(audio.pollGeneration) || 0) + 1;
		position = this._cpuAudioPositionForVideo(session);
		audio.sequence = position ? position.sequence : null;
		audio.startOffsetSequence = audio.sequence;
		audio.startOffsetSeconds = position ? position.offset : 0;
		audio.rebased = true;
		audio.missingSynchronizedChunks = 0;
		audio.inFlight = false;
		audio.inFlightGeneration = null;
		this._resetCpuAudioQueue(audio);
		if (this._isCurrentCpuSession(session))
			this._scheduleCpuAudioPoll(session, 0);
	},

	_decodeCpuAudioChunk: function (session, arrayBuffer, sequence) {
		const self = this;
		const audio = session.audio;
		const context = audio && audio.context;

		if (!audio || !audio.active || !context ||
		    !(arrayBuffer instanceof ArrayBuffer) ||
		    arrayBuffer.byteLength !== CPU_AUDIO_CHUNK_BYTES)
			throw new Error(_('The router returned an invalid audio chunk.'));

		const data = new DataView(arrayBuffer);
		const buffer = context.createBuffer(
			CPU_AUDIO_CHANNELS,
			CPU_AUDIO_FRAMES_PER_CHUNK,
			CPU_AUDIO_SAMPLE_RATE
		);
		const left = buffer.getChannelData(0);
		const right = buffer.getChannelData(1);
		for (let i = 0; i < CPU_AUDIO_FRAMES_PER_CHUNK; i++) {
			left[i] = data.getInt16(i * 4, true) / 32768;
			right[i] = data.getInt16(i * 4 + 2, true) / 32768;
		}

		const now = context.currentTime;
		if (!audio.nextPlayTime ||
		    audio.nextPlayTime < now + 0.03 ||
		    audio.nextPlayTime > now + CPU_AUDIO_MAX_LEAD_SECONDS + 0.5)
			audio.nextPlayTime = now + CPU_AUDIO_INITIAL_LEAD_SECONDS;

		const source = context.createBufferSource();
		const startAt = audio.nextPlayTime;
		const startOffset = audio.startOffsetSequence === sequence
			? Math.min(
				CPU_AUDIO_CHUNK_MS / 1000 - 0.001,
				Math.max(0, Number(audio.startOffsetSeconds) || 0)
			)
			: 0;
		const playbackRate = 1;
		source.buffer = buffer;
		if (source.playbackRate) {
			try {
				if (typeof source.playbackRate.setValueAtTime === 'function')
					source.playbackRate.setValueAtTime(playbackRate, startAt);
				else
					source.playbackRate.value = playbackRate;
			}
			catch (err) {}
		}
		source.videoplayerStartAt = startAt;
		source.videoplayerPlaybackRate = playbackRate;
		source.videoplayerMediaStart =
			sequence * CPU_AUDIO_CHUNK_MS / 1000 + startOffset;
		source.videoplayerEndAt = startAt +
			(CPU_AUDIO_CHUNK_MS / 1000 - startOffset) / playbackRate;
		source.connect(audio.gain);
		audio.sources.push(source);
		source.onended = function () {
			const index = audio.sources.indexOf(source);
			if (index !== -1)
				audio.sources.splice(index, 1);
			try { source.disconnect(); }
			catch (err) {}
			self._finishCpuAudioDrain(session, audio);
		};
		source.start(startAt, startOffset);
		if (audio.startOffsetSequence === sequence) {
			audio.startOffsetSequence = null;
			audio.startOffsetSeconds = 0;
		}
		audio.nextPlayTime = source.videoplayerEndAt;
		audio.sequence = sequence + 1;
		audio.hasDecoded = true;
		audio.errors = 0;
	},

	_pollCpuBufferedAudio: function (session) {
		const self = this;
		const audio = session && session.audio;
		const pollGeneration = audio
			? Number(audio.pollGeneration) || 0
			: 0;
		const sequence = audio && Number(audio.fetchSequence);
		const count = audio
			? Math.max(1, Math.min(
				CPU_AUDIO_BATCH_MAX_CHUNKS,
				Number(audio.batchMaxChunks) || 1
			))
			: 1;

		if (!self._isCurrentCpuSession(session) || !session.bufferedPlayback ||
		    !audio || !audio.active || audio.producerEnded || audio.inFlight)
			return Promise.resolve();
		if (audio.context && audio.context.state === 'closed') {
			self._disableCpuAudio(
				session,
				_('The browser closed the router-decoded PCM output.')
			);
			return Promise.resolve();
		}
		if (!Number.isSafeInteger(sequence) || sequence < 0) {
			self._failCpuBufferedPlayback(
				session, _('The router PCM buffer entered an invalid state.')
			);
			return Promise.resolve();
		}
		if (Math.max(
				0,
				Number(audio.bufferedUntil) - Number(session.playedSeconds)
			) >= CPU_BUFFER_HIGH_WATER_SECONDS ||
		    (session.bufferState !== 'buffering' &&
		     self._cpuBufferedBytes(session) >=
			CPU_BUFFER_HARD_LIMIT_BYTES * 0.9)) {
			self._scheduleCpuAudioPoll(session, CPU_BUFFER_POLL_MS);
			return Promise.resolve();
		}
		audio.inFlight = true;
		audio.inFlightGeneration = pollGeneration;

		return request.get(audio.url, {
			responseType: 'blob',
			timeout: CPU_AUDIO_REQUEST_TIMEOUT_MS,
			cache: true,
			query: { chunk: String(sequence), count: String(count) }
		}).then(function (res) {
			if (!self._isCurrentCpuSession(session) ||
			    session.audio !== audio || !audio.active ||
			    (Number(audio.pollGeneration) || 0) !== pollGeneration)
				return { done: true };
			const responseAudioState = String(
				res.headers && res.headers.get('X-Videoplayer-Audio-State') || ''
			).toLowerCase();
			if (res.status !== 409 || responseAudioState !== 'busy')
				audio.busyStartedAt = null;
			if (res.status === 202) {
				audio.busyStartedAt = null;
				audio.errors = 0;
				return {
					retry: true,
					delay: self._nextCpuAudioNotReadyDelay(audio)
				};
			}
			if (res.status === 204) {
				audio.busyStartedAt = null;
				audio.notReadyDelay = null;
				audio.producerEnded = true;
				audio.ended = true;
				self._maybeStartCpuBufferedPlayback(session);
				self._scheduleCpuBufferedPresentation(session, 0);
				return { done: true };
			}
			if (res.status === 409 && String(
				res.headers && res.headers.get('X-Videoplayer-Audio-State') || ''
			).toLowerCase() === 'unavailable') {
				audio.busyStartedAt = null;
				audio.notReadyDelay = null;
				return self._disableCpuAudio(
					session,
					_('Router-decoded PCM audio became unavailable; using protected browser audio while router-rendered video continues.'),
					true
				).then(function () { return { done: true }; });
			}
			if (res.status === 409 && responseAudioState === 'busy') {
				const now = Date.now();

				audio.notReadyDelay = null;
				if (!Number.isFinite(audio.busyStartedAt))
					audio.busyStartedAt = now;
				if (now - audio.busyStartedAt < CPU_AUDIO_BUSY_RETRY_MS) {
					audio.errors = 0;
					return { retry: true, delay: 100 };
				}
				throw new Error(_('The router PCM buffer remained busy.'));
			}
			if (res.status === 409 || res.status === 404 || res.status === 410) {
				self._failCpuBufferedPlayback(
					session,
					_('The router PCM buffer no longer contains the next synchronized audio chunk.')
				);
				return { done: true };
			}
			if (!res.ok || res.status !== 200)
				throw new Error(
					_('Audio request failed with HTTP %d').format(res.status)
				);
			audio.busyStartedAt = null;
			audio.notReadyDelay = null;
			const type = String(res.headers.get('Content-Type') || '')
				.split(';', 1)[0].trim().toLowerCase();
			const format = String(
				res.headers.get('X-Videoplayer-Audio-Format') || ''
			).toLowerCase();
			const sequenceText = String(
				res.headers.get('X-Videoplayer-Audio-Sequence') || ''
			);
			const responseCountText = String(
				res.headers.get('X-Videoplayer-Audio-Chunk-Count') || '1'
			);
			const framesPerChunkText = String(
				res.headers.get('X-Videoplayer-Audio-Frames-Per-Chunk') ||
				res.headers.get('X-Videoplayer-Audio-Frames') || ''
			);
			const totalFramesText = String(
				res.headers.get('X-Videoplayer-Audio-Total-Frames') || ''
			);
			const sampleRate = Number(
				res.headers.get('X-Videoplayer-Audio-Sample-Rate')
			);
			const channels = Number(
				res.headers.get('X-Videoplayer-Audio-Channels')
			);
			const contentLength = Number(
				res.headers.get('Content-Length')
			);
			const responseCount = Number(responseCountText);
			const responseSequence = Number(sequenceText);
			const framesPerChunk = Number(framesPerChunkText);
			const totalFrames = Number(totalFramesText);

			if (type !== 'application/octet-stream' || format !== 's16le' ||
			    !/^(0|[1-9][0-9]{0,7})$/.test(sequenceText) ||
			    responseSequence !== sequence ||
			    !/^[1-2]$/.test(responseCountText) ||
			    responseCount > count ||
			    sampleRate !== CPU_AUDIO_SAMPLE_RATE ||
			    channels !== CPU_AUDIO_CHANNELS ||
			    framesPerChunk !== CPU_AUDIO_FRAMES_PER_CHUNK ||
			    totalFrames !== responseCount * CPU_AUDIO_FRAMES_PER_CHUNK ||
			    contentLength !== responseCount * CPU_AUDIO_CHUNK_BYTES)
				throw new Error(_('The router returned invalid buffered audio metadata.'));

			const blob = res.blob();
			if (!blob || blob.size !== contentLength)
				throw new Error(_('The router returned an invalid buffered audio batch.'));
			return blobToArrayBuffer(blob).then(function (arrayBuffer) {
				if (!self._isCurrentCpuSession(session) ||
				    session.audio !== audio || !audio.active ||
				    (Number(audio.pollGeneration) || 0) !== pollGeneration)
					return { done: true };
				if (!(arrayBuffer instanceof ArrayBuffer) ||
				    arrayBuffer.byteLength !== contentLength)
					throw new Error(_('The router returned an invalid buffered audio batch.'));
				if (self._cpuBufferedBytes(session) + arrayBuffer.byteLength >
				    CPU_BUFFER_HARD_LIMIT_BYTES) {
					self._failCpuBufferedPlayback(
						session,
						_('The two-minute router render buffer exceeded the 512 MiB browser memory safety limit.')
					);
					return { done: true };
				}
				for (let i = 0; i < responseCount; i++) {
					const chunkSequence = sequence + i;
					const chunk = arrayBuffer.slice(
						i * CPU_AUDIO_CHUNK_BYTES,
						(i + 1) * CPU_AUDIO_CHUNK_BYTES
					);
					audio.bufferedChunks[chunkSequence] = chunk;
					audio.bufferedBytes += chunk.byteLength;
				}
				audio.fetchSequence += responseCount;
				audio.sequence = audio.fetchSequence;
				audio.bufferedUntil = audio.fetchSequence *
					CPU_AUDIO_CHUNK_MS / 1000;
				audio.hasDecoded = true;
				audio.errors = 0;
				if (session.bufferState === 'playing')
					self._fillCpuBufferedAudioQueue(session);
				self._maybeStartCpuBufferedPlayback(session);
				self._updateCpuBufferedCounters(session, false);
				return { retry: true, delay: 0 };
			});
		}).then(function (result) {
			if (!result || result.done ||
			    !self._isCurrentCpuSession(session) ||
			    session.audio !== audio || !audio.active ||
			    audio.producerEnded ||
			    (Number(audio.pollGeneration) || 0) !== pollGeneration)
				return;
			self._scheduleCpuAudioPoll(session, result.delay || 0);
		}).catch(function (err) {
			if (!self._isCurrentCpuSession(session) ||
			    session.audio !== audio || !audio.active ||
			    (Number(audio.pollGeneration) || 0) !== pollGeneration)
				return;
			audio.errors = (Number(audio.errors) || 0) + 1;
			if (audio.errors < 3) {
				self._scheduleCpuAudioPoll(
					session,
					Math.min(1000, 100 * Math.pow(2, audio.errors))
				);
				return;
			}
			self._failCpuBufferedPlayback(
				session,
				_('Router-decoded buffered PCM audio failed: %s')
					.format(errorText(err))
			);
		}).finally(function () {
			if (audio.inFlightGeneration === pollGeneration) {
				audio.inFlight = false;
				audio.inFlightGeneration = null;
			}
		});
	},

	_pollCpuAudio: function (session) {
		const self = this;
		const audio = session && session.audio;
		const pollGeneration = audio
			? Number(audio.pollGeneration) || 0
			: 0;
		const requestedChunk = audio && audio.sequence == null
			? 'live'
			: String(audio && audio.sequence);

		if (session && session.bufferedPlayback)
			return self._pollCpuBufferedAudio(session);
		if (!self._isCurrentCpuSession(session) || !audio || !audio.active ||
		    audio.ended ||
		    audio.inFlight || audio.videoHeld)
			return Promise.resolve();
		if (audio.context.state === 'closed') {
			self._disableCpuAudio(
				session,
				_('The browser closed the router-decoded PCM output.')
			);
			return Promise.resolve();
		}
		if (audio.nextPlayTime &&
		    audio.nextPlayTime - audio.context.currentTime >
				CPU_AUDIO_MAX_LEAD_SECONDS) {
			self._scheduleCpuAudioPoll(session, 100);
			return Promise.resolve();
		}
		audio.inFlight = true;
		audio.inFlightGeneration = pollGeneration;

		return request.get(audio.url, {
			responseType: 'blob',
			timeout: CPU_AUDIO_REQUEST_TIMEOUT_MS,
			cache: true,
			query: { chunk: requestedChunk }
		}).then(function (res) {
			if (!self._isCurrentCpuSession(session) ||
			    session.audio !== audio || !audio.active ||
			    (Number(audio.pollGeneration) || 0) !== pollGeneration)
				return { done: true };
			const responseAudioState = String(
				res.headers && res.headers.get('X-Videoplayer-Audio-State') || ''
			).toLowerCase();
			if (res.status !== 409 || responseAudioState !== 'busy')
				audio.busyStartedAt = null;
			if (res.status === 202) {
				audio.busyStartedAt = null;
				audio.errors = 0;
				if (!audio.hasDecoded &&
				    Date.now() - audio.startedAt > CPU_AUDIO_START_TIMEOUT_MS) {
					self._disableCpuAudio(
						session,
						_('The router-decoded PCM track did not become ready in time.')
					);
					return { done: true };
				}
				return { retry: true, delay: 125 };
			}
			if (res.status === 204) {
				audio.busyStartedAt = null;
				audio.notReadyDelay = null;
				self._endCpuAudioGracefully(session);
				return { done: true };
			}
			if (res.status === 410 && audio.sequence != null && !audio.rebased) {
				const synchronizedPosition =
					self._cpuAudioPositionForVideo(session);
				const synchronizedSequence = synchronizedPosition &&
					synchronizedPosition.sequence;
				audio.rebased = true;
				audio.missingSynchronizedChunks =
					(Number(audio.missingSynchronizedChunks) || 0) + 1;
				if (synchronizedSequence != null &&
				    synchronizedSequence !== audio.sequence &&
				    audio.missingSynchronizedChunks < 3) {
					audio.sequence = synchronizedSequence;
					audio.startOffsetSequence = synchronizedSequence;
					audio.startOffsetSeconds = synchronizedPosition.offset;
					self._resetCpuAudioQueue(audio);
					return { retry: true, delay: 0 };
				}
			}
			if (res.status === 409 && responseAudioState === 'busy') {
				const now = Date.now();

				audio.notReadyDelay = null;
				if (!Number.isFinite(audio.busyStartedAt))
					audio.busyStartedAt = now;
				if (now - audio.busyStartedAt < CPU_AUDIO_BUSY_RETRY_MS) {
					audio.errors = 0;
					return { retry: true, delay: 100 };
				}
			}
			if (res.status === 409 || res.status === 404 || res.status === 410) {
				self._disableCpuAudio(
					session,
					_('Router-decoded PCM audio is unavailable.')
				);
				return { done: true };
			}
			if (!res.ok || res.status !== 200)
				throw new Error(_('Audio request failed with HTTP %d').format(res.status));
			audio.busyStartedAt = null;
			audio.notReadyDelay = null;
			const type = String(res.headers.get('Content-Type') || '')
				.split(';', 1)[0].trim().toLowerCase();
			const contentLength = Number(res.headers.get('Content-Length'));
			const format = String(
				res.headers.get('X-Videoplayer-Audio-Format') || ''
			).toLowerCase();
			const sequenceText = String(
				res.headers.get('X-Videoplayer-Audio-Sequence') || ''
			);
			const sampleRate = Number(
				res.headers.get('X-Videoplayer-Audio-Sample-Rate')
			);
			const channels = Number(
				res.headers.get('X-Videoplayer-Audio-Channels')
			);
			const frames = Number(
				res.headers.get('X-Videoplayer-Audio-Frames')
			);
			if (type !== 'application/octet-stream' ||
			    contentLength !== CPU_AUDIO_CHUNK_BYTES ||
			    format !== 's16le' ||
			    !/^(0|[1-9][0-9]{0,7})$/.test(sequenceText) ||
			    sampleRate !== CPU_AUDIO_SAMPLE_RATE ||
			    channels !== CPU_AUDIO_CHANNELS ||
			    frames !== CPU_AUDIO_FRAMES_PER_CHUNK)
				throw new Error(_('The router returned invalid audio metadata.'));

			const sequence = Number(sequenceText);
			if (requestedChunk !== 'live' && sequence !== Number(requestedChunk))
				throw new Error(_('The router returned an unexpected audio chunk.'));
			const blob = res.blob();
			if (!blob || blob.size !== CPU_AUDIO_CHUNK_BYTES)
				throw new Error(_('The router returned an invalid audio chunk.'));
			return blobToArrayBuffer(blob).then(function (arrayBuffer) {
				if (!self._isCurrentCpuSession(session) ||
				    session.audio !== audio || !audio.active || audio.ended ||
				    (Number(audio.pollGeneration) || 0) !== pollGeneration)
					return { done: true };
				self._decodeCpuAudioChunk(session, arrayBuffer, sequence);
				audio.rebased = false;
				audio.missingSynchronizedChunks = 0;
				const lead = audio.nextPlayTime - audio.context.currentTime;
				return {
					retry: true,
					delay: lead > CPU_AUDIO_MAX_LEAD_SECONDS
						? (lead - CPU_AUDIO_MAX_LEAD_SECONDS + 0.05) * 1000
						: 0
				};
			});
		}).then(function (result) {
			if (!result || result.done ||
			    !self._isCurrentCpuSession(session) ||
			    session.audio !== audio || !audio.active || audio.ended ||
			    (Number(audio.pollGeneration) || 0) !== pollGeneration)
				return;
			self._scheduleCpuAudioPoll(session, result.delay || 0);
		}).catch(function (err) {
			if (!self._isCurrentCpuSession(session) ||
			    session.audio !== audio || !audio.active || audio.ended ||
			    (Number(audio.pollGeneration) || 0) !== pollGeneration)
				return;
			audio.errors++;
			if (audio.errors < 3) {
				self._scheduleCpuAudioPoll(
					session,
					Math.min(1000, 150 * Math.pow(2, audio.errors))
				);
				return;
			}
			self._disableCpuAudio(
				session,
				_('Router-decoded PCM audio failed: %s.')
					.format(errorText(err))
			);
		}).finally(function () {
			if (audio.inFlightGeneration === pollGeneration) {
				audio.inFlight = false;
				audio.inFlightGeneration = null;
			}
		});
	},

	_playCpuStream: function (res, label, generation, pendingAudio, relPath) {
		const self = this;
		const token = String(res.session_token || '');
		const streamUrl = String(res.stream_url || '');
		const segmentSeconds = Number(res.stream_segment_seconds);
		const hasAudio = flagOn(res.has_audio);
		const audioUrl = String(res.audio_url || '');
		const routerProfile = normalizeRouterProfile(
			res.router_profile || self._routerProfile
		);
		const audioMetadataValid = hasAudio &&
			/^\/cgi-bin\/videoplayer-audio\?token=[0-9a-f]{32}$/.test(audioUrl) &&
			audioUrl.slice(-32) === token &&
			res.audio_type === 'pcm-s16le-chunks' &&
			Number(res.audio_sample_rate) === CPU_AUDIO_SAMPLE_RATE &&
			Number(res.audio_channels) === CPU_AUDIO_CHANNELS &&
			Number(res.audio_frames_per_chunk) === CPU_AUDIO_FRAMES_PER_CHUNK;
		const requireBufferedPlayback = !!String(relPath || '');
		let bufferedUnavailableReason = '';
		let canvas = null;
		let canvasContext = null;

		if (!/^[0-9a-f]{32}$/.test(token) ||
		    !/^\/cgi-bin\/videoplayer-frame\?token=[0-9a-f]{32}$/.test(streamUrl) ||
		    streamUrl.slice(-32) !== token ||
		    normalizeRenderMode(res.render_mode) !== 'router' ||
		    res.stream_type !== 'mjpeg-stream' ||
		    res.mime !== 'multipart/x-mixed-replace' ||
		    !Number.isInteger(segmentSeconds) ||
		    segmentSeconds < 10 ||
		    segmentSeconds > 55) {
			self._disposeCpuAudio(pendingAudio);
			if (/^[0-9a-f]{32}$/.test(token))
				callStopRenderer(token).catch(function () {});
			self._currentKind = null;
			self._currentRenderMode = null;
			self._currentSrc = null;
			self._setPlayerSurface('none');
			self._setNowPlaying(_('The router renderer returned an invalid session.'));
			notify(null, E('p', {}, _('The router renderer returned an invalid session.')),
				7000, 'error');
			return Promise.resolve();
		}

		self._preparePlaybackSurface();
		if (generation !== self._playGeneration) {
			self._disposeCpuAudio(pendingAudio);
			callStopRenderer(token).catch(function () {});
			return Promise.resolve();
		}
		if (!audioMetadataValid) {
			self._disposeCpuAudio(pendingAudio);
			pendingAudio = null;
		}
		else if (pendingAudio) {
			pendingAudio.url = audioUrl;
		}
		if (requireBufferedPlayback && hasAudio && !audioMetadataValid)
			bufferedUnavailableReason = _('The router returned invalid PCM metadata required for synchronized buffering.');
		else if (requireBufferedPlayback) {
			canvas = document.getElementById('videoplayer-cpu-canvas');
			try {
				canvasContext = self._canUseCpuFetchStream() && canvas &&
					typeof canvas.getContext === 'function'
					? canvas.getContext('2d')
					: null;
			}
			catch (err) { canvasContext = null; }
			if (!canvasContext)
				bufferedUnavailableReason = _('This browser cannot provide the canvas and streaming APIs required for synchronized router buffering.');
		}
		if (bufferedUnavailableReason) {
			self._disposeCpuAudio(pendingAudio);
			callStopRenderer(token).catch(function () {});
			notify(null, E('p', {},
				_('%s Using browser decoding instead; fallback starts muted.')
					.format(bufferedUnavailableReason)),
			9000, 'warning');
			return callResolve(relPath).then(function (fallback) {
				if (generation !== self._playGeneration || !fallback ||
				    fallback.error || !fallback.stream_url)
					throw new Error(String(fallback && fallback.error ||
						_('The streamer did not return a playback URL.')));
				return self._playInVideo(
					fallback.stream_url, label, generation, 'local', true
				);
			}).catch(function (err) {
				if (generation !== self._playGeneration)
					return;
				self._currentKind = null;
				self._currentRenderMode = null;
				self._currentSrc = null;
				self._setPlayerSurface('none');
				self._setNowPlaying(
					_('Unable to play %s: %s').format(label, errorText(err))
				);
				notify(null, E('p', {},
					_('Browser fallback failed: %s').format(errorText(err))),
				7000, 'error');
			});
		}

		if (canvas && canvasContext) {
			try {
				canvasContext.clearRect(0, 0, canvas.width, canvas.height);
			}
			catch (err) {}
		}

		const session = {
			token: token,
			streamUrl: streamUrl,
			streamSegmentMs: segmentSeconds * 1000,
			generation: generation,
			label: label,
			relPath: String(relPath || ''),
			profile: routerProfile,
			fps: normalizeRouterFpsForProfile(res.router_fps, routerProfile),
			active: true,
			bufferedPlayback: requireBufferedPlayback,
			bufferState: requireBufferedPlayback ? 'buffering' : null,
			producerEnded: false,
			videoProducerDrained: false,
			videoTerminalDrainConfirmed: false,
			videoTerminalDrainBodyClean: false,
			videoTerminalDrainCandidateId: null,
			videoTerminalDrainRetryConsume: false,
			videoTerminalDrainStartedAt: null,
			videoTerminalDrainErrors: 0,
			durationSeconds: Number.isSafeInteger(Number(res.duration_ms)) &&
				Number(res.duration_ms) > 0
				? Number(res.duration_ms) / 1000
				: null,
			durationSealed: false,
			totalFrames: Number.isSafeInteger(Number(res.total_frames)) &&
				Number(res.total_frames) > 0
				? Number(res.total_frames)
				: null,
			canvas: canvas,
			canvasContext: canvasContext,
			videoFrames: [],
			videoFrameIndex: 0,
			videoBufferBytes: 0,
			videoDecodeBytes: 0,
			videoDecodeInFlight: null,
			videoDecodeGeneration: 0,
			displayedSequence: -1,
			lastBufferedFrameSequence: -1,
			lastDecodeFailureSequence: -1,
			renderedSeconds: 0,
			playedSeconds: 0,
			renderRateAnchorAt: null,
			renderRateAnchorSeconds: null,
			renderSpeed: null,
			renderEffectiveFps: null,
			renderCapacityHeld: false,
			playClockMediaBase: 0,
			playClockContextAt: null,
			playClockWallAt: null,
			bufferResumeGeneration: 0,
			presentationTimer: null,
			presentationTimerType: null,
			counterUpdatedAt: null,
			bufferFallbackPending: false,
			audioBatchMaxChunks: Math.max(
				1,
				Math.min(
					CPU_AUDIO_BATCH_MAX_CHUNKS,
					Number(res.audio_batch_max_chunks) || 1
				)
			),
			firstFrameSeen: false,
			firstFrameAt: null,
			visibleFrame: document.getElementById('videoplayer-cpu-frame'),
			streamAttempt: 0,
			streamPending: null,
			streamVisibleAttempt: null,
			streamTransportMode: null,
			streamFrameSequence: 0,
			streamLastFrameAt: null,
			streamOutageStartedAt: null,
			streamNextHandoffAt: null,
			streamHiddenAt: null,
			streamErrors: 0,
			streamWarned: false,
			streamFetchErrors: 0,
			fetchDisabled: false,
			fetchFallbackWarned: false,
			streamProbeTimer: null,
			streamProbeAttempt: null,
			streamRefreshTimer: null,
			streamReconnectTimer: null,
			streamStatusTimer: null,
			streamStatusInFlight: false,
			streamStatusAgain: false,
			streamStatusErrors: 0,
			streamStatusWarned: false,
			videoMediaTime: null,
			videoFrameAt: null,
			videoPlaybackRate: null,
			videoRateAnchorMedia: null,
			videoRateAnchorAt: null,
			nativeMediaBase: 0,
			avSyncTimer: null,
			audio: null,
			pendingAudio: pendingAudio,
			audioWarned: false,
			audioFailureReason: '',
			audioDrainer: null,
			browserAudio: null,
			browserAudioFailed: false,
			browserAudioWarned: false,
			browserAudioPrompted: false,
			finishing: null,
			finishTimer: null
		};
		self._cpuSession = session;
		self._currentKind = 'local';
		self._currentRenderMode = 'router';
		self._currentLabel = label;
		self._currentSrc = streamUrl;
		if (session.bufferedPlayback && audioMetadataValid && !pendingAudio)
			self._startCpuAudioDrainer(
				session, audioUrl, 0, session.audioBatchMaxChunks
			);
		self._setPlayerSurface(
			session.bufferedPlayback ? 'cpu-buffered' : 'cpu'
		);
		self._setNowPlaying(
			session.bufferedPlayback
				? _('Rendering the initial two-minute buffer on the router: %s (%s profile, target %d FPS)')
					.format(label, session.profile, session.fps)
				: _('Starting router CPU renderer: %s (%s profile, target %d FPS)')
					.format(label, session.profile, session.fps)
		);
		if (session.bufferedPlayback)
			self._updateCpuBufferedCounters(session, true);
		self._openCpuStream(session);
		self._scheduleCpuStreamStatus(session, 0);
		if (session.pendingAudio) {
			if (session.bufferedPlayback)
				self._activatePendingCpuAudio(session);
			/* CPU mode deliberately uses router-decoded PCM as its primary sound.
			 * Sequential chunks are buffered in the browser and played on one fixed
			 * 1x Web Audio clock; video holds and refills with that clock instead of
			 * changing audio speed or pitch. */
			self._updateCpuAudioPresentation(session);
			return Promise.resolve(true);
		}

		let fallbackReason;
		if (!hasAudio)
			fallbackReason = _('Router FFmpeg could not provide a usable PCM audio track.');
		else if (!audioMetadataValid)
			fallbackReason = _('The router returned invalid PCM audio metadata.');
		else
			fallbackReason = _('This browser could not start the PCM Web Audio output.');
		return self._startCpuBrowserAudioFallback(session, fallbackReason);
	},

	_playLocal: function (relPath, name) {
		const self = this;
		relPath = String(relPath || '').replace(/^\/+/, '');
		let useRouter = self._renderMode === 'router' && self._canWriteSettings;
		let unavailableReason = '';
		let pendingAudio = null;

		if (self._localResolvePending) {
			notify(null, _('Another local video is still being prepared.'), 3000, 'warning');
			return Promise.resolve();
		}

		if (!self._localEnabled) {
			notify(null, E('p', {}, _('Local streamer is disabled')), 5000, 'warning');
			return Promise.resolve();
		}

		if (self._mediaPathExplicitlyInvalid()) {
			notify(null, E('p', {},
				_('Media directory is invalid or unsafe: %s').format(self._status.media_path || '/mnt/video')),
			6000, 'warning');
			return Promise.resolve();
		}

		if (!relPath) {
			notify(null, E('p', {}, _('No file path for playback')), 6000, 'error');
			return Promise.resolve();
		}
		if (useRouter && self._rendererAvailable === false) {
			unavailableReason = String(
				(self._status && self._status.renderer_reason) ||
				_('FFmpeg capability check failed')
			);
			useRouter = false;
		}
		if (self._renderMode === 'router' && !self._canWriteSettings) {
			notify(null,
				_('Router CPU rendering requires write permission. Using browser decoding for this account.'),
				5000, 'warning');
		}

		const label = name || relPath;
		const generation = ++self._playGeneration;
		self._preparePlaybackSurface();
		if (useRouter) {
			pendingAudio = self._createCpuAudio();
			self._pendingCpuAudio = pendingAudio;
		}
		self._currentKind = 'local';
		self._currentRenderMode = useRouter ? 'router' : 'browser';
		self._currentLabel = label;
		self._setNowPlaying(_('Preparing local video: %s').format(label));
		self._localResolvePending = true;

		const discardPendingAudio = function () {
			if (self._pendingCpuAudio === pendingAudio)
				self._pendingCpuAudio = null;
			self._disposeCpuAudio(pendingAudio);
			pendingAudio = null;
		};
		const fallbackToBrowser = function (routerError) {
			routerError = String(routerError || _('Unknown router renderer error'));
			discardPendingAudio();
			if (generation !== self._playGeneration || !self._canBrowseLocal())
				return { error: routerError };

			return callResolve(relPath).then(function (fallback) {
				fallback = fallback || {};
				fallback.router_fallback_reason = routerError;
				return fallback;
			}, function (err) {
				return {
					error: errorText(err),
					router_fallback_reason: routerError
				};
			});
		};
		const preparation = useRouter
			? callStartRenderer(relPath).then(function (res) {
				res = res || {};
				if (!res.error)
					return res;
				return fallbackToBrowser(res.error);
			}, function (err) {
				return fallbackToBrowser(errorText(err));
			})
			: callResolve(relPath).then(function (res) {
				res = res || {};
				if (unavailableReason)
					res.router_fallback_reason = unavailableReason;
				return res;
			});

		return preparation.then(function (res) {
			res = res || {};
			if (generation !== self._playGeneration || !self._canBrowseLocal()) {
				discardPendingAudio();
				if (/^[0-9a-f]{32}$/.test(String(res.session_token || '')))
					callStopRenderer(res.session_token).catch(function () {});
				return;
			}

			if (res.error) {
				discardPendingAudio();
				const preparationError = res.router_fallback_reason
					? _('Router CPU renderer failed: %s Browser fallback also failed: %s')
						.format(res.router_fallback_reason, res.error)
					: res.error;
				self._currentKind = null;
				self._currentRenderMode = null;
				self._currentSrc = null;
				self._setPlayerSurface('none');
				self._setNowPlaying(_('Unable to prepare local video: %s').format(label));
				notify(null, E('p', {},
					_('Unable to prepare local video: %s').format(preparationError)),
				7000, 'error');
				return;
			}

			if (!res.stream_url) {
				discardPendingAudio();
				self._currentKind = null;
				self._currentRenderMode = null;
				self._currentSrc = null;
				self._setPlayerSurface('none');
				self._setNowPlaying(_('Unable to prepare local video: %s').format(label));
				notify(null, E('p', {}, _('The streamer did not return a playback URL.')), 7000, 'error');
				return;
			}

			if (res.router_fallback_reason) {
				notify(null, E('p', {},
					_('Router CPU renderer could not play %s: %s. Using browser decoding instead; fallback starts muted.')
						.format(label, res.router_fallback_reason)),
				9000, 'warning');
			}

			/* stream_url is an opaque, ACL-protected token URL. Router mode
			 * only appends a strictly numeric multipart reconnect nonce. */
			if (normalizeRenderMode(res.render_mode) === 'router' ||
			    res.stream_type === 'mjpeg-stream') {
				const audio = pendingAudio;
				if (self._pendingCpuAudio === audio)
					self._pendingCpuAudio = null;
				pendingAudio = null;
				return self._playCpuStream(
					res, label, generation, audio, relPath
				);
			}
			discardPendingAudio();
			return self._playInVideo(
				res.stream_url,
				label,
				generation,
				'local',
				!!res.router_fallback_reason
			);
		}).catch(function (err) {
			discardPendingAudio();
			if (generation !== self._playGeneration)
				return;

			self._currentKind = null;
			self._currentRenderMode = null;
			self._currentSrc = null;
			self._setPlayerSurface('none');
			self._setNowPlaying(_('Unable to prepare local video: %s').format(label));
			notify(null, E('p', {},
				_('Unable to prepare local video: %s').format(errorText(err))),
			7000, 'error');
		}).finally(function () {
			self._localResolvePending = false;
		});
	},

	_playRemote: function () {
		const self = this;
		const input = document.getElementById('videoplayer-remote-url');
		if (!input)
			return Promise.resolve();

		self._clearFieldError(input, 'vp-remote-url-error');

		if (!self._allowRemote) {
			notify(null, E('p', {}, _('Remote playback is disabled')), 5000, 'warning');
			return Promise.resolve();
		}

		const url = (input.value || '').trim();
		if (!url) {
			const message = _('Enter a media URL');
			self._setFieldError(input, 'vp-remote-url-error', message);
			notify(null, E('p', {}, message), 4000, 'warning');
			return Promise.resolve();
		}

		let parsedUrl;
		try {
			parsedUrl = new URL(url);
		}
		catch (err) {
			parsedUrl = null;
		}

		if (!parsedUrl ||
		    (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') ||
		    !parsedUrl.hostname) {
			const message = _('Enter a complete URL starting with http:// or https://');
			self._setFieldError(input, 'vp-remote-url-error', message);
			notify(null, E('p', {}, message), 5000, 'warning');
			return Promise.resolve();
		}

		const generation = ++self._playGeneration;
		return self._playInVideo(url, url, generation, 'remote');
	},

	_handleVideoError: function (ev) {
		const video = ev && ev.currentTarget;
		if (!video || !this._currentSrc || this._currentRenderMode !== 'browser')
			return;

		const code = video.error && video.error.code;
		let detail;
		switch (code) {
		case 1:
			detail = _('Playback was aborted.');
			break;
		case 2:
			detail = _('A network error interrupted playback.');
			break;
		case 3:
			detail = _('The video could not be decoded.');
			break;
		case 4:
			detail = _('The media format or URL is not supported.');
			break;
		default:
			detail = _('The browser reported an unknown media error.');
		}

		this._setNowPlaying(_('Playback error for %s').format(this._currentLabel || this._currentSrc));
		notify(null, E('p', {}, detail), 8000, 'error');
	},

	_handleVideoEnded: function () {
		if (!this._currentSrc || this._currentRenderMode !== 'browser')
			return;
		this._setNowPlaying(_('Playback ended: %s').format(this._currentLabel || this._currentSrc));
	},

	_handleVideoWaiting: function () {
		if (!this._currentSrc || this._currentRenderMode !== 'browser')
			return;
		this._setNowPlaying(_('Buffering: %s').format(this._currentLabel || this._currentSrc));
	},

	_handleVideoPlaying: function () {
		if (!this._currentSrc || this._currentRenderMode !== 'browser')
			return;
		this._setNowPlaying(_('Browser playback: %s').format(this._currentLabel || this._currentSrc));
	},

	_syncMuteControl: function (video, button) {
		if (this._currentRenderMode === 'router') {
			this._syncCpuMuteControl();
			return;
		}
		video = video || document.getElementById('videoplayer-video');
		button = button || document.getElementById('vp-mute-btn');
		if (!video || !button)
			return;

		button.textContent = video.muted ? _('Unmute') : _('Mute');
		button.setAttribute('aria-pressed', video.muted ? 'true' : 'false');
		button.disabled = false;
	},

	_handleVolumeChange: function (ev) {
		this._syncMuteControl(ev && ev.currentTarget);
	}
});
