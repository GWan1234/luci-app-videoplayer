#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later
'use strict';

const fs = require('fs');
const path = require('path');

function fail(message) {
	throw new Error(`web-audio-test: ${message}`);
}

function check(condition, message) {
	if (!condition)
		fail(message);
}

if (typeof String.prototype.format !== 'function') {
	Object.defineProperty(String.prototype, 'format', {
		configurable: true,
		value: function (...values) {
			let index = 0;
			return String(this).replace(/%[sd]/g, () => String(values[index++]));
		}
	});
}

const source = fs.readFileSync(
	path.join(
		__dirname,
		'..',
		'luci-app-videoplayer',
		'htdocs',
		'luci-static',
		'resources',
		'view',
		'videoplayer',
		'main.js'
	),
	'utf8'
);

const request = {
	get: null
};
const rpcHandlers = Object.create(null);
const rpcCalls = [];
const rpc = {
	declare: spec => (...args) => {
		rpcCalls.push({ method: spec.method, args });
		return Promise.resolve().then(() => {
			const handler = rpcHandlers[spec.method];
			return handler ? handler(...args) : {};
		});
	}
};
const view = {
	extend: value => value
};
const ui = {
	createHandlerFn: () => () => {},
	addNotification: () => null
};
const uci = {
	load: () => Promise.resolve(),
	get: () => undefined,
	set: () => {},
	save: () => Promise.resolve(),
	apply: () => Promise.resolve()
};

const elements = Object.create(null);
const domNodes = [];

function fakeImageElement() {
	const attributes = Object.create(null);
	const node = {
		id: '',
		className: '',
		src: '',
		naturalWidth: 0,
		hidden: true,
		onload: null,
		onerror: null,
		parentNode: null,
		setAttribute(name, value) {
			attributes[name] = String(value);
			if (name === 'id')
				this.id = String(value);
			else if (name === 'class')
				this.className = String(value);
		},
		getAttribute(name) {
			if (name === 'id')
				return this.id || null;
			if (name === 'class')
				return this.className || null;
			return attributes[name];
		},
		removeAttribute(name) {
			delete attributes[name];
			if (name === 'src') {
				this.src = '';
				this.naturalWidth = 0;
			}
			else if (name === 'id') {
				this.id = '';
			}
		}
	};
	Object.defineProperty(node, 'nextSibling', {
		get() {
			if (!this.parentNode)
				return null;
			const index = this.parentNode.children.indexOf(this);
			return index >= 0
				? this.parentNode.children[index + 1] || null
				: null;
		}
	});
	domNodes.push(node);
	return node;
}

function fakeImageParent(initialNode) {
	const parent = {
		children: [],
		insertBefore(node, reference) {
			if (node.parentNode)
				node.parentNode.removeChild(node);
			const index = reference ? this.children.indexOf(reference) : -1;
			if (index >= 0)
				this.children.splice(index, 0, node);
			else
				this.children.push(node);
			node.parentNode = this;
			return node;
		},
		removeChild(node) {
			const index = this.children.indexOf(node);
			if (index < 0)
				throw new Error('node is not a child');
			this.children.splice(index, 1);
			node.parentNode = null;
			return node;
		}
	};
	if (initialNode)
		parent.insertBefore(initialNode, null);
	return parent;
}

global.document = {
	hidden: false,
	getElementById: id =>
		domNodes.find(node => node.parentNode && node.id === id) ||
		elements[id] || null,
	createElement: tag => {
		check(tag === 'img', `unexpected element creation: ${tag}`);
		return fakeImageElement();
	},
	documentElement: {
		contains: () => true
	}
};
global.window = {
	setTimeout,
	clearTimeout,
	URL: {
		createObjectURL: () => 'blob:test',
		revokeObjectURL: () => {}
	}
};

const app = new Function(
	'view',
	'ui',
	'uci',
	'rpc',
	'request',
	'E',
	'_',
	'L',
	source
)(
	view,
	ui,
	uci,
	rpc,
	request,
	() => ({}),
	value => value,
	{}
);

function fakeContext(options = {}) {
	const resumeOutcomes = Array.from(options.resumeOutcomes || []);
	const context = {
		currentTime: 1,
		sampleRate: 48000,
		state: options.state || 'running',
		destination: {},
		createdSources: [],
		closed: false,
		resumed: false,
		resumeCalls: 0,
		createGain() {
			return {
				gain: {
					value: 1,
					setValueAtTime(value) {
						this.value = value;
					}
				},
				connect() {},
				disconnect() {}
			};
		},
		createBuffer(channels, frames, rate) {
			check(channels === 1 || channels === 2, 'unexpected channel count');
			check(frames === 1 || frames === 12000, 'unexpected frame count');
			check(rate === 48000, 'unexpected sample rate');
			const data = Array.from(
				{ length: channels },
				() => new Float32Array(frames)
			);
			return {
				getChannelData: channel => data[channel],
				data
			};
		},
		createBufferSource() {
			const sourceNode = {
				buffer: null,
				startAt: null,
				stopped: false,
				disconnected: false,
				onended: null,
				connect() {},
				start(at) {
					this.startAt = at;
				},
				stop() {
					this.stopped = true;
				},
				disconnect() {
					this.disconnected = true;
				}
			};
			this.createdSources.push(sourceNode);
			return sourceNode;
		},
		resume() {
			this.resumed = true;
			this.resumeCalls++;
			const outcome = resumeOutcomes.shift();
			if (outcome instanceof Error)
				return Promise.reject(outcome);
			this.state = 'running';
			return Promise.resolve(outcome);
		},
		close() {
			this.closed = true;
			this.state = 'closed';
			return Promise.resolve();
		}
	};
	return context;
}

function fakeButton() {
	const attributes = Object.create(null);
	return {
		textContent: '',
		disabled: false,
		title: '',
		setAttribute(name, value) {
			attributes[name] = String(value);
		},
		getAttribute(name) {
			return attributes[name];
		}
	};
}

function fakeMediaElement(playOutcomes) {
	const outcomes = Array.from(playOutcomes || []);
	return {
		src: '',
		muted: false,
		paused: true,
		duration: 600,
		currentTime: 0,
		playCalls: 0,
		playMuted: [],
		pauseCalls: 0,
		loadCalls: 0,
		onloadedmetadata: null,
		onplaying: null,
		onpause: null,
		onended: null,
		onerror: null,
		play() {
			this.playCalls++;
			this.playMuted.push(this.muted);
			const outcome = outcomes.shift();
			if (outcome instanceof Error) {
				this.paused = true;
				return Promise.reject(outcome);
			}
			this.paused = false;
			return Promise.resolve(outcome);
		},
		pause() {
			this.pauseCalls++;
			this.paused = true;
		},
		load() {
			this.loadCalls++;
		},
		removeAttribute(name) {
			if (name === 'src')
				this.src = '';
		}
	};
}

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function installFakeClock(start = 100000) {
	const originalNow = Date.now;
	const originalSetTimeout = window.setTimeout;
	const originalClearTimeout = window.clearTimeout;
	const timers = new Map();
	let now = start;
	let nextId = 1;

	Date.now = () => now;
	window.setTimeout = (callback, delay) => {
		const id = nextId++;
		timers.set(id, {
			callback,
			due: now + Math.max(0, Number(delay) || 0)
		});
		return id;
	};
	window.clearTimeout = id => {
		timers.delete(id);
	};

	return {
		now: () => now,
		jump(milliseconds) {
			now += Math.max(0, Number(milliseconds) || 0);
		},
		advance(milliseconds) {
			const target = now + Math.max(0, Number(milliseconds) || 0);
			let guard = 0;
			for (;;) {
				let selectedId = null;
				let selected = null;
				for (const [ id, timer ] of timers) {
					if (timer.due <= target &&
					    (!selected || timer.due < selected.due ||
					     (timer.due === selected.due && id < selectedId))) {
						selectedId = id;
						selected = timer;
					}
				}
				if (!selected)
					break;
				if (++guard > 10000)
					fail('fake clock timer loop did not settle');
				now = selected.due;
				timers.delete(selectedId);
				selected.callback();
			}
			now = target;
		},
		restore() {
			Date.now = originalNow;
			window.setTimeout = originalSetTimeout;
			window.clearTimeout = originalClearTimeout;
			timers.clear();
		}
	};
}

async function main() {
	const unlockContext = fakeContext();
	global.window.AudioContext = function () {
		return unlockContext;
	};
	const unlocked = app._createCpuAudio();
	check(unlocked && unlocked.context === unlockContext, 'AudioContext was not created');
	check(unlockContext.resumed, 'AudioContext was not resumed from the play action');
	check(
		unlockContext.createdSources.length === 1 &&
		unlockContext.createdSources[0].startAt === 0,
		'AudioContext unlock buffer was not started'
	);
	app._disposeCpuAudio(unlocked);
	check(unlockContext.closed, 'AudioContext was not closed');

	/* A rejected asynchronous resume must leave an enabled Unmute control.
	 * Clicking it is a fresh user gesture and retries AudioContext.resume(). */
	const retryContext = fakeContext({
		state: 'suspended',
		resumeOutcomes: [ new Error('NotAllowedError'), null ]
	});
	global.window.AudioContext = function () {
		return retryContext;
	};
	const retryAudio = app._createCpuAudio();
	await Promise.resolve();
	check(retryAudio.resumeFailed, 'rejected AudioContext resume was not recorded');
	check(retryContext.resumeCalls === 1, 'initial AudioContext resume count is wrong');
	const retrySession = {
		active: true,
		generation: 3,
		audio: retryAudio,
		browserAudio: null
	};
	const stalePcmSource = {
		onended() {},
		stopped: false,
		disconnected: false,
		stop() { this.stopped = true; },
		disconnect() { this.disconnected = true; }
	};
	retryAudio.sources = [ stalePcmSource ];
	retryAudio.sequence = 42;
	retryAudio.nextPlayTime = 9;
	const retryButton = fakeButton();
	elements['vp-mute-btn'] = retryButton;
	app._cpuSession = retrySession;
	app._playGeneration = 3;
	app._currentKind = 'local';
	app._currentRenderMode = 'router';
	app._syncCpuMuteControl();
	check(retryButton.textContent === 'Unmute', 'suspended PCM did not offer Unmute');
	check(!retryButton.disabled, 'suspended PCM left the mute control disabled');
	check(
		retryButton.getAttribute('aria-pressed') === 'true',
		'suspended PCM mute state is not exposed'
	);
	await app.handleMute();
	check(retryContext.resumeCalls === 2, 'Unmute did not retry AudioContext.resume()');
	check(retryContext.state === 'running', 'retry did not start AudioContext');
	check(!retryAudio.resumeFailed, 'successful resume kept the failure flag');
	check(!retryAudio.muted, 'successful resume kept PCM muted');
	check(stalePcmSource.stopped && stalePcmSource.disconnected,
		'suspended PCM queue was not discarded on resume');
	check(retryAudio.sequence === null && retryAudio.nextPlayTime === 0,
		'resumed PCM did not rebase to the live ring position');
	check(retryAudio.pollGeneration === 1,
		'resumed PCM did not invalidate the stale request generation');
	check(retryAudio.gain.gain.value === 1, 'successful resume did not restore gain');
	check(retryButton.textContent === 'Mute', 'successful resume did not update button');
	check(
		retryButton.getAttribute('aria-pressed') === 'false',
		'successful resume kept the pressed state'
	);

	/* Browsers and operating systems may resume an interrupted AudioContext
	 * without another button click. That transition must discard PCM queued
	 * before the interruption and continue from the live ring position. */
	const autoResumeSource = {
		onended() {},
		stopped: false,
		disconnected: false,
		stop() { this.stopped = true; },
		disconnect() { this.disconnected = true; }
	};
	retryAudio.sources = [ autoResumeSource ];
	retryAudio.sequence = 77;
	retryAudio.nextPlayTime = 14;
	retryContext.state = 'interrupted';
	retryContext.onstatechange();
	check(retryAudio.resumeFailed && retryAudio.resumeRebasePending,
		'automatic interruption did not arm a live PCM rebase');
	retryContext.state = 'running';
	retryContext.onstatechange();
	check(autoResumeSource.stopped && autoResumeSource.disconnected,
		'automatic resume retained stale queued PCM');
	check(retryAudio.sequence === null && retryAudio.nextPlayTime === 0,
		'automatic resume did not switch to the live ring position');
	check(retryAudio.pollGeneration === 2,
		'automatic resume did not invalidate the stale request generation');
	check(!retryAudio.resumeFailed && !retryAudio.resumeRebasePending,
		'automatic resume retained a suspended state');

	app._disposeCpuAudio(retryAudio);
	app._cpuSession = null;
	delete elements['vp-mute-btn'];

	const context = fakeContext();
	const audio = {
		active: true,
		context,
		gain: context.createGain(),
		nextPlayTime: 0,
		sequence: null,
		errors: 0,
		sources: []
	};
	const session = { audio };
	const pcm = new ArrayBuffer(48000);
	const data = new DataView(pcm);
	data.setInt16(0, -32768, true);
	data.setInt16(2, 32767, true);
	data.setInt16(4, 0, true);
	data.setInt16(6, 16384, true);
	app._decodeCpuAudioChunk(session, pcm, 7);

	const sourceNode = context.createdSources[0];
	check(audio.sequence === 8, 'audio sequence did not advance');
	check(audio.sources.length === 1, 'audio source was not tracked');
	check(Math.abs(sourceNode.startAt - 1.12) < 0.0001, 'audio lead is incorrect');
	check(
		Math.abs(sourceNode.buffer.data[0][0] + 1) < 0.0001,
		'left PCM sample was decoded incorrectly'
	);
	check(
		Math.abs(sourceNode.buffer.data[1][0] - 32767 / 32768) < 0.0001,
		'right PCM sample was decoded incorrectly'
	);
	check(
		Math.abs(sourceNode.buffer.data[1][1] - 0.5) < 0.0001,
		'little-endian PCM conversion is incorrect'
	);
	app._resetCpuAudioQueue(audio);
	check(sourceNode.stopped && sourceNode.disconnected, 'queued audio was not stopped');
	check(audio.sources.length === 0, 'audio source list was not cleared');

	const pollContext = fakeContext();
	const pollAudio = {
		active: true,
		context: pollContext,
		gain: pollContext.createGain(),
		url: '/cgi-bin/videoplayer-audio?token=' + 'a'.repeat(32),
		muted: false,
		timer: null,
		inFlight: false,
		sequence: null,
		startedAt: Date.now(),
		hasDecoded: false,
		ended: false,
		nextPlayTime: 0,
		errors: 0,
		warned: false,
		rebased: false,
		sources: []
	};
	const pollSession = {
		active: true,
		generation: 4,
		audio: pollAudio
	};
	app._cpuSession = pollSession;
	app._playGeneration = 4;
	app._currentKind = 'local';
	app._currentRenderMode = 'router';
	let scheduled = null;
	app._scheduleCpuAudioPoll = (activeSession, delay) => {
		check(activeSession === pollSession, 'wrong session was rescheduled');
		scheduled = delay;
	};
	const headerValues = {
		'content-type': 'application/octet-stream',
		'content-length': '48000',
		'x-videoplayer-audio-format': 's16le',
		'x-videoplayer-audio-sequence': '9',
		'x-videoplayer-audio-sample-rate': '48000',
		'x-videoplayer-audio-channels': '2',
		'x-videoplayer-audio-frames': '12000'
	};
	request.get = () => Promise.resolve({
		status: 200,
		ok: true,
		headers: {
			get: name => headerValues[String(name).toLowerCase()] || null
		},
		blob: () => new Blob([new Uint8Array(48000)])
	});
	await app._pollCpuAudio(pollSession);
	check(pollAudio.sequence === 10, 'live audio response did not set next sequence');
	check(pollAudio.inFlight === false, 'audio request remained in flight');
	check(scheduled !== null, 'next sequential audio request was not scheduled');

	/* A resume/rebase may race an already-issued sequential request. Its late
	 * response must not reattach stale PCM after switching back to live. */
	const stalePcmResponse = deferred();
	request.get = () => stalePcmResponse.promise;
	scheduled = null;
	const stalePcmPoll = app._pollCpuAudio(pollSession);
	check(pollAudio.inFlight && pollAudio.inFlightGeneration === 0,
		'stale PCM request was not tracked by generation');
	app._rebaseCpuAudio(pollSession, pollAudio);
	check(pollAudio.pollGeneration === 1 && pollAudio.sequence === null,
		'PCM rebase did not switch to the live sequence');
	check(scheduled === 0, 'PCM rebase did not schedule an immediate live poll');
	stalePcmResponse.resolve({
		status: 200,
		ok: true,
		headers: {
			get: name => headerValues[String(name).toLowerCase()] || null
		},
		blob: () => new Blob([new Uint8Array(48000)])
	});
	await stalePcmPoll;
	check(pollAudio.sequence === null && pollAudio.sources.length === 0,
		'late sequential PCM response survived a live rebase');
	check(!pollAudio.inFlight && pollAudio.inFlightGeneration === null,
		'late stale PCM request corrupted in-flight state');

	/* Catching up with the realtime producer is normal even long after
	 * startup. A steady-state 202 must not disable an established stream. */
	pollAudio.startedAt = Date.now() - 60000;
	scheduled = null;
	request.get = () => Promise.resolve({
		status: 202,
		ok: false,
		headers: { get: () => null }
	});
	await app._pollCpuAudio(pollSession);
	check(pollSession.audio === pollAudio, 'steady-state 202 disabled audio');
	check(pollAudio.active && !pollAudio.ended, 'steady-state 202 ended audio');
	check(scheduled === 125, 'steady-state 202 did not schedule a retry');
	app._decodeCpuAudioChunk(pollSession, pcm, 11);

	/* A clean EOF stops fetching but lets Web Audio play every source that was
	 * already queued. Disposal happens only after the final onended callback. */
	scheduled = null;
	const queuedAtEof = pollAudio.sources[0];
	request.get = () => Promise.resolve({
		status: 204,
		ok: true,
		headers: { get: () => null }
	});
	await app._pollCpuAudio(pollSession);
	check(pollAudio.ended, 'clean EOF did not enter draining state');
	check(pollSession.audio === pollAudio, 'clean EOF disposed audio too early');
	check(!queuedAtEof.stopped, 'clean EOF truncated a queued source');
	check(!pollContext.closed, 'clean EOF closed AudioContext before drain');
	check(scheduled === null, 'clean EOF scheduled another request');
	queuedAtEof.onended();
	check(pollSession.audio === null, 'drained audio remained attached');
	check(pollContext.closed, 'drained AudioContext was not closed');
	check(!queuedAtEof.stopped, 'natural drain called stop on the final source');

	/* Video EOF uses the same drain path: keep the current CPU session and its
	 * last frame alive until queued audio finishes, then detach normally. */
	const finishContext = fakeContext();
	const finishAudio = {
		active: true,
		context: finishContext,
		gain: finishContext.createGain(),
		muted: false,
		timer: null,
		inFlight: false,
		sequence: null,
		startedAt: Date.now(),
		hasDecoded: false,
		ended: false,
		nextPlayTime: 0,
		errors: 0,
		warned: false,
		rebased: false,
		sources: []
	};
	const finishSession = {
		active: true,
		generation: 5,
		token: 'b'.repeat(32),
		label: 'finite.mp4',
		fps: 8,
		timer: null,
		decodeTimer: null,
		cancelDecode: null,
		decoder: null,
		nextObjectUrl: null,
		objectUrl: null,
		pendingFrames: [],
		audio: finishAudio,
		firstFrameSeen: true,
		finishing: null,
		finishTimer: null
	};
	app._cpuSession = finishSession;
	app._playGeneration = 5;
	app._currentKind = 'local';
	app._currentRenderMode = 'router';
	app._decodeCpuAudioChunk(finishSession, pcm, 3);
	const finalVideoSource = finishAudio.sources[0];
	await app._finishCpuPlayback(finishSession, 'finished', false);
	check(app._cpuSession === finishSession, 'video EOF detached before audio drain');
	check(finishSession.finishing !== null, 'video EOF did not enter draining state');
	check(!finalVideoSource.stopped, 'video EOF truncated queued audio');
	app._endCpuAudioGracefully(finishSession);
	check(app._cpuSession === finishSession, 'audio EOF detached before queued tail');
	finalVideoSource.onended();
	check(
		app._cpuSession === null,
		`video session remained after audio drain (sources=${finishAudio.sources.length}, ` +
			`ended=${finishAudio.ended}, finishing=${finishSession.finishing !== null})`
	);
	check(finishContext.closed, 'video EOF did not close drained AudioContext');
	check(!finalVideoSource.stopped, 'video EOF stopped a naturally ended source');

	/* Short video EOF can race resolve_audio, a pending play() promise, or the
	 * first streamed image. Keep each audio phase alive for the bounded drain
	 * window instead of destroying its hidden audio immediately. */
	const pendingEofCases = [
		{ name: 'resolving', generation: 51, token: '5', audio: true },
		{ name: 'playPending', generation: 52, token: '6', audio: true },
		{ name: 'waitingForVideo', generation: 53, token: '7', audio: true }
	];
	for (const pendingCase of pendingEofCases) {
		const pendingPhase = pendingCase.name;
		const pendingEofAudio = pendingCase.audio ? {
			active: true,
			resolving: pendingPhase === 'resolving',
			waitingForVideo: pendingPhase === 'waitingForVideo',
			playing: false,
			playPending: pendingPhase === 'playPending',
			playAttempt: 1,
			playPromise: null,
			ended: false,
			muted: false,
			needsGesture: false,
			element: null,
			promise: Promise.resolve(true)
		} : null;
		const pendingEofSession = {
			active: true,
			generation: pendingCase.generation,
			token: pendingCase.token.repeat(32),
			label: `short-${pendingPhase}.mp4`,
			fps: 8,
			audio: null,
			browserAudio: pendingEofAudio,
			firstFrameSeen: pendingPhase !== 'waitingForVideo',
			finishing: null,
			finishTimer: null
		};

		app._cpuSession = pendingEofSession;
		app._playGeneration = pendingEofSession.generation;
		app._currentKind = 'local';
		app._currentRenderMode = 'router';
		await app._finishCpuPlayback(
			pendingEofSession, `finished-${pendingPhase}`, false
		);
		check(
			app._cpuSession === pendingEofSession,
			`video EOF detached during browser-audio ${pendingPhase}`
		);
		check(
			pendingEofSession.finishing !== null,
			`video EOF did not drain pending ${pendingPhase}`
		);
		await app._finishCpuPlayback(
			pendingEofSession, `finished-${pendingPhase}`, false, true
		);
		check(
			app._cpuSession === null,
			`forced ${pendingPhase} drain retained the session`
		);
	}

	/* When router PCM is unavailable, keep the continuous CPU-rendered MJPEG
	 * stream but resolve the original protected stream into a hidden browser
	 * audio element. A delayed audible play may be blocked, so muted playback
	 * starts the clock and the visible Unmute button supplies the next gesture. */
	const browserElement = fakeMediaElement([
		new Error('NotAllowedError'),
		null,
		null
	]);
	const browserButton = fakeButton();
	const browserNote = { textContent: '', hidden: false };
	const browserNowPlaying = { textContent: '' };
	const browserFrame = fakeImageElement();
	browserFrame.id = 'videoplayer-cpu-frame';
	browserFrame.className = 'videoplayer-cpu-frame';
	const browserFrameParent = fakeImageParent(browserFrame);
	elements['videoplayer-cpu-audio'] = browserElement;
	elements['videoplayer-cpu-frame'] = browserFrame;
	elements['vp-mute-btn'] = browserButton;
	elements['vp-cpu-player-note'] = browserNote;
	elements['videoplayer-nowplaying'] = browserNowPlaying;
	const browserStreamToken = 'c'.repeat(32);
	rpcHandlers.resolve_audio = rendererToken => {
		check(rendererToken === 'b'.repeat(32),
			'browser fallback resolved the wrong renderer session');
		return {
			render_mode: 'browser',
			stream_type: 'html5-video',
			stream_url:
				'/cgi-bin/videoplayer-stream?renderer=' + rendererToken +
				'&audio=' + browserStreamToken,
			media_offset_ms: 1750
		};
	};
	rpcHandlers.renderer_status = () => ({ state: 'running' });
	rpcCalls.length = 0;
	let unexpectedFrameRequests = 0;
	request.get = () => {
		unexpectedFrameRequests++;
		return Promise.reject(new Error('unexpected per-frame HTTP request'));
	};
	app._playGeneration = 6;
	await app._playCpuStream({
		session_token: 'b'.repeat(32),
		stream_url: '/cgi-bin/videoplayer-frame?token=' + 'b'.repeat(32),
		render_mode: 'router',
		stream_type: 'mjpeg-stream',
		mime: 'multipart/x-mixed-replace',
		stream_segment_seconds: 45,
		has_audio: 0,
		router_fps: 60
	}, 'bad apple.mp4', 6, null);

	const browserSession = app._cpuSession;
	const browserAudio = browserSession && browserSession.browserAudio;
	check(browserSession && browserSession.active, 'CPU session was not retained');
	check(browserSession.fps === 60, '60 FPS was normalized to another frame rate');
	const firstStreamFrame = browserSession.streamPending &&
		browserSession.streamPending.node;
	check(firstStreamFrame && firstStreamFrame !== browserFrame,
		'CPU stream reused a frame with stale decode state');
	check(
		firstStreamFrame.src ===
			'/cgi-bin/videoplayer-frame?token=' + 'b'.repeat(32) +
			'&stream=6-1',
		'CPU video was not attached as one continuous multipart stream'
	);
	check(unexpectedFrameRequests === 0,
		'continuous CPU video still issued per-frame HTTP requests');
	check(browserAudio && browserAudio.active, 'browser audio fallback was not attached');
	check(browserAudio.waitingForVideo,
		'browser audio started before the first streamed image');
	check(
		rpcCalls.filter(call => call.method === 'resolve_audio').length === 1,
		'browser audio fallback did not resolve exactly once'
	);
	check(
		browserElement.src ===
			'/cgi-bin/videoplayer-stream?renderer=' + 'b'.repeat(32) +
			'&audio=' + browserStreamToken,
		'browser audio fallback did not use the protected stream URL'
	);
	firstStreamFrame.naturalWidth = 640;
	firstStreamFrame.onload();
	await browserAudio.playPromise;
	check(
		document.getElementById('videoplayer-cpu-frame') === firstStreamFrame &&
		browserFrame.parentNode === null &&
		browserFrameParent.children.length === 1,
		'first streamed image did not replace the blank staging surface'
	);
	check(browserSession.firstFrameSeen && browserSession.firstFrameAt,
		'first streamed image did not establish the audio clock');
	check(
		browserElement.currentTime >= 1.5 &&
		browserElement.currentTime <= 2.5,
		'browser audio ignored the router playback offset'
	);
	check(browserElement.playCalls === 2, 'autoplay fallback did not retry muted');
	check(
		browserElement.playMuted[0] === false &&
		browserElement.playMuted[1] === true,
		'autoplay fallback used the wrong mute order'
	);
	check(browserAudio.playing, 'muted browser audio did not start');
	check(browserAudio.muted && browserAudio.needsGesture,
		'autoplay rejection did not preserve an Unmute action');
	check(browserButton.textContent === 'Unmute',
		'browser fallback did not expose Unmute');
	check(!browserButton.disabled, 'browser fallback left Unmute disabled');
	check(
		browserButton.getAttribute('aria-pressed') === 'true',
		'browser fallback mute state is not exposed'
	);
	check(
		browserNote.textContent.includes('press Unmute'),
		'browser fallback did not explain how to enable sound'
	);

	await app.handleMute();
	check(browserElement.playCalls === 3, 'Unmute did not retry browser audio');
	check(browserElement.playMuted[2] === false,
		'Unmute retried browser audio while still muted');
	check(!browserAudio.needsGesture && !browserAudio.muted,
		'successful Unmute kept browser audio muted');
	check(!browserElement.muted, 'successful Unmute kept the media element muted');
	check(browserButton.textContent === 'Mute',
		'successful browser Unmute did not update button');
	check(
		browserButton.getAttribute('aria-pressed') === 'false',
		'successful browser Unmute kept the pressed state'
	);
	browserElement.onpause();
	check(!browserAudio.playing && browserAudio.needsGesture,
		'unexpected browser-audio pause did not expose resume');
	check(browserButton.textContent === 'Unmute',
		'unexpected browser-audio pause left the button on Mute');
	await app.handleMute();
	check(browserAudio.playing && !browserAudio.needsGesture,
		'Unmute did not resume unexpectedly paused browser audio');

	const pauseCallsBeforeStop = browserElement.pauseCalls;
	await app.handleStop();
	check(app._cpuSession === null, 'Stop retained the CPU session');
	check(!browserSession.active, 'Stop left the old CPU session active');
	const stoppedFrame = document.getElementById('videoplayer-cpu-frame');
	check(stoppedFrame && stoppedFrame.src === '',
		'Stop retained the MJPEG stream URL');
	check(stoppedFrame.onload === null && stoppedFrame.onerror === null,
		'Stop retained MJPEG stream callbacks');
	check(!browserAudio.active, 'Stop left browser audio active');
	check(browserElement.pauseCalls > pauseCallsBeforeStop,
		'Stop did not pause browser audio');
	check(browserElement.src === '', 'Stop did not clear browser audio URL');
	check(
		browserElement.onloadedmetadata === null &&
		browserElement.onplaying === null &&
		browserElement.onpause === null &&
		browserElement.onended === null &&
		browserElement.onerror === null,
		'Stop retained browser audio callbacks'
	);
	check(app._cpuBrowserAudioOwner === null,
		'Stop retained browser audio ownership');
	check(browserButton.disabled, 'Stop left the mute button enabled');
	check(
		rpcCalls.some(call =>
			call.method === 'stop_renderer' &&
			call.args[0] === 'b'.repeat(32)
		),
		'Stop did not stop the router renderer'
	);

	/* Browser audio is the synchronized primary output even when router PCM is
	 * available. Autoplay fallback to muted playback is not a decode failure;
	 * only a real media error promotes the dormant PCM context. */
	const primaryElement = fakeMediaElement([
		new Error('NotAllowedError'),
		null
	]);
	elements['videoplayer-cpu-audio'] = primaryElement;
	const primaryToken = '1'.repeat(32);
	const primaryAudioToken = '9'.repeat(32);
	const dormantPcm = {
		active: true,
		context: {
			state: 'running',
			currentTime: 1,
			closed: false,
			close() { this.closed = true; }
		},
		gain: null,
		muted: false,
		resumeFailed: false,
		resumeAttempt: 0,
		resumeRebasePending: false,
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
	rpcHandlers.resolve_audio = rendererToken => {
		check(rendererToken === primaryToken,
			'primary browser audio resolved the wrong renderer');
		return {
			render_mode: 'browser',
			stream_type: 'html5-video',
			stream_url:
				'/cgi-bin/videoplayer-stream?renderer=' + primaryToken +
				'&audio=' + primaryAudioToken,
			media_offset_ms: 500
		};
	};
	const originalAudioScheduler = app._scheduleCpuAudioPoll;
	let primaryPcmPolls = 0;
	app._scheduleCpuAudioPoll = () => {
		primaryPcmPolls++;
	};
	app._playGeneration = 60;
	await app._playCpuStream({
		session_token: primaryToken,
		stream_url:
			'/cgi-bin/videoplayer-frame?token=' + primaryToken,
		render_mode: 'router',
		stream_type: 'mjpeg-stream',
		mime: 'multipart/x-mixed-replace',
		stream_segment_seconds: 45,
		has_audio: 1,
		audio_url:
			'/cgi-bin/videoplayer-audio?token=' + primaryToken,
		audio_type: 'pcm-s16le-chunks',
		audio_sample_rate: 48000,
		audio_channels: 2,
		audio_frames_per_chunk: 12000,
		router_fps: 60
	}, 'primary-audio.mp4', 60, dormantPcm);
	const primarySession = app._cpuSession;
	const primaryBrowserAudio = primarySession.browserAudio;
	check(
		primarySession.audio === null &&
		primarySession.pendingAudio === dormantPcm &&
		primaryPcmPolls === 0,
		'router PCM started before synchronized browser audio failed'
	);
	primarySession.streamPending.node.naturalWidth = 640;
	primarySession.streamPending.node.onload();
	await primaryBrowserAudio.playPromise;
	check(
		primaryBrowserAudio.playing &&
		primaryBrowserAudio.muted &&
		primaryBrowserAudio.needsGesture &&
		primarySession.audio === null &&
		primaryPcmPolls === 0,
		'autoplay mute fallback incorrectly activated router PCM'
	);
	primaryElement.onerror();
	check(
		primarySession.browserAudio === null &&
		primarySession.browserAudioFailed &&
		primarySession.audio === dormantPcm &&
		primarySession.pendingAudio === null &&
		primaryPcmPolls === 1,
		'real browser-audio failure did not promote router PCM exactly once'
	);
	check(primaryElement.src === '' && !primaryBrowserAudio.active,
		'PCM failover left browser audio active');
	app._stopPlayback();
	check(dormantPcm.context.closed,
		'stopping PCM fallback did not close its AudioContext');
	app._scheduleCpuAudioPoll = originalAudioScheduler;

	/* A broken multipart connection is retried as a stream, not converted
	 * back into per-frame fetches. Stop must invalidate even a captured stale
	 * error callback so it cannot resurrect the request. */
	const reconnectSession = {
		active: true,
		generation: 62,
		token: '2'.repeat(32),
		label: 'reconnect.mp4',
		fps: 60,
		streamUrl:
			'/cgi-bin/videoplayer-frame?token=' + '2'.repeat(32),
		streamSegmentMs: 45000,
		visibleFrame: document.getElementById('videoplayer-cpu-frame'),
		streamAttempt: 0,
		streamPending: null,
		streamVisibleAttempt: null,
		streamOutageStartedAt: null,
		streamNextHandoffAt: null,
		streamProbeTimer: null,
		streamRefreshTimer: null,
		streamReconnectTimer: null,
		streamStatusTimer: null,
		streamStatusInFlight: false,
		streamStatusAgain: false,
		streamStatusErrors: 0,
		streamErrors: 0,
		firstFrameSeen: true,
		audio: null,
		browserAudio: null,
		finishing: null,
		finishTimer: null
	};
	app._cpuSession = reconnectSession;
	app._playGeneration = 62;
	app._currentKind = 'local';
	app._currentRenderMode = 'router';
	app._openCpuStream(reconnectSession);
	const reconnectFrame = reconnectSession.streamPending.node;
	const staleStreamError = reconnectFrame.onerror;
	staleStreamError();
	check(reconnectSession.streamErrors === 1,
		'MJPEG interruption was not counted');
	check(reconnectSession.streamReconnectTimer !== null,
		'MJPEG interruption did not schedule a bounded reconnect');
	check(unexpectedFrameRequests === 0,
		'MJPEG reconnect attempted a per-frame HTTP request');
	app._stopPlayback();
	staleStreamError();
	check(
		app._cpuSession === null &&
		document.getElementById('videoplayer-cpu-frame').src === '',
		'a stale MJPEG error callback resurrected stopped playback');

	/* Every attempt must use a fresh image so naturalWidth from the previous
	 * segment cannot produce a false success. Keep the last good node visible
	 * while a bounded segment hands off, including a lock-conflict retry. */
	const transportClock = installFakeClock();
	const originalStatusScheduler = app._scheduleCpuStreamStatus;
	app._scheduleCpuStreamStatus = () => {};
	const handoffBase = document.getElementById('videoplayer-cpu-frame');
	handoffBase.naturalWidth = 640;
	const handoffSession = {
		active: true,
		generation: 65,
		token: '7'.repeat(32),
		label: 'handoff.mp4',
		fps: 60,
		streamUrl:
			'/cgi-bin/videoplayer-frame?token=' + '7'.repeat(32),
		streamSegmentMs: 1000,
		visibleFrame: handoffBase,
		streamAttempt: 0,
		streamPending: null,
		streamVisibleAttempt: null,
		streamLastFrameAt: null,
		streamOutageStartedAt: null,
		streamNextHandoffAt: null,
		streamHiddenAt: null,
		streamProbeTimer: null,
		streamRefreshTimer: null,
		streamReconnectTimer: null,
		streamStatusTimer: null,
		streamStatusInFlight: false,
		streamStatusAgain: false,
		streamStatusErrors: 0,
		streamErrors: 0,
		streamWarned: false,
		firstFrameSeen: false,
		audio: null,
		pendingAudio: null,
		browserAudio: null,
		finishing: null,
		finishTimer: null
	};
	app._cpuSession = handoffSession;
	app._playGeneration = 65;
	app._currentKind = 'local';
	app._currentRenderMode = 'router';
	app._openCpuStream(handoffSession);
	const handoffFirst = handoffSession.streamPending;
	check(handoffFirst && handoffFirst.node.naturalWidth === 0,
		'new MJPEG attempt inherited the old image dimensions');
	transportClock.advance(100);
	check(handoffSession.streamPending === handoffFirst &&
		!handoffSession.firstFrameSeen,
		'stale dimensions made a fresh MJPEG attempt ready');
	handoffFirst.node.naturalWidth = 640;
	transportClock.advance(100);
	check(
		handoffSession.streamVisibleAttempt === handoffFirst &&
		handoffBase.parentNode === null &&
		browserFrameParent.children.length === 1,
		'fresh MJPEG image was not promoted atomically'
	);
	const handoffVisible = handoffSession.visibleFrame;
	transportClock.advance(1049);
	check(!handoffSession.streamPending,
		'MJPEG successor started before the bounded segment handoff');
	transportClock.advance(1);
	const conflictedAttempt = handoffSession.streamPending;
	check(
		conflictedAttempt &&
		conflictedAttempt.node.src.endsWith('&stream=65-2') &&
		handoffSession.visibleFrame === handoffVisible &&
		handoffVisible.parentNode === browserFrameParent,
		'planned MJPEG handoff did not preserve the last good image'
	);
	conflictedAttempt.node.onerror();
	check(
		!handoffSession.streamPending &&
		handoffVisible.parentNode === browserFrameParent &&
		handoffVisible.src.endsWith('&stream=65-1'),
		'stream-lock conflict removed the last good image'
	);
	transportClock.advance(249);
	check(!handoffSession.streamPending,
		'stream-lock retry ignored its bounded delay');
	transportClock.advance(1);
	const retryAttempt = handoffSession.streamPending;
	check(retryAttempt &&
		retryAttempt.node.src.endsWith('&stream=65-3'),
		'stream-lock retry did not use a fresh nonce');
	retryAttempt.node.naturalWidth = 640;
	retryAttempt.node.onload();
	check(
		handoffSession.visibleFrame === retryAttempt.node &&
		handoffVisible.parentNode === null &&
		browserFrameParent.children.length === 1,
		'successful retry did not replace the old segment cleanly'
	);

	/* Brief tab switches do not disturb a healthy connection. If background
	 * timer throttling carries the segment past its deadline, visibility
	 * recovery starts exactly one fresh handoff. */
	document.hidden = true;
	app._handleCpuVisibilityChange();
	transportClock.jump(100);
	document.hidden = false;
	app._handleCpuVisibilityChange();
	transportClock.advance(0);
	check(!handoffSession.streamPending &&
		handoffSession.streamAttempt === 3,
		'brief visibility change restarted a healthy MJPEG stream');
	document.hidden = true;
	app._handleCpuVisibilityChange();
	transportClock.jump(2000);
	document.hidden = false;
	app._handleCpuVisibilityChange();
	transportClock.advance(0);
	check(
		handoffSession.streamPending &&
		handoffSession.streamAttempt === 4,
		'overdue hidden MJPEG segment was not recovered'
	);
	app._stopPlayback();

	/* A prior successful frame must not make later outages infinite. Audio can
	 * keep the backend lease alive, so transport failure has its own deadline. */
	const outageBase = document.getElementById('videoplayer-cpu-frame');
	const outageSession = {
		active: true,
		generation: 66,
		token: '8'.repeat(32),
		label: 'outage.mp4',
		fps: 60,
		streamUrl:
			'/cgi-bin/videoplayer-frame?token=' + '8'.repeat(32),
		streamSegmentMs: 45000,
		visibleFrame: outageBase,
		streamAttempt: 0,
		streamPending: null,
		streamVisibleAttempt: null,
		streamLastFrameAt: null,
		streamOutageStartedAt: null,
		streamNextHandoffAt: null,
		streamHiddenAt: null,
		streamProbeTimer: null,
		streamRefreshTimer: null,
		streamReconnectTimer: null,
		streamStatusTimer: null,
		streamStatusInFlight: false,
		streamStatusAgain: false,
		streamStatusErrors: 0,
		streamErrors: 0,
		streamWarned: false,
		firstFrameSeen: false,
		audio: {
			active: true,
			timer: null,
			inFlight: false,
			inFlightGeneration: null,
			sources: [],
			gain: null,
			context: null
		},
		pendingAudio: null,
		browserAudio: null,
		finishing: null,
		finishTimer: null
	};
	app._cpuSession = outageSession;
	app._playGeneration = 66;
	app._currentKind = 'local';
	app._currentRenderMode = 'router';
	app._openCpuStream(outageSession);
	outageSession.streamPending.node.naturalWidth = 640;
	outageSession.streamPending.node.onload();
	outageSession.streamVisibleAttempt.node.onerror();
	for (let i = 0; i < 6 && app._cpuSession === outageSession; i++) {
		transportClock.advance(3000);
		if (outageSession.streamPending)
			outageSession.streamPending.node.onerror();
	}
	check(app._cpuSession === null && !outageSession.active,
		'post-success MJPEG outage retried forever while audio was active');
	app._scheduleCpuStreamStatus = originalStatusScheduler;
	transportClock.restore();

	/* Renderer status is the authoritative EOF signal because image elements
	 * do not expose multipart HTTP status or a reliable end event. */
	const endedSession = {
		active: true,
		generation: 63,
		token: '3'.repeat(32),
		label: 'ended.mp4',
		fps: 8,
		streamAttempt: 0,
		streamProbeTimer: null,
		streamRefreshTimer: null,
		streamReconnectTimer: null,
		streamStatusTimer: null,
		streamStatusInFlight: false,
		streamStatusAgain: false,
		streamStatusErrors: 0,
		firstFrameSeen: true,
		audio: null,
		browserAudio: null,
		finishing: null,
		finishTimer: null
	};
	app._cpuSession = endedSession;
	app._playGeneration = 63;
	app._currentKind = 'local';
	app._currentRenderMode = 'router';
	rpcHandlers.renderer_status = () => ({ state: 'ended' });
	await app._pollCpuStreamStatus(endedSession);
	check(app._cpuSession === null,
		'ended renderer status retained the MJPEG session');

	/* The backend URL is intentionally opaque. Extra query fields, a wrong
	 * stream type, or a wrong MIME must fail closed instead of becoming an
	 * arbitrary image request. */
	const invalidStreamToken = '4'.repeat(32);
	rpcCalls.length = 0;
	app._playGeneration = 64;
	await app._playCpuStream({
		session_token: invalidStreamToken,
		stream_url:
			'/cgi-bin/videoplayer-frame?token=' + invalidStreamToken +
			'&extra=1',
		render_mode: 'router',
		stream_type: 'mjpeg-stream',
		mime: 'multipart/x-mixed-replace',
		stream_segment_seconds: 45,
		has_audio: 0,
		router_fps: 60
	}, 'invalid-stream.mp4', 64, null);
	check(app._cpuSession === null,
		'frontend accepted a noncanonical MJPEG URL');
	check(
		rpcCalls.some(call =>
			call.method === 'stop_renderer' &&
			call.args[0] === invalidStreamToken
		),
		'invalid MJPEG session was not stopped'
	);

	/* A frame token is intentionally insufficient for opening the original
	 * source. Reject a backend response that reuses it as the audio nonce. */
	const invalidCapabilitySession = {
		active: true,
		generation: 61,
		token: '6'.repeat(32),
		label: 'invalid-capability.mp4',
		fps: 8,
		videoDelayMs: 0,
		firstFrameSeen: false,
		firstFrameAt: null,
		audio: null,
		audioFailureReason: '',
		browserAudio: null,
		browserAudioWarned: false,
		browserAudioPrompted: false,
		finishing: null,
		finishTimer: null
	};
	app._cpuSession = invalidCapabilitySession;
	app._playGeneration = 61;
	app._currentKind = 'local';
	app._currentRenderMode = 'router';
	rpcHandlers.resolve_audio = rendererToken => ({
		render_mode: 'browser',
		stream_type: 'html5-video',
		stream_url:
			'/cgi-bin/videoplayer-stream?renderer=' + rendererToken +
			'&audio=' + rendererToken,
		media_offset_ms: 0
	});
	check(
		!await app._startCpuBrowserAudioFallback(
			invalidCapabilitySession, 'PCM failed'
		),
		'frontend accepted the frame token as a browser-audio nonce'
	);
	check(invalidCapabilitySession.browserAudio === null,
		'invalid browser-audio capability remained attached');
	app._stopPlayback();

	/* Resolving the protected audio URL must not wait for a potentially
	 * long-lived HTMLMediaElement.play() promise. Otherwise the UI's local-file
	 * preparation lock would prevent selecting another video. */
	const hangingPlay = deferred();
	const hangingElement = fakeMediaElement([ hangingPlay.promise ]);
	elements['videoplayer-cpu-audio'] = hangingElement;
	const hangingSession = {
		active: true,
		generation: 7,
		token: 'd'.repeat(32),
		label: 'late-fallback.bin',
		fps: 8,
		firstFrameSeen: true,
		firstFrameAt: Date.now() - 1000,
		audio: null,
		audioFailureReason: '',
		browserAudio: null,
		browserAudioWarned: false,
		browserAudioPrompted: false,
		finishing: null,
		finishTimer: null
	};
	app._cpuSession = hangingSession;
	app._playGeneration = 7;
	app._currentKind = 'local';
	app._currentRenderMode = 'router';
	rpcHandlers.resolve_audio = () => ({
		render_mode: 'browser',
		stream_type: 'html5-video',
		stream_url:
			'/cgi-bin/videoplayer-stream?renderer=' + 'd'.repeat(32) +
			'&audio=' + 'e'.repeat(32),
		media_offset_ms: 900
	});
	const setupResult = await Promise.race([
		app._startCpuBrowserAudioFallback(
			hangingSession, 'PCM failed'
		).then(() => true),
		new Promise(resolve => setTimeout(() => resolve(false), 100))
	]);
	check(setupResult, 'browser-audio setup waited for media playback');
	check(
		hangingSession.browserAudio &&
		hangingSession.browserAudio.playPromise,
		'browser-audio setup did not retain its independent play attempt'
	);
	app._stopPlayback();

	/* A late rejection from an older autoplay attempt must not re-mute audio
	 * after a newer user-gesture attempt has already succeeded. */
	const staleAttempt = deferred();
	const raceElement = fakeMediaElement([ staleAttempt.promise, null ]);
	const raceAudio = {
		active: true,
		resolving: false,
		waitingForVideo: false,
		playing: false,
		playPending: false,
		playAttempt: 0,
		playPromise: null,
		ended: false,
		muted: false,
		needsGesture: false,
		element: raceElement,
		promise: Promise.resolve(true)
	};
	const raceSession = {
		active: true,
		generation: 8,
		token: 'f'.repeat(32),
		label: 'race.mp4',
		fps: 12,
		firstFrameSeen: true,
		firstFrameAt: Date.now(),
		audio: null,
		audioFailureReason: '',
		browserAudio: raceAudio,
		browserAudioWarned: false,
		browserAudioPrompted: false,
		finishing: null,
		finishTimer: null,
		timer: null,
		decodeTimer: null,
		cancelDecode: null,
		decoder: null,
		nextObjectUrl: null,
		objectUrl: null,
		pendingFrames: []
	};
	elements['videoplayer-cpu-audio'] = raceElement;
	app._cpuBrowserAudioOwner = raceAudio;
	app._cpuSession = raceSession;
	app._playGeneration = 8;
	app._currentKind = 'local';
	app._currentRenderMode = 'router';
	const oldAutoplay = app._playCpuBrowserAudio(raceSession, raceAudio, false);
	const userGesture = app._playCpuBrowserAudio(raceSession, raceAudio, true);
	check(await userGesture, 'newer user-gesture audio attempt did not start');
	staleAttempt.reject(new Error('stale NotAllowedError'));
	await oldAutoplay;
	check(!raceAudio.muted && !raceAudio.needsGesture,
		'stale autoplay rejection re-muted browser audio');
	check(!raceElement.muted, 'stale autoplay rejection re-muted media element');
	app._stopPlayback();

	/* Muting while a play() promise is unresolved must invalidate that attempt,
	 * so its later success cannot undo the user's mute action. */
	const pendingPlay = deferred();
	const pendingElement = fakeMediaElement([ pendingPlay.promise ]);
	const pendingBrowserAudio = {
		active: true,
		resolving: false,
		waitingForVideo: false,
		playing: false,
		playPending: false,
		playAttempt: 0,
		playPromise: null,
		ended: false,
		muted: false,
		needsGesture: false,
		mediaOffsetMs: 1000,
		offsetReceivedAt: Date.now(),
		element: pendingElement,
		promise: Promise.resolve(true)
	};
	const pendingSession = {
		active: true,
		generation: 9,
		token: '1'.repeat(32),
		label: 'pending.mp4',
		fps: 8,
		videoDelayMs: 0,
		firstFrameSeen: true,
		firstFrameAt: Date.now(),
		audio: null,
		browserAudio: pendingBrowserAudio,
		timer: null,
		decodeTimer: null,
		cancelDecode: null,
		decoder: null,
		nextObjectUrl: null,
		objectUrl: null,
		pendingFrames: []
	};
	elements['videoplayer-cpu-audio'] = pendingElement;
	app._cpuBrowserAudioOwner = pendingBrowserAudio;
	app._cpuSession = pendingSession;
	app._playGeneration = 9;
	app._currentKind = 'local';
	app._currentRenderMode = 'router';
	const pendingResult = app._playCpuBrowserAudio(
		pendingSession, pendingBrowserAudio, true
	);
	check(pendingBrowserAudio.playPending,
		'pending browser play was not tracked');
	await app.handleMute();
	check(pendingBrowserAudio.muted && pendingElement.muted,
		'Mute did not apply during a pending play attempt');
	pendingPlay.resolve();
	check(!await pendingResult,
		'invalidated pending play was reported as current');
	check(pendingBrowserAudio.muted && pendingElement.muted,
		'late play success undid the user mute action');
	app._stopPlayback();

	process.stdout.write('web-audio-test: ok\n');
}

main().catch(error => {
	process.stderr.write(`${error.stack || error}\n`);
	process.exit(1);
});
