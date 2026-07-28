'use strict';
'require view';
'require ui';
'require uci';
'require rpc';
'require request';

const callStatus  = rpc.declare({ object: 'luci.videoplayer', method: 'get_status' });
const callList    = rpc.declare({ object: 'luci.videoplayer', method: 'list',    params: [ 'path', 'offset', 'limit' ] });
const callResolve = rpc.declare({ object: 'luci.videoplayer', method: 'resolve', params: [ 'path' ] });
const callStartRenderer = rpc.declare({ object: 'luci.videoplayer', method: 'start_renderer', params: [ 'path' ] });
const callRendererStatus = rpc.declare({ object: 'luci.videoplayer', method: 'renderer_status', params: [ 'token' ] });
const callStopRenderer   = rpc.declare({
	object: 'luci.videoplayer',
	method: 'stop_renderer',
	params: [ 'token' ],
	nobatch: true
});
const PAGE_SIZE = 100;
const CPU_FRAME_INTERVAL_MS = 333;
const CPU_HIDDEN_INTERVAL_MS = 2000;
const CPU_FRAME_REQUEST_TIMEOUT_MS = 2500;
const CPU_START_TIMEOUT_MS = 15000;
const CPU_MAX_FRAME_BYTES = 4194304;

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

function errorText(err) {
	if (err && err.message)
		return err.message;
	if (err != null)
		return String(err);
	return _('Unknown error');
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

		if (typeof self._stopRendererBestEffort === 'function')
			self._stopRendererBestEffort(previousCpuSession);
		if (typeof self._clearVideoElement === 'function')
			self._clearVideoElement();
		if (self._pageHideHandler)
			window.removeEventListener('pagehide', self._pageHideHandler);

		const enabled = uci.get('videoplayer', 'main', 'enabled');
		const mediaPath = uci.get('videoplayer', 'main', 'media_path') || status.media_path || '/mnt/video';
		const allowRemote = uci.get('videoplayer', 'main', 'allow_remote');
		const configuredRenderMode = uci.get('videoplayer', 'main', 'render_mode');
		const localEnabled = enabled !== undefined
			? flagOn(enabled)
			: (status.enabled !== undefined ? flagOn(status.enabled) : true);
		const remoteAllowed = allowRemote !== undefined
			? flagOn(allowRemote)
			: (status.allow_remote !== undefined ? flagOn(status.allow_remote) : true);
		const renderMode = normalizeRenderMode(
			configuredRenderMode !== undefined ? configuredRenderMode : status.render_mode
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
		self._rendererAvailable = rendererAvailable;
		self._canWriteSettings = canWriteSettings;
		self._statusLoadError = statusResult.error || null;
		self._status = {
			media_path: status.media_path || mediaPath,
			enabled: status.enabled !== undefined ? status.enabled : localEnabled,
			allow_remote: status.allow_remote !== undefined ? status.allow_remote : remoteAllowed,
			render_mode: normalizeRenderMode(status.render_mode || renderMode),
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
								}, _('Router CPU rendering (experimental)'))
							]),
							E('div', {
								id: 'vp-render-mode-desc',
								class: 'cbi-value-description'
							}, _('Local files only. Router mode uses FFmpeg to produce a silent low-frame-rate preview in this web page; it has no audio, pause, seeking, or timeline and may heavily load the router. Remote URLs always use browser decoding.')),
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
					}, _('Router CPU mode is a silent low-frame-rate preview without pause, seeking, or a timeline.'))
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
					_('Prefer H.264 + AAC in MP4 for browser mode. Router CPU mode depends on the codecs enabled in the installed OpenWrt FFmpeg build and may not decode every file. Store media on USB if possible.')
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
		let path = (pathEl && pathEl.value || '').trim();
		const renderMode = normalizeRenderMode(renderModeEl && renderModeEl.value);

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
		const localEnabled = !!(enabledEl && enabledEl.checked);
		const remoteAllowed = !!(remoteEl && remoteEl.checked);
		let statusRefreshError = null;

		self._setSaveBusy(true);

		uci.set('videoplayer', 'main', 'enabled', localEnabled ? '1' : '0');
		uci.set('videoplayer', 'main', 'media_path', path);
		uci.set('videoplayer', 'main', 'allow_remote', remoteAllowed ? '1' : '0');
		uci.set('videoplayer', 'main', 'render_mode', renderMode);

		return uci.save().then(function () {
			return uci.apply();
		}).then(function () {
			self._localEnabled = localEnabled;
			self._allowRemote = remoteAllowed;
			self._renderMode = renderMode;
			self._statusLoadError = null;
			self._status = {
				media_path: path,
				enabled: localEnabled,
				allow_remote: remoteAllowed,
				render_mode: renderMode,
				renderer_available: self._rendererAvailable,
				renderer_reason: self._status && self._status.renderer_reason,
				media_path_valid: undefined,
				media_path_exists: undefined,
				media_path_readable: undefined
			};

			/* Stop stale work as soon as the new UCI values have been applied. */
			self._browseRequestId++;
			self._browseLoading = true;
			if ((!localEnabled || pathChanged || modeChanged) && self._currentKind === 'local')
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
					renderer_available: st.renderer_available,
					renderer_reason: st.renderer_reason,
					media_path_valid: st.media_path_valid,
					media_path_exists: st.media_path_exists,
					media_path_readable: st.media_path_readable
				};
				self._localEnabled = st.enabled !== undefined ? flagOn(st.enabled) : localEnabled;
				self._allowRemote = st.allow_remote !== undefined ? flagOn(st.allow_remote) : remoteAllowed;
				self._renderMode = normalizeRenderMode(st.render_mode || renderMode);
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

			if (pathChanged) {
				self._cwd = '';
				self._offset = 0;
			}

			self._browseLoading = false;
			if ((!self._canBrowseLocal() || pathChanged || modeChanged) && self._currentKind === 'local')
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
			notify(null, _('Router CPU mode has no audio.'), 3000, 'warning');
			return Promise.resolve();
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
			statusEl.textContent = _('FFmpeg renderer is available. Expect high CPU usage and a silent low-frame-rate preview.');
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

		return callList(path, offset, PAGE_SIZE).then(function (res) {
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
					_('No supported video files were found in this directory.'));
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
			mute.disabled = showCpu;
			mute.title = showCpu ? _('Router CPU mode has no audio.') : '';
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

		if (clearFrame && frame)
			frame.removeAttribute('src');
		this._revokeObjectUrl(session.objectUrl);
		session.objectUrl = null;
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
		const session = this._detachCpuSession(true);
		this._stopRendererBestEffort(session);
		this._clearVideoElement();
		this._currentSrc = null;
		this._currentKind = null;
		this._currentRenderMode = null;
		this._currentLabel = '';
		this._setPlayerSurface('none');
	},

	_preparePlaybackSurface: function () {
		const session = this._detachCpuSession(true);

		this._stopRendererBestEffort(session);
		this._clearVideoElement();
		this._currentSrc = null;
		this._currentRenderMode = null;
		this._setPlayerSurface('none');
	},

	_playInVideo: function (url, label, generation, kind) {
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

		if (!self._isCurrentCpuSession(session))
			return;
		if (session.timer != null)
			window.clearTimeout(session.timer);
		session.timer = window.setTimeout(function () {
			session.timer = null;
			self._pollCpuFrame(session);
		}, Math.max(0, Number(delay) || 0));
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
				const frame = document.getElementById('videoplayer-cpu-frame');
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

				if (!ok || !current || !frame) {
					if (session.nextObjectUrl === objectUrl)
						session.nextObjectUrl = null;
					self._revokeObjectUrl(objectUrl);
					if (ok || !current)
						resolve();
					else
						reject(err || new Error(_('The router returned an invalid video frame.')));
					return;
				}

				const previous = session.objectUrl;
				frame.src = objectUrl;
				session.objectUrl = objectUrl;
				session.nextObjectUrl = null;
				self._revokeObjectUrl(previous);
				if (!session.firstFrameSeen) {
					session.firstFrameSeen = true;
					self._setNowPlaying(
						_('Router CPU preview: %s (silent, low frame rate)').format(session.label)
					);
				}
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

	_finishCpuPlayback: function (session, message, isError) {
		if (!this._isCurrentCpuSession(session))
			return Promise.resolve();

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
				return self._finishCpuPlayback(
					session,
					_('Router CPU renderer failed for %s. The installed FFmpeg build may not support this video codec.').format(session.label),
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
				: CPU_FRAME_INTERVAL_MS;
			self._scheduleCpuFramePoll(
				session,
				Math.max(0, interval - (Date.now() - started))
			);
		}).catch(function (err) {
			return self._handleCpuPollFailure(session, err);
		});
	},

	_playCpuFrames: function (res, label, generation) {
		const self = this;
		const token = String(res.session_token || '');
		const frameUrl = String(res.stream_url || '');

		if (!/^[0-9a-f]{32}$/.test(token) || !/^\/cgi-bin\/videoplayer-frame\?token=[0-9a-f]{32}$/.test(frameUrl)) {
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
			callStopRenderer(token).catch(function () {});
			return Promise.resolve();
		}

		const session = {
			token: token,
			frameUrl: frameUrl,
			generation: generation,
			label: label,
			active: true,
			timer: null,
			sequence: 0,
			errors: 0,
			warned: false,
			startedAt: Date.now(),
			firstFrameSeen: false,
			objectUrl: null,
			nextObjectUrl: null,
			decoder: null,
			cancelDecode: null,
			decodeTimer: null
		};
		self._cpuSession = session;
		self._currentKind = 'local';
		self._currentRenderMode = 'router';
		self._currentLabel = label;
		self._currentSrc = frameUrl;
		self._setPlayerSurface('cpu');
		self._setNowPlaying(_('Starting router CPU renderer: %s').format(label));
		self._scheduleCpuFramePoll(session, 0);
		return Promise.resolve();
	},

	_playLocal: function (relPath, name) {
		const self = this;
		relPath = String(relPath || '').replace(/^\/+/, '');
		const useRouter = self._renderMode === 'router' && self._canWriteSettings;

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
			notify(null, E('p', {},
				_('Router CPU rendering is unavailable: %s').format(
					(self._status && self._status.renderer_reason) ||
					_('FFmpeg capability check failed'))),
			7000, 'error');
			return Promise.resolve();
		}
		if (self._renderMode === 'router' && !useRouter) {
			notify(null,
				_('Router CPU rendering requires write permission. Using browser decoding for this account.'),
				5000, 'warning');
		}

		const label = name || relPath;
		const generation = ++self._playGeneration;
		self._preparePlaybackSurface();
		self._currentKind = 'local';
		self._currentRenderMode = useRouter ? 'router' : 'browser';
		self._currentLabel = label;
		self._setNowPlaying(_('Preparing local video: %s').format(label));
		self._localResolvePending = true;

		const prepareLocal = useRouter
			? callStartRenderer
			: callResolve;

		return prepareLocal(relPath).then(function (res) {
			res = res || {};
			if (generation !== self._playGeneration || !self._canBrowseLocal()) {
				if (/^[0-9a-f]{32}$/.test(String(res.session_token || '')))
					callStopRenderer(res.session_token).catch(function () {});
				return;
			}

			if (res.error) {
				self._currentKind = null;
				self._currentRenderMode = null;
				self._currentSrc = null;
				self._setPlayerSurface('none');
				self._setNowPlaying(_('Unable to prepare local video: %s').format(label));
				notify(null, E('p', {},
					_('Unable to resolve local video: %s').format(res.error)),
				7000, 'error');
				return;
			}

			if (!res.stream_url) {
				self._currentKind = null;
				self._currentRenderMode = null;
				self._currentSrc = null;
				self._setPlayerSurface('none');
				self._setNowPlaying(_('Unable to prepare local video: %s').format(label));
				notify(null, E('p', {}, _('The streamer did not return a playback URL.')), 7000, 'error');
				return;
			}

			/* stream_url is an opaque, ACL-protected token URL; never rebuild it client-side. */
			if (normalizeRenderMode(res.render_mode) === 'router' ||
			    res.stream_type === 'jpeg-frames')
				return self._playCpuFrames(res, label, generation);
			return self._playInVideo(res.stream_url, label, generation, 'local');
		}).catch(function (err) {
			if (generation !== self._playGeneration)
				return;

			self._currentKind = null;
			self._currentRenderMode = null;
			self._currentSrc = null;
			self._setPlayerSurface('none');
			self._setNowPlaying(_('Unable to prepare local video: %s').format(label));
			notify(null, E('p', {},
				_('Unable to resolve local video: %s').format(errorText(err))),
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
		video = video || document.getElementById('videoplayer-video');
		button = button || document.getElementById('vp-mute-btn');
		if (!video || !button)
			return;

		button.textContent = video.muted ? _('Unmute') : _('Mute');
		button.setAttribute('aria-pressed', video.muted ? 'true' : 'false');
		button.disabled = this._currentRenderMode === 'router';
	},

	_handleVolumeChange: function (ev) {
		this._syncMuteControl(ev && ev.currentTarget);
	}
});
