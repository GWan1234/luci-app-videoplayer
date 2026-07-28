'use strict';
'require view';
'require ui';
'require uci';
'require rpc';

const callStatus  = rpc.declare({ object: 'luci.videoplayer', method: 'get_status' });
const callList    = rpc.declare({ object: 'luci.videoplayer', method: 'list',    params: [ 'path', 'offset', 'limit' ] });
const callResolve = rpc.declare({ object: 'luci.videoplayer', method: 'resolve', params: [ 'path' ] });
const PAGE_SIZE = 100;

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

		const enabled = uci.get('videoplayer', 'main', 'enabled');
		const mediaPath = uci.get('videoplayer', 'main', 'media_path') || status.media_path || '/mnt/video';
		const allowRemote = uci.get('videoplayer', 'main', 'allow_remote');
		const localEnabled = enabled !== undefined
			? flagOn(enabled)
			: (status.enabled !== undefined ? flagOn(status.enabled) : true);
		const remoteAllowed = allowRemote !== undefined
			? flagOn(allowRemote)
			: (status.allow_remote !== undefined ? flagOn(status.allow_remote) : true);

		self._cwd = '';
		self._offset = 0;
		self._limit = PAGE_SIZE;
		self._hasMore = false;
		self._browseLoading = false;
		self._browseRequestId = 0;
		self._playGeneration = 0;
		self._currentSrc = null;
		self._currentLabel = '';
		self._currentKind = null;
		self._localEnabled = localEnabled;
		self._allowRemote = remoteAllowed;
		self._canWriteSettings = canWriteSettings;
		self._statusLoadError = statusResult.error || null;
		self._status = {
			media_path: status.media_path || mediaPath,
			enabled: status.enabled !== undefined ? status.enabled : localEnabled,
			allow_remote: status.allow_remote !== undefined ? status.allow_remote : remoteAllowed,
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
				#videoplayer-root video#videoplayer-video {
					width: 100%;
					max-height: 70vh;
					background: #000;
					border-radius: 4px;
					display: block;
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
				_('Play local videos from router storage or remote HTTP(S) URLs — fully inside the LuCI web UI (HTML5 player).')),

			/* Settings */
			E('h3', {}, _('Settings')),
			E('div', { class: 'cbi-section' }, [
				E('div', { class: 'cbi-section-node' }, [
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
						}, _('Your browser does not support HTML5 video.'))
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
					])
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
							}, _('Direct link to MP4/WebM. Loaded by the browser; server policy, codec support, or missing Range support may prevent playback.')),
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
					_('Prefer H.264 + AAC in MP4 for maximum browser compatibility. Store media on USB if possible. Seeking needs HTTP Range (supported by the included CGI streamer).')
				])
			])
		]);

		/* Defer initial listing until DOM is attached */
		window.setTimeout(function () {
			self._syncRemoteControls();
			if (self._canBrowseLocal())
				self._browse('', 0);
			else
				self._renderLocalUnavailable();
		}, 0);

		return root;
	},

	handleSaveSettings: function () {
		const self = this;
		const enabledEl = document.getElementById('vp-enabled');
		const pathEl = document.getElementById('vp-media-path');
		const remoteEl = document.getElementById('vp-allow-remote');
		let path = (pathEl && pathEl.value || '').trim();

		if (!self._canWriteSettings) {
			notify(null, _('Settings are read-only for the current LuCI account.'), 5000, 'warning');
			return Promise.resolve();
		}

		self._clearFieldError(pathEl, 'vp-media-path-error');

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
		const localEnabled = !!(enabledEl && enabledEl.checked);
		const remoteAllowed = !!(remoteEl && remoteEl.checked);
		let statusRefreshError = null;

		self._setSaveBusy(true);

		uci.set('videoplayer', 'main', 'enabled', localEnabled ? '1' : '0');
		uci.set('videoplayer', 'main', 'media_path', path);
		uci.set('videoplayer', 'main', 'allow_remote', remoteAllowed ? '1' : '0');

		return uci.save().then(function () {
			return uci.apply();
		}).then(function () {
			self._localEnabled = localEnabled;
			self._allowRemote = remoteAllowed;
			self._statusLoadError = null;
			self._status = {
				media_path: path,
				enabled: localEnabled,
				allow_remote: remoteAllowed,
				media_path_valid: undefined,
				media_path_exists: undefined,
				media_path_readable: undefined
			};

			/* Stop stale work as soon as the new UCI values have been applied. */
			self._browseRequestId++;
			self._browseLoading = true;
			if ((!localEnabled || pathChanged) && self._currentKind === 'local')
				self.handleStop();
			else if (!remoteAllowed && self._currentKind === 'remote')
				self.handleStop();

			return callStatus().then(function (st) {
				st = st || {};
				self._status = {
					media_path: st.media_path || path,
					enabled: st.enabled !== undefined ? st.enabled : localEnabled,
					allow_remote: st.allow_remote !== undefined ? st.allow_remote : remoteAllowed,
					media_path_valid: st.media_path_valid,
					media_path_exists: st.media_path_exists,
					media_path_readable: st.media_path_readable
				};
				self._localEnabled = st.enabled !== undefined ? flagOn(st.enabled) : localEnabled;
				self._allowRemote = st.allow_remote !== undefined ? flagOn(st.allow_remote) : remoteAllowed;
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

			if (pathChanged) {
				self._cwd = '';
				self._offset = 0;
			}

			self._browseLoading = false;
			if ((!self._canBrowseLocal() || pathChanged) && self._currentKind === 'local')
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
		this._playGeneration++;
		this._clearVideoElement();
		this._currentKind = null;
		this._currentLabel = '';
		this._setNowPlaying(_('Stopped.'));
		return Promise.resolve();
	},

	handleMute: function () {
		const v = document.getElementById('videoplayer-video');
		const button = document.getElementById('vp-mute-btn');

		if (v) {
			v.muted = !v.muted;
			this._syncMuteControl(v, button);
			notify(null, v.muted ? _('Muted') : _('Unmuted'), 2000);
		}
		return Promise.resolve();
	},

	handleFullscreen: function () {
		const v = document.getElementById('videoplayer-video');
		let request;

		if (!v)
			return Promise.resolve();

		try {
			if (document.fullscreenElement || document.webkitFullscreenElement) {
				if (document.exitFullscreen)
					request = document.exitFullscreen();
				else if (document.webkitExitFullscreen)
					request = document.webkitExitFullscreen();
			}
			else if (v.requestFullscreen) {
				request = v.requestFullscreen();
			}
			else if (v.webkitRequestFullscreen) {
				request = v.webkitRequestFullscreen();
			}
			else if (v.webkitEnterFullscreen) {
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
					_('No video files here. Supported: mp4, webm, ogg, ogv, m4v, mov.'));
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

		this._currentSrc = null;
		if (!video)
			return;

		video.pause();
		video.removeAttribute('src');
		video.load();
	},

	_playInVideo: function (url, label, generation, kind) {
		const self = this;
		const video = document.getElementById('videoplayer-video');

		if (!video || generation !== self._playGeneration)
			return Promise.resolve();

		self._clearVideoElement();
		self._currentKind = kind;
		self._currentLabel = label || url;
		video.src = url;
		self._currentSrc = video.src || url;
		self._setNowPlaying(_('Loading: %s').format(self._currentLabel));

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

	_playLocal: function (relPath, name) {
		const self = this;
		relPath = String(relPath || '').replace(/^\/+/, '');

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

		const label = name || relPath;
		const generation = ++self._playGeneration;
		self._clearVideoElement();
		self._currentKind = 'local';
		self._currentLabel = label;
		self._setNowPlaying(_('Preparing local video: %s').format(label));

		return callResolve(relPath).then(function (res) {
			if (generation !== self._playGeneration || !self._canBrowseLocal())
				return;

			res = res || {};
			if (res.error) {
				self._currentKind = null;
				self._setNowPlaying(_('Unable to prepare local video: %s').format(label));
				notify(null, E('p', {},
					_('Unable to resolve local video: %s').format(res.error)),
				7000, 'error');
				return;
			}

			if (!res.stream_url) {
				self._currentKind = null;
				self._setNowPlaying(_('Unable to prepare local video: %s').format(label));
				notify(null, E('p', {}, _('The streamer did not return a playback URL.')), 7000, 'error');
				return;
			}

			/* stream_url is an opaque, ACL-protected token URL; never rebuild it client-side. */
			return self._playInVideo(res.stream_url, label, generation, 'local');
		}).catch(function (err) {
			if (generation !== self._playGeneration)
				return;

			self._currentKind = null;
			self._setNowPlaying(_('Unable to prepare local video: %s').format(label));
			notify(null, E('p', {},
				_('Unable to resolve local video: %s').format(errorText(err))),
			7000, 'error');
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
		if (!video || !this._currentSrc)
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
		if (!this._currentSrc)
			return;
		this._setNowPlaying(_('Playback ended: %s').format(this._currentLabel || this._currentSrc));
	},

	_handleVideoWaiting: function () {
		if (!this._currentSrc)
			return;
		this._setNowPlaying(_('Buffering: %s').format(this._currentLabel || this._currentSrc));
	},

	_handleVideoPlaying: function () {
		if (!this._currentSrc)
			return;
		this._setNowPlaying(_('Now playing: %s').format(this._currentLabel || this._currentSrc));
	},

	_syncMuteControl: function (video, button) {
		video = video || document.getElementById('videoplayer-video');
		button = button || document.getElementById('vp-mute-btn');
		if (!video || !button)
			return;

		button.textContent = video.muted ? _('Unmute') : _('Mute');
		button.setAttribute('aria-pressed', video.muted ? 'true' : 'false');
	},

	_handleVolumeChange: function (ev) {
		this._syncMuteControl(ev && ev.currentTarget);
	}
});
