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
const CPU_DEFAULT_FRAME_INTERVAL_MS = 125;
const CPU_MIN_FRAME_INTERVAL_MS = 17;
const CPU_MAX_FRAME_INTERVAL_MS = 200;
const CPU_HIDDEN_INTERVAL_MS = 2000;
const CPU_FRAME_REQUEST_TIMEOUT_MS = 2500;
const CPU_START_TIMEOUT_MS = 15000;
const CPU_MAX_FRAME_BYTES = 4194304;
const CPU_AUDIO_SAMPLE_RATE = 48000;
const CPU_AUDIO_CHANNELS = 2;
const CPU_AUDIO_FRAMES_PER_CHUNK = 12000;
const CPU_AUDIO_CHUNK_BYTES = 48000;
const CPU_AUDIO_CHUNK_MS = 250;
const CPU_AUDIO_REQUEST_TIMEOUT_MS = 2500;
const CPU_AUDIO_START_TIMEOUT_MS = 10000;
const CPU_AUDIO_DRAIN_TIMEOUT_MS = 5000;
const CPU_AUDIO_INITIAL_LEAD_SECONDS = 0.12;
const CPU_AUDIO_MAX_LEAD_SECONDS = 0.75;
const CPU_VIDEO_AUDIO_DELAY_MS =
	CPU_AUDIO_CHUNK_MS + Math.round(CPU_AUDIO_INITIAL_LEAD_SECONDS * 1000);
const CPU_MAX_MEDIA_OFFSET_MS = 21605000;

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

function normalizeFrameInterval(value) {
	value = Number(value);
	if (!Number.isFinite(value) ||
	    value < CPU_MIN_FRAME_INTERVAL_MS ||
	    value > CPU_MAX_FRAME_INTERVAL_MS)
		return CPU_DEFAULT_FRAME_INTERVAL_MS;
	return Math.round(value);
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
	handleSaveApply: null,
	handleSave: null,
	handleReset: null,

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

		const enabled = uci.get('videoplayer', 'main', 'enabled');
		const mediaPath = uci.get('videoplayer', 'main', 'media_path') || status.media_path || '/mnt/video';
		const allowRemote = uci.get('videoplayer', 'main', 'allow_remote');
		const configuredRenderMode = uci.get('videoplayer', 'main', 'render_mode');
		const configuredRouterFps = uci.get('videoplayer', 'main', 'router_fps');
		const localEnabled = enabled !== undefined
			? flagOn(enabled)
			: (status.enabled !== undefined ? flagOn(status.enabled) : true);
		const remoteAllowed = allowRemote !== undefined
			? flagOn(allowRemote)
			: (status.allow_remote !== undefined ? flagOn(status.allow_remote) : true);
		const renderMode = normalizeRenderMode(
			configuredRenderMode !== undefined ? configuredRenderMode : status.render_mode
		);
		const routerFps = normalizeRouterFps(
			configuredRouterFps !== undefined ? configuredRouterFps : status.router_fps
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
		self._localEnabled = localEnabled;
		self._allowRemote = remoteAllowed;
		self._renderMode = renderMode;
		self._routerFps = routerFps;
		self._rendererAvailable = rendererAvailable;
		self._canWriteSettings = canWriteSettings;
		self._statusLoadError = statusResult.error || null;
		self._status = {
			media_path: status.media_path || mediaPath,
			enabled: status.enabled !== undefined ? status.enabled : localEnabled,
			allow_remote: status.allow_remote !== undefined ? status.allow_remote : remoteAllowed,
			render_mode: normalizeRenderMode(status.render_mode || renderMode),
			router_fps: normalizeRouterFps(status.router_fps || routerFps),
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
				#videoplayer-root img#videoplayer-cpu-frame {
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
				#videoplayer-root video#videoplayer-video:-webkit-full-screen,
				#videoplayer-root img#videoplayer-cpu-frame:-webkit-full-screen {
					width: 100vw;
					height: 100vh;
					max-height: none;
					border-radius: 0;
					object-fit: contain;
					background: #000;
				}
				#videoplayer-root .vp-toolbar {
					display: flex;
					flex-wrap: wrap;
					gap: 8px;
					margin: 8px 0;
					align-items: center;
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
									selected: renderMode === 'browser' ? 'selected' : null
								}, _('Browser decoding (recommended)')),
								E('option', {
									value: 'router',
									selected: renderMode === 'router' ? 'selected' : null
								}, _('Router CPU rendering (experimental, browser fallback)'))
							]),
							E('div', {
								id: 'vp-render-mode-desc',
								class: 'cbi-value-description'
							}, _('Local files only. Router mode uses FFmpeg for video and, when possible, streams short PCM audio chunks to Web Audio in this page. If router-side audio is unavailable, the browser plays the original audio track while the router continues rendering video frames. This mode has no pause, seeking, or timeline and may heavily load the router. Codec support depends on the installed FFmpeg build and browser. If video decoding cannot start, the whole player falls back to browser decoding. Remote URLs always use browser decoding.')),
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
							for: 'vp-router-fps'
						}, _('Router frame rate')),
						E('div', { class: 'cbi-value-field' }, [
							E('select', {
								id: 'vp-router-fps',
								class: 'cbi-input-select',
								disabled: canWriteSettings ? null : 'disabled',
								'aria-describedby': 'vp-router-fps-desc'
							}, CPU_ROUTER_FPS_OPTIONS.map(function (fps) {
								return E('option', {
									value: String(fps),
									selected: routerFps === fps ? 'selected' : null
								}, _('%d FPS').format(fps));
							})),
							E('div', {
								id: 'vp-router-fps-desc',
								class: 'cbi-value-description'
							}, _('Used only for router CPU rendering. 8 FPS is the balanced default and 5 reduces load. Higher settings are progressively heavier; 60 FPS is the maximum target, may overload even fast routers, and is not guaranteed.'))
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
								checked: localEnabled ? 'checked' : null,
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
								value: mediaPath,
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
								checked: remoteAllowed ? 'checked' : null,
								disabled: canWriteSettings ? null : 'disabled',
								'aria-describedby': 'vp-allow-remote-desc'
							}),
							E('div', {
								id: 'vp-allow-remote-desc',
								class: 'cbi-value-description'
							}, _('If disabled, only local files can be played from this page.'))
						])
					]),
					E('div', { class: 'cbi-page-actions' }, [
						E('button', {
							id: 'vp-save-settings',
							type: 'button',
							class: 'btn cbi-button cbi-button-save',
							disabled: canWriteSettings ? null : 'disabled',
							click: ui.createHandlerFn(self, 'handleSaveSettings')
						}, _('Save settings')),
						canWriteSettings ? '' : E('span', {
							class: 'cbi-value-description',
							role: 'status'
						}, _('Settings are read-only for the current LuCI account.'))
					])
				])
			]),

			/* Player */
			E('h3', {}, _('Player')),
			E('div', { class: 'cbi-section' }, [
				E('div', { class: 'cbi-section-node' }, [
					E('div', { class: 'vp-player-wrap' }, [
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
							hidden: 'hidden',
							'alt': _('Router-rendered video frame')
						})
					]),
					E('div', {
						id: 'videoplayer-nowplaying',
						class: 'cbi-value-description',
						role: 'status',
						'aria-live': 'polite',
						'aria-atomic': 'true'
					}, _('Nothing playing. Choose a local file or enter a remote URL.')),
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
					}, _('Router CPU mode has no pause, seeking, or timeline. Video frames are rendered by the router. Audio uses router-decoded PCM when available and otherwise falls back to browser decoding.'))
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
								disabled: remoteAllowed ? null : 'disabled',
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
							disabled: remoteAllowed ? null : 'disabled',
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
							disabled: localEnabled ? null : 'disabled',
							click: function (ev) {
								ev.preventDefault();
								return self._browse('', 0, { focusCwd: true });
							}
						}, _('Root')),
						E('button', {
							id: 'vp-refresh-btn',
							type: 'button',
							class: 'btn cbi-button',
							disabled: localEnabled ? null : 'disabled',
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

		return root;
	},

	handleSaveSettings: function () {
		const self = this;
		const enabledEl = document.getElementById('vp-enabled');
		const pathEl = document.getElementById('vp-media-path');
		const remoteEl = document.getElementById('vp-allow-remote');
		const renderModeEl = document.getElementById('vp-render-mode');
		const routerFpsEl = document.getElementById('vp-router-fps');
		let path = (pathEl && pathEl.value || '').trim();
		const renderMode = normalizeRenderMode(renderModeEl && renderModeEl.value);
		const routerFps = normalizeRouterFps(routerFpsEl && routerFpsEl.value);

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

		const previousPath = String(
			uci.get('videoplayer', 'main', 'media_path') ||
			(self._status && self._status.media_path) ||
			'/mnt/video'
		).replace(/\/+$/, '');
		const pathChanged = path !== previousPath;
		const modeChanged = renderMode !== normalizeRenderMode(
			uci.get('videoplayer', 'main', 'render_mode') || self._renderMode
		);
		const fpsChanged = routerFps !== normalizeRouterFps(
			uci.get('videoplayer', 'main', 'router_fps') || self._routerFps
		);
		const localEnabled = !!(enabledEl && enabledEl.checked);
		const remoteAllowed = !!(remoteEl && remoteEl.checked);
		let statusRefreshError = null;

		self._setSaveBusy(true);

		uci.set('videoplayer', 'main', 'enabled', localEnabled ? '1' : '0');
		uci.set('videoplayer', 'main', 'media_path', path);
		uci.set('videoplayer', 'main', 'allow_remote', remoteAllowed ? '1' : '0');
		uci.set('videoplayer', 'main', 'render_mode', renderMode);
		uci.set('videoplayer', 'main', 'router_fps', String(routerFps));

		return uci.save().then(function () {
			return uci.apply();
		}).then(function () {
			self._localEnabled = localEnabled;
			self._allowRemote = remoteAllowed;
			self._renderMode = renderMode;
			self._routerFps = routerFps;
			self._statusLoadError = null;
			self._status = {
				media_path: path,
				enabled: localEnabled,
				allow_remote: remoteAllowed,
				render_mode: renderMode,
				router_fps: routerFps,
				renderer_available: self._rendererAvailable,
				renderer_reason: self._status && self._status.renderer_reason,
				media_path_valid: undefined,
				media_path_exists: undefined,
				media_path_readable: undefined
			};

			/* Stop stale work as soon as the new UCI values have been applied. */
			self._browseRequestId++;
			self._browseLoading = true;
			if ((!localEnabled || pathChanged || modeChanged ||
			     (fpsChanged && self._currentRenderMode === 'router')) &&
			    self._currentKind === 'local')
				self.handleStop();
			else if (!remoteAllowed && self._currentKind === 'remote')
				self.handleStop();

			return callStatus().then(function (st) {
				st = st || {};
				self._status = {
					media_path: st.media_path || path,
					enabled: st.enabled !== undefined ? st.enabled : localEnabled,
					allow_remote: st.allow_remote !== undefined ? st.allow_remote : remoteAllowed,
					render_mode: normalizeRenderMode(st.render_mode || renderMode),
					router_fps: normalizeRouterFps(st.router_fps || routerFps),
					renderer_available: st.renderer_available,
					renderer_reason: st.renderer_reason,
					media_path_valid: st.media_path_valid,
					media_path_exists: st.media_path_exists,
					media_path_readable: st.media_path_readable
				};
				self._localEnabled = st.enabled !== undefined ? flagOn(st.enabled) : localEnabled;
				self._allowRemote = st.allow_remote !== undefined ? flagOn(st.allow_remote) : remoteAllowed;
				self._renderMode = normalizeRenderMode(st.render_mode || renderMode);
				self._routerFps = normalizeRouterFps(st.router_fps || routerFps);
				self._rendererAvailable = st.renderer_available === undefined
					? null
					: flagOn(st.renderer_available);
			}, function (err) {
				statusRefreshError = err;
				self._statusLoadError = err;
			});
		}).then(function () {
			if (pathEl)
				pathEl.value = self._status.media_path || path;
			if (enabledEl)
				enabledEl.checked = self._localEnabled;
			if (remoteEl)
				remoteEl.checked = self._allowRemote;
			if (renderModeEl)
				renderModeEl.value = self._renderMode;
			if (routerFpsEl)
				routerFpsEl.value = String(self._routerFps);

			if (pathChanged) {
				self._cwd = '';
				self._offset = 0;
			}

			self._browseLoading = false;
			if ((!self._canBrowseLocal() || pathChanged || modeChanged ||
			     (fpsChanged && self._currentRenderMode === 'router')) &&
			    self._currentKind === 'local')
				self.handleStop();
			else if (!self._allowRemote && self._currentKind === 'remote')
				self.handleStop();

			self._syncRemoteControls();
			self._syncLocalControls();

			const cwd = document.getElementById('videoplayer-cwd');
			if (cwd)
				cwd.textContent = self._formatCwdLabel(self._cwd);

			const line = document.getElementById('videoplayer-status-line');
			if (line)
				line.textContent = self._mediaStatusText(self._status);
			self._updateRendererStatus();

			if (statusRefreshError) {
				notify(null, E('p', {},
					_('Settings saved, but status refresh failed: %s').format(errorText(statusRefreshError))),
				7000, 'warning');
			}
			else {
				notify(null, _('Settings saved'), 3000);
			}

			if (self._canBrowseLocal())
				return self._browse(pathChanged ? '' : self._cwd, 0, { focusCwd: pathChanged });

			self._renderLocalUnavailable();
			return Promise.resolve();
		}).then(function (result) {
			self._setSaveBusy(false);
			return result;
		}, function (err) {
			self._setSaveBusy(false);
			notify(null, E('p', {}, _('Save failed: %s').format(errorText(err))), 7000, 'error');
		});
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
					(audio.context && audio.context.state &&
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
					if (suspended && audio.resumeRebasePending) {
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
				    (browserAudio.playing || browserAudio.playPending)) {
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
					notify(null, _('Browser audio will start with the first video frame.'), 2000, 'info');
					return Promise.resolve();
				}
				browserAudio.muted = false;
				browserAudio.needsGesture = false;
				browserAudio.element.muted = false;
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
		const frame = document.getElementById('videoplayer-cpu-frame');
		const target = this._currentRenderMode === 'router' ? frame : v;
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

	_setSaveBusy: function (busy) {
		const button = document.getElementById('vp-save-settings');
		if (!button)
			return;

		button.disabled = !!busy || !this._canWriteSettings;
		button.setAttribute('aria-busy', busy ? 'true' : 'false');
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
			statusEl.textContent = _('The FFmpeg output pipeline is available. Router playback uses %d FPS. Audio uses router-decoded PCM when available and otherwise falls back to browser decoding. Expect high CPU usage; video startup failures fall back to full browser decoding.').format(this._routerFps);
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
		if (note && session) {
			if (pcm) {
				note.textContent = pcmSuspended
					? _('Video frames are rendered by the router CPU. PCM audio is ready; press Unmute to allow browser audio output.')
					: _('Video frames are rendered by the router CPU. Audio is decoded to PCM by the router and played by this browser.');
			}
			else if (browserAudio) {
				if (browserAudio.resolving || browserAudio.waitingForVideo) {
					note.textContent = _('Video frames are rendered by the router CPU. Preparing browser-decoded audio…');
				}
				else {
					note.textContent = browserAudio.needsGesture || browserAudio.muted
						? _('Video frames are rendered by the router CPU. Audio is decoded by the browser; press Unmute to enable sound.')
						: _('Video frames are rendered by the router CPU while audio is decoded and played by the browser.');
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
				_('Router CPU playback: %s (%d FPS, PCM audio)')
					.format(session.label, session.fps)
			);
		}
		else if (browserAudio) {
			this._setNowPlaying(
				_('Router CPU playback: %s (%d FPS, browser audio)')
					.format(session.label, session.fps)
			);
		}
		else {
			this._setNowPlaying(
				_('Router CPU playback: %s (%d FPS, silent)')
					.format(session.label, session.fps)
			);
		}
	},

	_positionCpuBrowserAudio: function (session, browserAudio) {
		const element = browserAudio && browserAudio.element;
		const startedAt = session && session.firstFrameAt;
		const offsetReceivedAt = browserAudio &&
			browserAudio.offsetReceivedAt;
		const mediaOffsetMs = browserAudio &&
			browserAudio.mediaOffsetMs;
		let target;

		if (!element)
			return;
		if (Number.isFinite(offsetReceivedAt) &&
		    Number.isFinite(mediaOffsetMs)) {
			target = Math.max(
				0,
				(mediaOffsetMs +
				 Date.now() - offsetReceivedAt -
				 Math.max(0, Number(session && session.videoDelayMs) || 0)) /
					1000
			);
		}
		else if (Number.isFinite(startedAt)) {
			target = Math.max(0, (Date.now() - startedAt) / 1000);
		}
		else {
			return;
		}
		if (Number.isFinite(element.duration) && element.duration > 0)
			target = Math.min(target, Math.max(0, element.duration - 0.05));
		if (target < 0.25)
			return;
		try {
			if (!Number.isFinite(element.currentTime) ||
			    Math.abs(element.currentTime - target) > 0.75)
				element.currentTime = target;
		}
		catch (err) {
			/* loadedmetadata retries this for browsers that reject early seeks. */
		}
	},

	_failCpuBrowserAudio: function (session, browserAudio, message) {
		if (!session || !browserAudio ||
		    session.browserAudio !== browserAudio)
			return;
		session.browserAudio = null;
		session.audioFailureReason = String(
			message || _('The browser could not play this audio track.')
		);
		this._disposeCpuBrowserAudio(browserAudio);
		if (!this._isCurrentCpuSession(session))
			return;
		this._updateCpuAudioPresentation(session);
		if (!session.browserAudioWarned) {
			session.browserAudioWarned = true;
			notify(null, E('p', {}, session.audioFailureReason), 7000, 'warning');
		}
		if (session.finishing) {
			const finishing = session.finishing;
			session.finishing = null;
			if (session.finishTimer != null)
				window.clearTimeout(session.finishTimer);
			session.finishTimer = null;
			this._finishCpuPlayback(
				session, finishing.message, finishing.isError, true);
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
			element.onloadedmetadata = function () {
				if (self._isCurrentCpuSession(session) &&
				    session.browserAudio === browserAudio)
					self._positionCpuBrowserAudio(session, browserAudio);
			};
			element.onplaying = function () {
				if (!self._isCurrentCpuSession(session) ||
				    session.browserAudio !== browserAudio)
					return;
				browserAudio.playing = true;
				self._updateCpuAudioPresentation(session);
			};
			element.onpause = function () {
				if (!self._isCurrentCpuSession(session) ||
				    session.browserAudio !== browserAudio ||
				    browserAudio.ended)
					return;
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
				session.browserAudio = null;
				self._disposeCpuBrowserAudio(browserAudio);
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
			browserAudio.waitingForVideo = !session.firstFrameSeen;
			self._updateCpuAudioPresentation(session);
			if (!browserAudio.waitingForVideo)
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
				(audio.context && audio.context.state &&
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
					? _('Browser audio will start with the first video frame.')
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

	_disableCpuAudio: function (session, message) {
		const audio = session && session.audio;
		const finishing = session && session.finishing;

		if (!audio)
			return Promise.resolve(false);
		session.audio = null;
		this._disposeCpuAudio(audio);
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
				notify(null, E('p', {},
					_('%s Switching to browser audio.').format(message)),
				5000, 'info');
			}
			return this._startCpuBrowserAudioFallback(
				session, session.audioFailureReason
			);
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

	_setPlayerSurface: function (surface) {
		const video = document.getElementById('videoplayer-video');
		const frame = document.getElementById('videoplayer-cpu-frame');
		const note = document.getElementById('vp-cpu-player-note');
		const mute = document.getElementById('vp-mute-btn');
		const showVideo = surface === 'video';
		const showCpu = surface === 'cpu';

		if (video) {
			video.hidden = !showVideo;
			video.setAttribute('aria-hidden', showVideo ? 'false' : 'true');
		}
		if (frame) {
			frame.hidden = !showCpu;
			frame.setAttribute('aria-hidden', showCpu ? 'false' : 'true');
		}
		if (note)
			note.hidden = !showCpu;
		if (mute) {
			if (showCpu)
				this._syncCpuMuteControl();
			else {
				mute.disabled = !showVideo;
				mute.title = '';
			}
		}
	},

	_revokeObjectUrl: function (url) {
		if (!url || !window.URL || typeof window.URL.revokeObjectURL !== 'function')
			return;
		try {
			window.URL.revokeObjectURL(url);
		}
		catch (err) {
			/* Ignore cleanup failures from browsers with partial blob support. */
		}
	},

	_cancelCpuPolling: function (session, clearFrame) {
		const self = this;
		const frame = document.getElementById('videoplayer-cpu-frame');

		if (!session)
			return;
		session.active = false;
		if (session.timer != null)
			window.clearTimeout(session.timer);
		session.timer = null;
		if (session.decodeTimer != null)
			window.clearTimeout(session.decodeTimer);
		session.decodeTimer = null;
		if (session.finishTimer != null)
			window.clearTimeout(session.finishTimer);
		session.finishTimer = null;
		session.finishing = null;
		if (typeof session.cancelDecode === 'function')
			session.cancelDecode();
		session.cancelDecode = null;
		if (session.decoder) {
			session.decoder.onload = null;
			session.decoder.onerror = null;
			session.decoder.src = '';
		}
		session.decoder = null;
		this._revokeObjectUrl(session.nextObjectUrl);
		session.nextObjectUrl = null;
		(session.pendingFrames || []).forEach(function (queued) {
			if (queued.timer != null)
				window.clearTimeout(queued.timer);
			self._revokeObjectUrl(queued.url);
		});
		session.pendingFrames = [];

		if (clearFrame && frame)
			frame.removeAttribute('src');
		this._revokeObjectUrl(session.objectUrl);
		session.objectUrl = null;
		if (session.audio) {
			this._disposeCpuAudio(session.audio);
			session.audio = null;
		}
		if (session.browserAudio) {
			this._disposeCpuBrowserAudio(session.browserAudio);
			session.browserAudio = null;
		}
	},

	_detachCpuSession: function (clearFrame) {
		const session = this._cpuSession;

		if (!session)
			return null;
		this._cpuSession = null;
		this._cancelCpuPolling(session, clearFrame !== false);
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

	_scheduleCpuFramePoll: function (session, delay) {
		const self = this;

		if (!self._isCurrentCpuSession(session) || session.finishing)
			return;
		if (session.timer != null)
			window.clearTimeout(session.timer);
		session.timer = window.setTimeout(function () {
			session.timer = null;
			self._pollCpuFrame(session);
		}, Math.max(0, Number(delay) || 0));
	},

	_presentCpuFrame: function (session, objectUrl) {
		const frame = document.getElementById('videoplayer-cpu-frame');

		if (!this._isCurrentCpuSession(session) || !frame) {
			this._revokeObjectUrl(objectUrl);
			return;
		}
		const previous = session.objectUrl;
		frame.src = objectUrl;
		session.objectUrl = objectUrl;
		this._revokeObjectUrl(previous);
		if (!session.firstFrameSeen) {
			session.firstFrameSeen = true;
			session.firstFrameAt = Date.now();
			if (session.browserAudio &&
			    session.browserAudio.active &&
			    session.browserAudio.waitingForVideo) {
				session.browserAudio.waitingForVideo = false;
				session.browserAudio.playPromise =
					this._playCpuBrowserAudio(
						session, session.browserAudio, false
					);
			}
			this._updateCpuAudioPresentation(session);
		}
	},

	_queueCpuFrame: function (session, objectUrl) {
		const self = this;
		const queued = { url: objectUrl, timer: null };

		session.pendingFrames.push(queued);
		queued.timer = window.setTimeout(function () {
			const index = session.pendingFrames.indexOf(queued);
			if (index !== -1)
				session.pendingFrames.splice(index, 1);
			queued.timer = null;
			self._presentCpuFrame(session, objectUrl);
		}, Math.max(0, Number(session.videoDelayMs) || 0));
	},

	_installCpuFrame: function (session, blob) {
		const self = this;

		return new Promise(function (resolve, reject) {
			if (!self._isCurrentCpuSession(session)) {
				resolve();
				return;
			}

			const objectUrl = window.URL.createObjectURL(blob);
			const decoder = new Image();
			let settled = false;

			session.nextObjectUrl = objectUrl;
			session.decoder = decoder;

			const finish = function (ok, err) {
				const current = self._isCurrentCpuSession(session);

				if (settled)
					return;
				settled = true;
				if (session.decodeTimer != null)
					window.clearTimeout(session.decodeTimer);
				session.decodeTimer = null;
				decoder.onload = null;
				decoder.onerror = null;
				if (session.decoder === decoder)
					session.decoder = null;
				if (session.cancelDecode === cancelDecode)
					session.cancelDecode = null;

				if (!ok || !current) {
					if (session.nextObjectUrl === objectUrl)
						session.nextObjectUrl = null;
					self._revokeObjectUrl(objectUrl);
					if (ok || !current)
						resolve();
					else
						reject(err || new Error(_('The router returned an invalid video frame.')));
					return;
				}

				session.nextObjectUrl = null;
				self._queueCpuFrame(session, objectUrl);
				resolve();
			};
			const cancelDecode = function () {
				finish(true);
			};

			session.cancelDecode = cancelDecode;
			decoder.onload = function () { finish(true); };
			decoder.onerror = function () {
				finish(false, new Error(_('The router returned a JPEG frame the browser could not decode.')));
			};
			session.decodeTimer = window.setTimeout(function () {
				finish(false, new Error(_('Timed out while decoding a router-rendered frame.')));
			}, 1500);
			decoder.src = objectUrl;
		});
	},

	_finishCpuPlayback: function (session, message, isError, force) {
		if (!this._isCurrentCpuSession(session))
			return Promise.resolve();

		if (!isError && !force &&
		    (((session.pendingFrames || []).length > 0) ||
		     (session.audio &&
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
				if (session.timer != null)
					window.clearTimeout(session.timer);
				session.timer = null;
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

	_handleCpuPollFailure: function (session, err) {
		const self = this;

		if (!self._isCurrentCpuSession(session))
			return Promise.resolve();
		session.errors++;

		if (session.errors < 3) {
			self._scheduleCpuFramePoll(session, 500);
			return Promise.resolve();
		}

		return callRendererStatus(session.token).then(function (res) {
			if (!self._isCurrentCpuSession(session))
				return;
			const state = res && res.state || 'error';
			if (state === 'ended' || state === 'stopped' || state === 'expired' || state === 'inactive') {
				return self._finishCpuPlayback(
					session,
					_('Router CPU playback ended: %s').format(session.label),
					false
				);
			}
			if (state === 'error') {
				const reason = String(res && res.reason || '').trim();
				return self._finishCpuPlayback(
					session,
					reason
						? _('Router CPU renderer failed for %s: %s').format(session.label, reason)
						: _('Router CPU renderer failed for %s. The installed FFmpeg build may not support this video codec.').format(session.label),
					true
				);
			}

			if (session.errors >= 5 && !session.warned) {
				session.warned = true;
				notify(null, E('p', {},
					_('Router-rendered frames are temporarily unavailable: %s').format(errorText(err))),
				7000, 'warning');
			}
			self._scheduleCpuFramePoll(
				session,
				Math.min(2000, 250 * Math.pow(2, Math.min(session.errors, 3)))
			);
		}).catch(function () {
			if (self._isCurrentCpuSession(session))
				self._scheduleCpuFramePoll(session, 2000);
		});
	},

	_pollCpuFrame: function (session) {
		const self = this;
		const started = Date.now();

		if (!self._isCurrentCpuSession(session))
			return Promise.resolve();
		session.sequence++;

		return request.get(session.frameUrl, {
			responseType: 'blob',
			timeout: CPU_FRAME_REQUEST_TIMEOUT_MS,
			/* The unique frame query plus no-store response headers prevent
			 * caching. LuCI's cache:false adds a second bare query field,
			 * which the intentionally strict CGI parser rejects. */
			cache: true,
			query: {
				frame: String(session.generation) + '-' + String(session.sequence)
			}
		}).then(function (res) {
			if (!self._isCurrentCpuSession(session))
				return;

			if (res.status === 202) {
				if (Date.now() - session.startedAt > CPU_START_TIMEOUT_MS) {
					return self._finishCpuPlayback(
						session,
						_('Router renderer did not produce a frame in time.'),
						true
					);
				}
				return;
			}
			if (res.status === 410 || res.status === 404) {
				return self._finishCpuPlayback(
					session,
					_('Router CPU playback ended: %s').format(session.label),
					false
				);
			}
			if (!res.ok || res.status !== 200)
				throw new Error(_('Frame request failed with HTTP %d').format(res.status));

			const type = String(res.headers.get('Content-Type') || '')
				.split(';', 1)[0].trim().toLowerCase();
			const blob = res.blob();
			if (type !== 'image/jpeg' || !blob || !blob.size ||
			    blob.size > CPU_MAX_FRAME_BYTES)
				throw new Error(_('The router renderer returned an invalid frame.'));
			return self._installCpuFrame(session, blob);
		}).then(function () {
			if (!self._isCurrentCpuSession(session))
				return;
			session.errors = 0;
			session.warned = false;
			const interval = document.hidden
				? CPU_HIDDEN_INTERVAL_MS
				: session.frameIntervalMs;
			self._scheduleCpuFramePoll(
				session,
				Math.max(0, interval - (Date.now() - started))
			);
		}).catch(function (err) {
			return self._handleCpuPollFailure(session, err);
		});
	},

	_scheduleCpuAudioPoll: function (session, delay) {
		const self = this;
		const audio = session && session.audio;

		if (!self._isCurrentCpuSession(session) || !audio || !audio.active ||
		    audio.ended)
			return;
		if (audio.timer != null)
			window.clearTimeout(audio.timer);
		audio.timer = window.setTimeout(function () {
			audio.timer = null;
			self._pollCpuAudio(session);
		}, Math.max(0, Number(delay) || 0));
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
		if (!session || !audio || !audio.active || session.audio !== audio)
			return;
		audio.pollGeneration =
			(Number(audio.pollGeneration) || 0) + 1;
		audio.sequence = null;
		audio.rebased = true;
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
		source.buffer = buffer;
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
		source.start(startAt);
		audio.nextPlayTime = startAt + CPU_AUDIO_CHUNK_MS / 1000;
		audio.sequence = sequence + 1;
		audio.hasDecoded = true;
		audio.errors = 0;
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

		if (!self._isCurrentCpuSession(session) || !audio || !audio.active ||
		    audio.ended ||
		    audio.inFlight)
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
			if (res.status === 202) {
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
				self._endCpuAudioGracefully(session);
				return { done: true };
			}
			if (res.status === 410 && audio.sequence != null && !audio.rebased) {
				audio.rebased = true;
				audio.sequence = null;
				self._resetCpuAudioQueue(audio);
				return { retry: true, delay: 0 };
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

	_playCpuFrames: function (res, label, generation, pendingAudio) {
		const self = this;
		const token = String(res.session_token || '');
		const frameUrl = String(res.stream_url || '');
		const hasAudio = flagOn(res.has_audio);
		const audioUrl = String(res.audio_url || '');
		const audioMetadataValid = hasAudio &&
			/^\/cgi-bin\/videoplayer-audio\?token=[0-9a-f]{32}$/.test(audioUrl) &&
			audioUrl.slice(-32) === token &&
			res.audio_type === 'pcm-s16le-chunks' &&
			Number(res.audio_sample_rate) === CPU_AUDIO_SAMPLE_RATE &&
			Number(res.audio_channels) === CPU_AUDIO_CHANNELS &&
			Number(res.audio_frames_per_chunk) === CPU_AUDIO_FRAMES_PER_CHUNK;

		if (!/^[0-9a-f]{32}$/.test(token) ||
		    !/^\/cgi-bin\/videoplayer-frame\?token=[0-9a-f]{32}$/.test(frameUrl) ||
		    frameUrl.slice(-32) !== token) {
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

		const session = {
			token: token,
			frameUrl: frameUrl,
			generation: generation,
			label: label,
			fps: normalizeRouterFps(res.router_fps),
			frameIntervalMs: normalizeFrameInterval(res.frame_interval_ms),
			videoDelayMs: pendingAudio ? CPU_VIDEO_AUDIO_DELAY_MS : 0,
			active: true,
			timer: null,
			sequence: 0,
			errors: 0,
			warned: false,
			startedAt: Date.now(),
			firstFrameSeen: false,
			firstFrameAt: null,
			objectUrl: null,
			nextObjectUrl: null,
			pendingFrames: [],
			decoder: null,
			cancelDecode: null,
			decodeTimer: null,
			audio: pendingAudio,
			audioWarned: false,
			audioFailureReason: '',
			browserAudio: null,
			browserAudioWarned: false,
			browserAudioPrompted: false,
			finishing: null,
			finishTimer: null
		};
		self._cpuSession = session;
		self._currentKind = 'local';
		self._currentRenderMode = 'router';
		self._currentLabel = label;
		self._currentSrc = frameUrl;
		self._setPlayerSurface('cpu');
		self._setNowPlaying(_('Starting router CPU renderer: %s').format(label));
		self._scheduleCpuFramePoll(session, 0);
		if (session.audio) {
			self._scheduleCpuAudioPoll(session, 0);
			return Promise.resolve();
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

			/* stream_url is an opaque, ACL-protected token URL; never rebuild it client-side. */
			if (normalizeRenderMode(res.render_mode) === 'router' ||
			    res.stream_type === 'jpeg-frames') {
				const audio = pendingAudio;
				if (self._pendingCpuAudio === audio)
					self._pendingCpuAudio = null;
				pendingAudio = null;
				return self._playCpuFrames(res, label, generation, audio);
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
