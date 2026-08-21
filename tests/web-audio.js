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

function attestedRendererStatus(state, extra) {
	return Object.assign({
		state,
		renderer_backend: 'private-software-cpu',
		attestation_marker: 'software-cpu-v1',
		hardware_acceleration: false,
		runtime_attested: true,
		presentation: 'browser-managed'
	}, extra || {});
}

function strictCpuSession(token, extra) {
	return Object.assign(attestedRendererStatus(undefined, {
		session_token: token,
		stream_url: '/cgi-bin/videoplayer-frame?token=' + token,
		render_mode: 'router',
		stream_type: 'mjpeg-stream',
		mime: 'multipart/x-mixed-replace',
		stream_segment_seconds: 45,
		router_profile: 'fast',
		router_fps: 8,
		has_audio: false,
		audio_state: 'absent'
	}), extra || {});
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
	addNotification: () => null,
	changes: {
		apply: () => {}
	}
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
const renderedElements = Object.create(null);

function fakeElement(tag, attrs, children) {
	const node = { tag, attrs: attrs || {}, children };

	if (node.attrs.id)
		renderedElements[node.attrs.id] = node;
	return node;
}

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

function fakeCanvasElement() {
	const context = {
		drawCalls: [],
		clearCalls: 0,
		drawImage(...args) {
			this.drawCalls.push(args);
		},
		clearRect() {
			this.clearCalls++;
		}
	};
	return {
		id: 'videoplayer-cpu-canvas',
		className: 'videoplayer-cpu-canvas',
		width: 640,
		height: 360,
		hidden: true,
		parentNode: null,
		getContext(type) {
			return type === '2d' ? context : null;
		},
		setAttribute() {},
		context
	};
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
	fakeElement,
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
		suspendCalls: 0,
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
			check(frames === 1 || frames === 48000, 'unexpected frame count');
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
				playbackRate: {
					value: 1,
					setValueAtTime(value) {
						this.value = value;
					}
				},
				startAt: null,
				stopped: false,
				disconnected: false,
				onended: null,
				connect() {},
				start(at, offset) {
					this.startAt = at;
					this.startOffset = Number(offset) || 0;
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
		suspend() {
			this.suspendCalls++;
			this.state = 'suspended';
			if (typeof this.onstatechange === 'function')
				this.onstatechange();
			return Promise.resolve();
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
		defaultPlaybackRate: 1,
		playbackRate: 1,
		preservesPitch: false,
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

async function flushMicrotasks(rounds = 8) {
	for (let i = 0; i < rounds; i++)
		await Promise.resolve();
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
		audio: retryAudio
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
	const pcm = new ArrayBuffer(192000);
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
		'content-length': '192000',
		'x-videoplayer-audio-format': 's16le',
		'x-videoplayer-audio-sequence': '9',
		'x-videoplayer-audio-sample-rate': '48000',
		'x-videoplayer-audio-channels': '2',
		'x-videoplayer-audio-frames': '48000'
	};
	request.get = () => Promise.resolve({
		status: 200,
		ok: true,
		headers: {
			get: name => headerValues[String(name).toLowerCase()] || null
		},
		blob: () => new Blob([new Uint8Array(192000)])
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
		blob: () => new Blob([new Uint8Array(192000)])
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


	/* Buffered router playback waits for a full two-minute A/V horizon, while a
	 * short file can start as soon as its complete duration has arrived. */
	const originalBufferedStart = app._startCpuBufferedPlayback;
	let bufferedStarts = 0;
	app._startCpuBufferedPlayback = () => { bufferedStarts++; };
	const gateSession = {
		active: true,
		generation: 120,
		bufferedPlayback: true,
		bufferState: 'buffering',
		fps: 10,
		durationSeconds: 1,
		durationSealed: false,
		renderedSeconds: 119.99,
		playedSeconds: 0,
		producerEnded: false,
		videoProducerDrained: false,
		audio: {
			active: true,
			bufferedUntil: 180,
			producerEnded: false
		}
	};
	app._cpuSession = gateSession;
	app._playGeneration = 120;
	app._currentKind = 'local';
	app._currentRenderMode = 'router';
	app._maybeStartCpuBufferedPlayback(gateSession);
	check(bufferedStarts === 0 &&
		!app._cpuBufferedPlaybackFinished(gateSession),
		'forged one-second metadata bypassed the strict 120-second gate');
	gateSession.renderedSeconds = 120;
	app._maybeStartCpuBufferedPlayback(gateSession);
	check(bufferedStarts === 1, 'the complete 120-second buffer did not start playback');
	gateSession.durationSeconds = 45;
	gateSession.renderedSeconds = 44.9;
	gateSession.audio.bufferedUntil = 45;
	app._maybeStartCpuBufferedPlayback(gateSession);
	check(bufferedStarts === 1,
		'a known short file started before its exact duration or clean EOF');
	gateSession.renderedSeconds = 45;
	app._maybeStartCpuBufferedPlayback(gateSession);
	check(bufferedStarts === 1,
		'a known short file started from advisory duration before clean EOF');
	gateSession.producerEnded = true;
	gateSession.videoProducerDrained = true;
	gateSession.audio.producerEnded = true;
	app._sealCpuBufferedDuration(gateSession);
	app._maybeStartCpuBufferedPlayback(gateSession);
	check(bufferedStarts === 2 && gateSession.durationSealed,
		'a clean known short file did not start from its sealed duration');
	gateSession.durationSeconds = 1;
	gateSession.durationSealed = false;
	gateSession.renderedSeconds = 30;
	gateSession.videoProducerDrained = false;
	gateSession.audio.producerEnded = false;
	app._maybeStartCpuBufferedPlayback(gateSession);
	check(bufferedStarts === 2,
		'short video started before its video/audio EOF was complete');
	gateSession.videoProducerDrained = true;
	gateSession.audio.producerEnded = true;
	app._sealCpuBufferedDuration(gateSession);
	app._maybeStartCpuBufferedPlayback(gateSession);
	check(bufferedStarts === 3,
		'clean short video did not start after complete EOF');
	check(gateSession.durationSeconds === 30 && gateSession.durationSealed,
		'clean EOF did not replace forged metadata with rendered media time');
	app._startCpuBufferedPlayback = originalBufferedStart;

	/* Both progress values are media times, are independently labelled, and use
	 * the backend duration when present. Unknown duration remains explicit. */
	elements['vp-cpu-rendered-time'] = { textContent: '' };
	elements['vp-cpu-played-time'] = { textContent: '' };
	elements['vp-cpu-render-speed'] = { textContent: '' };
	elements['vp-cpu-buffered-ahead'] = { textContent: '' };
	gateSession.renderedSeconds = 120.8;
	gateSession.playedSeconds = 31.9;
	gateSession.durationSeconds = 600;
	app._updateCpuBufferedCounters(gateSession, true);
	check(elements['vp-cpu-rendered-time'].textContent === '02:00 / 10:00',
		'rendered-time counter is not a labelled media duration');
	check(elements['vp-cpu-played-time'].textContent === '00:31 / 10:00',
		'played-time counter is not a labelled media duration');
	gateSession.durationSeconds = null;
	app._updateCpuBufferedCounters(gateSession, true);
	check(elements['vp-cpu-rendered-time'].textContent.endsWith(' / ?'),
		'unknown backend duration was not shown as unknown');

	/* Render throughput is accepted media time divided by monotonic wall time.
	 * A deliberate high-water hold is labelled and excluded from the next rate
	 * sample instead of being averaged into an apparent slow renderer. */
	const telemetryClock = installFakeClock(2800000);
	gateSession.producerEnded = false;
	gateSession.videoProducerDrained = false;
	gateSession.durationSealed = false;
	gateSession.fps = 10;
	gateSession.renderedSeconds = 1;
	gateSession.playedSeconds = 0;
	gateSession.audio.producerEnded = false;
	gateSession.audio.bufferedUntil = 1;
	gateSession.renderRateAnchorAt = null;
	gateSession.renderRateAnchorSeconds = null;
	gateSession.renderSpeed = null;
	gateSession.renderEffectiveFps = null;
	gateSession.renderCapacityHeld = false;
	gateSession.counterUpdatedAt = null;
	gateSession.renderedSeconds = 0;
	app._updateCpuBufferedCounters(gateSession, true);
	telemetryClock.jump(15000);
	gateSession.renderedSeconds = 1;
	app._updateCpuBufferedCounters(gateSession, true);
	check(elements['vp-cpu-render-speed'].textContent ===
		'Measuring… (target 10 FPS)',
		'render-speed counter included startup time before the first accepted JPEG');
	telemetryClock.jump(1000);
	gateSession.renderedSeconds = 3;
	gateSession.playedSeconds = 1;
	gateSession.audio.bufferedUntil = 3;
	app._updateCpuBufferedCounters(gateSession, true);
	check(elements['vp-cpu-render-speed'].textContent ===
		'2.00× real time (20.0 FPS / 10 FPS target)',
		'render-speed counter did not report media/wall throughput and target FPS');
	check(elements['vp-cpu-buffered-ahead'].textContent === '00:02',
		'buffered-ahead counter did not report synchronized media lead');
	app._setCpuRenderCapacityHeld(gateSession, true);
	check(elements['vp-cpu-render-speed'].textContent ===
		'Paused — buffer full (target 10 FPS)',
		'high-water pause was displayed as renderer throughput');
	telemetryClock.jump(90000);
	app._setCpuRenderCapacityHeld(gateSession, false);
	check(elements['vp-cpu-render-speed'].textContent ===
		'Measuring… (target 10 FPS)',
		'capacity resume retained the pre-pause rate sample');
	telemetryClock.jump(1000);
	gateSession.renderedSeconds = 5;
	gateSession.audio.bufferedUntil = 5;
	app._updateCpuBufferedCounters(gateSession, true);
	check(elements['vp-cpu-render-speed'].textContent ===
		'2.00× real time (20.0 FPS / 10 FPS target)',
		'deliberate 90-second capacity hold polluted resumed render speed');
	telemetryClock.restore();
	delete elements['vp-cpu-rendered-time'];
	delete elements['vp-cpu-played-time'];
	delete elements['vp-cpu-render-speed'];
	delete elements['vp-cpu-buffered-ahead'];

	/* PCM prefetch starts at sequence zero and drains multiple contiguous chunks
	 * per request into browser-owned memory. */
	const bufferedContext = fakeContext();
	const bufferedAudio = {
		active: true,
		context: bufferedContext,
		gain: bufferedContext.createGain(),
		url: '/cgi-bin/videoplayer-audio?token=' + 'f'.repeat(32),
		pollGeneration: 0,
		inFlight: false,
		inFlightGeneration: null,
		fetchSequence: 0,
		playSequence: null,
		batchMaxChunks: 2,
		bufferedChunks: Object.create(null),
		bufferedBytes: 0,
		bufferedUntil: 0,
		producerEnded: false,
		ended: false,
		errors: 0,
		sources: []
	};
	const bufferedCanvas = fakeCanvasElement();
	const bufferedSession = {
		active: true,
		generation: 121,
		bufferedPlayback: true,
		bufferState: 'buffering',
		producerEnded: false,
		fps: 10,
		durationSeconds: 600,
		renderedSeconds: 0,
		playedSeconds: 0,
		videoFrames: [],
		videoFrameIndex: 0,
		videoBufferBytes: 0,
		videoDecodeBytes: 0,
		videoDecodeInFlight: null,
		videoDecodeGeneration: 0,
		displayedSequence: -1,
		canvas: bufferedCanvas,
		canvasContext: bufferedCanvas.context,
		audio: bufferedAudio,
		presentationTimer: null,
		finishing: null
	};
	app._cpuSession = bufferedSession;
	app._playGeneration = 121;
	app._currentKind = 'local';
	app._currentRenderMode = 'router';
	let bufferedQuery = null;
	let bufferedPollDelay = null;
	const originalAudioScheduler = app._scheduleCpuAudioPoll;
	app._scheduleCpuAudioPoll = (activeSession, delay) => {
		check(activeSession === bufferedSession, 'wrong buffered audio session scheduled');
		bufferedPollDelay = delay;
	};
	request.get = (url, options) => {
		bufferedQuery = options.query;
		const values = {
			'content-type': 'application/octet-stream',
			'content-length': '384000',
			'x-videoplayer-audio-format': 's16le',
			'x-videoplayer-audio-sequence': '0',
			'x-videoplayer-audio-chunk-count': '2',
			'x-videoplayer-audio-frames-per-chunk': '48000',
			'x-videoplayer-audio-total-frames': '96000',
			'x-videoplayer-audio-sample-rate': '48000',
			'x-videoplayer-audio-channels': '2'
		};
		return Promise.resolve({
			status: 200,
			ok: true,
			headers: { get: name => values[String(name).toLowerCase()] || null },
			blob: () => new Blob([ new Uint8Array(384000) ])
		});
	};
	await app._pollCpuBufferedAudio(bufferedSession);
	check(bufferedQuery.chunk === '0' && bufferedQuery.count === '2',
		'buffered PCM did not start at zero with the advertised batch size');
	check(bufferedAudio.fetchSequence === 2 &&
		bufferedAudio.bufferedChunks[0] instanceof ArrayBuffer &&
		bufferedAudio.bufferedChunks[1] instanceof ArrayBuffer &&
		bufferedAudio.bufferedUntil === 2,
		'buffered PCM batch was not retained as two sequential chunks');
	check(bufferedPollDelay === 0, 'buffered PCM did not immediately drain the next batch');

	/* A slow producer exposes the edge of each complete two-chunk batch for
	 * roughly two media seconds. Back off repeated 202 responses instead of
	 * running an expensive CGI/ring scan at 20 requests per second. */
	const notReadyDelays = [];
	app._scheduleCpuAudioPoll = (activeSession, delay) => {
		check(activeSession === bufferedSession,
			'wrong adaptive PCM session scheduled');
		notReadyDelays.push(delay);
	};
	request.get = () => Promise.resolve({
		status: 202,
		ok: false,
		headers: { get: () => null }
	});
	bufferedAudio.errors = 2;
	for (let attempt = 0; attempt < 8; attempt++)
		await app._pollCpuBufferedAudio(bufferedSession);
	check(JSON.stringify(notReadyDelays) ===
		JSON.stringify([ 50, 100, 200, 400, 800, 1000, 1000, 1000 ]),
		'buffered PCM 202 polling did not use the bounded exponential backoff');
	check(notReadyDelays.slice(-3).reduce((sum, delay) => sum + delay, 0) === 3000,
		'sustained empty PCM polling exceeded one CGI request per second');
	check(bufferedAudio.errors === 0,
		'a healthy buffered PCM 202 did not reset prior transport failures');

	/* audio.lock contention is an authenticated retryable state, not evidence
	 * that the synchronized PCM ring was lost. Recovery is bounded; a lock which
	 * remains busy beyond the old request lifetime still fails closed. */
	const bufferedBusyClock = installFakeClock(2500000);
	const originalBufferedBusyFailure = app._failCpuBufferedPlayback;
	let bufferedBusyFailures = 0;
	let bufferedBusyResponses = 0;
	app._failCpuBufferedPlayback = activeSession => {
		check(activeSession === bufferedSession,
			'buffered PCM busy failure targeted the wrong session');
		bufferedBusyFailures++;
	};
	bufferedAudio.errors = 2;
	request.get = () => Promise.resolve({
		status: bufferedBusyResponses++ < 2 ? 409 : 202,
		ok: false,
		headers: {
			get: name => bufferedBusyResponses <= 2 &&
				String(name).toLowerCase() === 'x-videoplayer-audio-state'
				? 'busy'
				: null
		}
	});
	await app._pollCpuBufferedAudio(bufferedSession);
	bufferedBusyClock.advance(800);
	await app._pollCpuBufferedAudio(bufferedSession);
	await app._pollCpuBufferedAudio(bufferedSession);
	check(bufferedBusyFailures === 0 && bufferedAudio.errors === 0 &&
		bufferedAudio.busyStartedAt == null &&
		notReadyDelays.at(-1) === 50,
		'transient authenticated PCM busy state did not recover into normal polling');
	bufferedBusyResponses = 0;
	bufferedAudio.busyStartedAt = null;
	bufferedAudio.errors = 0;
	request.get = () => Promise.resolve({
		status: 409,
		ok: false,
		headers: {
			get: name => String(name).toLowerCase() ===
				'x-videoplayer-audio-state' ? 'busy' : null
		}
	});
	await app._pollCpuBufferedAudio(bufferedSession);
	bufferedBusyClock.advance(3000);
	await app._pollCpuBufferedAudio(bufferedSession);
	await app._pollCpuBufferedAudio(bufferedSession);
	await app._pollCpuBufferedAudio(bufferedSession);
	check(bufferedBusyFailures === 1,
		'persistent authenticated PCM busy state escaped its bounded failure window');
	app._failCpuBufferedPlayback = originalBufferedBusyFailure;
	bufferedBusyClock.restore();
	app._scheduleCpuAudioPoll = originalAudioScheduler;

	/* Playback schedules buffered PCM at one fixed rate. Approaching a missing
	 * next chunk suspends the clock without stopping already scheduled sources. */
	bufferedSession.bufferState = 'playing';
	bufferedSession.playClockContextAt = 1.12;
	bufferedSession.playClockMediaBase = 0;
	bufferedSession.renderedSeconds = 120;
	bufferedAudio.playSequence = 0;
	bufferedAudio.nextPlayTime = 1.12;
	app._fillCpuBufferedAudioQueue(bufferedSession);
	const fixedRateSource = bufferedContext.createdSources.at(-1);
	check(fixedRateSource.videoplayerPlaybackRate === 1 &&
		fixedRateSource.playbackRate.value === 1 &&
		Math.abs(fixedRateSource.videoplayerEndAt -
			fixedRateSource.videoplayerStartAt - 1) < 0.001,
		'buffered PCM was pitch-shifted away from normal speed');
	check(bufferedAudio.nextPlayTime - bufferedContext.currentTime > 2 &&
		bufferedAudio.nextPlayTime - bufferedContext.currentTime < 3,
		'one-second PCM chunks created an underrun-prone or excessive audio lead');
	const originalCreatePcmBuffer = bufferedContext.createBuffer;
	const originalScheduleDisable = app._disableCpuAudio;
	let scheduleDisableCalls = 0;
	bufferedContext.createBuffer = () => {
		throw new Error('closed AudioContext fixture');
	};
	app._disableCpuAudio = (activeSession, message, backendDraining) => {
		check(activeSession === bufferedSession &&
			/closed AudioContext fixture/.test(message) && !backendDraining,
			'Web Audio scheduling exception used an unsafe fallback path');
		scheduleDisableCalls++;
		return Promise.resolve(true);
	};
	const retainedPlaySequence = bufferedAudio.playSequence;
	const retainedChunk = new ArrayBuffer(192000);
	const retainedNextPlayTime = bufferedAudio.nextPlayTime;
	const retainedBufferedBytes = bufferedAudio.bufferedBytes;
	const previousRetainedChunk =
		bufferedAudio.bufferedChunks[retainedPlaySequence];
	bufferedAudio.bufferedChunks[retainedPlaySequence] = retainedChunk;
	bufferedAudio.bufferedBytes += retainedChunk.byteLength;
	bufferedAudio.nextPlayTime = bufferedContext.currentTime;
	check(app._fillCpuBufferedAudioQueue(bufferedSession) === false &&
		scheduleDisableCalls === 1 &&
		bufferedAudio.playSequence === retainedPlaySequence &&
		bufferedAudio.bufferedChunks[retainedPlaySequence] === retainedChunk,
		'Web Audio createBuffer exception escaped or discarded unscheduled PCM');
	if (previousRetainedChunk instanceof ArrayBuffer)
		bufferedAudio.bufferedChunks[retainedPlaySequence] = previousRetainedChunk;
	else
		delete bufferedAudio.bufferedChunks[retainedPlaySequence];
	bufferedAudio.bufferedBytes = retainedBufferedBytes;
	bufferedAudio.nextPlayTime = retainedNextPlayTime;
	bufferedContext.createBuffer = originalCreatePcmBuffer;
	app._disableCpuAudio = originalScheduleDisable;
	bufferedSession.playClockContextAt = 1;
	bufferedContext.currentTime = 11;
	bufferedAudio.nextPlayTime = 11.01;
	const originalPresentationScheduler = app._scheduleCpuBufferedPresentation;
	app._scheduleCpuBufferedPresentation = () => {};
	app._pollCpuBufferedPresentation(bufferedSession);
	check(bufferedSession.bufferState === 'rebuffering' &&
		bufferedContext.suspendCalls === 1 && !fixedRateSource.stopped &&
		Math.abs(bufferedSession.playedSeconds - 10) < 0.001 &&
		Math.abs(app._cpuBufferedPlaybackTime(bufferedSession) - 10) < 0.001,
		'a PCM underrun chopped the scheduled source instead of suspending its clock');
	bufferedAudio.bufferedUntil = 39.9;
	app._maybeStartCpuBufferedPlayback(bufferedSession);
	check(bufferedSession.bufferState === 'rebuffering',
		'rebuffer resumed before the 30-second refill watermark');
	bufferedAudio.bufferedUntil = 40;
	app._maybeStartCpuBufferedPlayback(bufferedSession);
	await flushMicrotasks();
	check(bufferedSession.bufferState === 'playing' &&
		bufferedContext.resumeCalls >= 1 &&
		Math.abs(app._cpuBufferedPlaybackTime(bufferedSession) - 10) < 0.001,
		'30-second refill did not resume the same suspended audio clock');
	bufferedContext.currentTime = 12;
	check(Math.abs(app._cpuBufferedPlaybackTime(bufferedSession) - 11) < 0.001,
		'rebuffer resume double-counted the already played media time');

	/* FFmpeg may report ended while the last open CGI is still draining. Keep
	 * audio paused when playback catches that incomplete video tail; only the
	 * independently confirmed transport drain can permit terminal completion. */
	bufferedSession.producerEnded = true;
	bufferedSession.videoProducerDrained = false;
	bufferedSession.renderedSeconds = 11.1;
	bufferedAudio.producerEnded = true;
	bufferedAudio.nextPlayTime = 20;
	app._pollCpuBufferedPresentation(bufferedSession);
	check(bufferedSession.bufferState === 'rebuffering',
		'terminal status let audio run ahead of a still-draining video tail');
	bufferedSession.playedSeconds = 11.1;
	check(!app._cpuBufferedPlaybackFinished(bufferedSession),
		'incomplete final video transport was treated as finished');
	bufferedSession.videoProducerDrained = true;
	bufferedSession.lastBufferedFrameSequence = 110;
	bufferedSession.displayedSequence = 110;
	bufferedSession.videoFrameIndex = bufferedSession.videoFrames.length;
	check(app._cpuBufferedPlaybackFinished(bufferedSession),
		'clean final video drain did not permit terminal completion');
	bufferedSession.producerEnded = false;
	bufferedSession.videoProducerDrained = false;
	bufferedAudio.producerEnded = false;

	const originalBufferedFailure = app._failCpuBufferedPlayback;
	let capFailures = 0;
	app._failCpuBufferedPlayback = (activeSession, message) => {
		check(activeSession === bufferedSession && /512 MiB/.test(message),
			'hard-cap failure did not identify its memory limit');
		capFailures++;
	};
	const capAttempt = { ready: true, cancelled: false };
	bufferedSession.streamVisibleAttempt = capAttempt;
	bufferedSession.videoBufferBytes = 512 * 1024 * 1024 - 2;
	app._acceptCpuBufferedFrame(
		bufferedSession,
		capAttempt,
		new Uint8Array([ 0xff, 0xd8, 0xff, 0xd9 ]),
		0
	);
	check(capFailures === 1 && bufferedSession.videoFrames.length === 0,
		'buffer hard cap retained a frame instead of failing before OOM');
	bufferedSession.videoBufferBytes = 0;
	app._failCpuBufferedPlayback = originalBufferedFailure;

	/* JPEGs are decoded off-DOM and drawn onto one persistent canvas. Stopping a
	 * session invalidates a late decode callback and releases all queued bytes. */
	const originalBlob = window.Blob;
	window.Blob = global.Blob;
	bufferedSession.bufferState = 'playing';
	const originalFrameObjectUrl = window.URL.createObjectURL;
	const originalFrameSetupFailure = app._failCpuBufferedPlayback;
	let frameSetupFailures = 0;
	window.URL.createObjectURL = () => {
		throw new Error('blob URL memory fixture');
	};
	app._failCpuBufferedPlayback = (activeSession, message) => {
		check(activeSession === bufferedSession &&
			/blob URL memory fixture/.test(message),
			'JPEG setup exception reported the wrong buffered failure');
		frameSetupFailures++;
	};
	bufferedSession.videoFrames = [ {
		bytes: new Uint8Array([ 0xff, 0xd8, 0xff, 0xd9 ]),
		sequence: 99,
		mediaTime: 9.9
	} ];
	bufferedSession.videoFrameIndex = 0;
	bufferedSession.videoBufferBytes = 4;
	bufferedSession.videoDecodeBytes = 0;
	bufferedSession.videoDecodeInFlight = null;
	app._decodeCpuBufferedFrame(bufferedSession, 99);
	check(frameSetupFailures === 1 &&
		bufferedSession.videoDecodeInFlight === null &&
		bufferedSession.videoDecodeBytes === 0 &&
		bufferedSession.videoBufferBytes === 0,
		'JPEG Blob URL exception leaked decode bytes or stalled presentation');
	window.URL.createObjectURL = originalFrameObjectUrl;
	app._failCpuBufferedPlayback = originalFrameSetupFailure;
	bufferedSession.videoFrames = [ {
		bytes: new Uint8Array([ 0xff, 0xd8, 0xff, 0xd9 ]),
		sequence: 0,
		mediaTime: 0
	} ];
	bufferedSession.videoFrameIndex = 0;
	bufferedSession.videoBufferBytes = 4;
	bufferedSession.videoDecodeBytes = 0;
	bufferedSession.videoDecodeInFlight = null;
	app._decodeCpuBufferedFrame(bufferedSession, 0);
	const firstCanvasDecode = bufferedSession.videoDecodeInFlight;
	check(firstCanvasDecode && bufferedCanvas.context.drawCalls.length === 0,
		'buffered JPEG was not decoded off-DOM');
	firstCanvasDecode.node.naturalWidth = 640;
	firstCanvasDecode.node.naturalHeight = 360;
	firstCanvasDecode.node.onload();
	check(bufferedCanvas.context.drawCalls.length === 1 &&
		bufferedSession.canvas === bufferedCanvas &&
		bufferedSession.displayedSequence === 0,
		'buffered JPEG replaced the surface instead of drawing on its canvas');
	bufferedSession.videoFrames = [ {
		bytes: new Uint8Array([ 0xff, 0xd8, 0xff, 0xd9 ]),
		sequence: 1,
		mediaTime: 0.1
	} ];
	bufferedSession.videoFrameIndex = 0;
	bufferedSession.videoBufferBytes = 4;
	app._decodeCpuBufferedFrame(bufferedSession, 1);
	bufferedSession.videoDecodeInFlight.node.onerror();
	check(bufferedCanvas.context.drawCalls.length === 1,
		'a failed JPEG decode erased the last complete canvas frame');
	bufferedSession.videoFrames = [ {
		bytes: new Uint8Array([ 0xff, 0xd8, 0xff, 0xd9 ]),
		sequence: 2,
		mediaTime: 0.2
	} ];
	bufferedSession.videoFrameIndex = 0;
	bufferedSession.videoBufferBytes = 4;
	app._decodeCpuBufferedFrame(bufferedSession, 2);
	bufferedSession.videoDecodeInFlight.node.naturalWidth = 640;
	bufferedSession.videoDecodeInFlight.node.naturalHeight = 360;
	bufferedSession.videoDecodeInFlight.node.onload();
	check(bufferedCanvas.context.drawCalls.length === 2 &&
		bufferedSession.displayedSequence === 2,
		'a decode error prevented a later/reconnected frame from drawing');

	/* At 50/60 FPS the old fixed 20 ms end tolerance detached the session while
	 * its final JPEG was still decoding. Completion now waits for that exact
	 * sequence to reach the persistent canvas and for the queue to be empty. */
	for (const tailFps of [ 50, 60 ]) {
		const finalSequence = tailFps;
		const renderedEnd = (finalSequence + 1) / tailFps;
		bufferedSession.fps = tailFps;
		bufferedSession.producerEnded = true;
		bufferedSession.videoProducerDrained = true;
		bufferedAudio.producerEnded = true;
		bufferedSession.renderedSeconds = renderedEnd;
		bufferedSession.playedSeconds = renderedEnd - 0.0005;
		bufferedSession.lastBufferedFrameSequence = finalSequence;
		bufferedSession.lastDecodeFailureSequence = -1;
		bufferedSession.displayedSequence = finalSequence - 1;
		bufferedSession.videoFrames = [ {
			bytes: new Uint8Array([ 0xff, 0xd8, 0xff, 0xd9 ]),
			sequence: finalSequence,
			mediaTime: finalSequence / tailFps
		} ];
		bufferedSession.videoFrameIndex = 0;
		bufferedSession.videoBufferBytes = 4;
		bufferedSession.videoDecodeBytes = 0;
		bufferedSession.videoDecodeInFlight = null;
		app._decodeCpuBufferedFrame(bufferedSession, finalSequence);
		const finalDecode = bufferedSession.videoDecodeInFlight;
		check(finalDecode && !app._cpuBufferedPlaybackFinished(bufferedSession),
			`${tailFps} FPS playback finished during its final async decode`);
		finalDecode.node.naturalWidth = 640;
		finalDecode.node.naturalHeight = 360;
		finalDecode.node.onload();
		check(app._cpuBufferedPlaybackFinished(bufferedSession),
			`${tailFps} FPS playback did not finish after its final canvas draw`);
		bufferedSession.playedSeconds = renderedEnd - 0.0015;
		check(!app._cpuBufferedPlaybackFinished(bufferedSession),
			`${tailFps} FPS playback retained the unsafe 20 ms end tolerance`);
	}

	/* Returning from a hidden/rebuffering state in the final sub-250 ms tail must
	 * resume long enough to present the last frame; the ordinary 30-second refill
	 * watermark and PCM-chunk tolerance must not deadlock clean EOF. */
	const originalTailResume = app._resumeCpuBufferedPlayback;
	let tailResumes = 0;
	app._resumeCpuBufferedPlayback = activeSession => {
		check(activeSession === bufferedSession,
			'final-tail resume targeted the wrong session');
		tailResumes++;
	};
	document.hidden = false;
	bufferedSession.bufferState = 'hidden';
	bufferedSession.fps = 60;
	bufferedSession.renderedSeconds = 10;
	bufferedSession.playedSeconds = 9.99;
	bufferedSession.lastBufferedFrameSequence = 599;
	bufferedSession.displayedSequence = 598;
	bufferedSession.videoFrames = [ {
		bytes: new Uint8Array([ 0xff, 0xd8, 0xff, 0xd9 ]),
		sequence: 599,
		mediaTime: 599 / 60
	} ];
	bufferedSession.videoFrameIndex = 0;
	bufferedSession.videoDecodeInFlight = null;
	app._maybeStartCpuBufferedPlayback(bufferedSession);
	check(tailResumes === 1,
		'clean final sub-chunk tail remained stuck after visibility recovery');
	app._resumeCpuBufferedPlayback = originalTailResume;
	bufferedSession.bufferState = 'playing';
	bufferedSession.producerEnded = false;
	bufferedSession.videoProducerDrained = false;
	bufferedAudio.producerEnded = false;
	const drawsBeforeStaleDecode = bufferedCanvas.context.drawCalls.length;
	bufferedSession.videoFrames = [ {
		bytes: new Uint8Array([ 0xff, 0xd8, 0xff, 0xd9 ]),
		sequence: 3,
		mediaTime: 0.3
	} ];
	bufferedSession.videoFrameIndex = 0;
	bufferedSession.videoBufferBytes = 4;
	app._decodeCpuBufferedFrame(bufferedSession, 3);
	const staleDecode = bufferedSession.videoDecodeInFlight;
	const staleOnload = staleDecode.node.onload;
	app._stopPlayback();
	staleDecode.node.naturalWidth = 640;
	staleDecode.node.naturalHeight = 360;
	staleOnload();
	check(bufferedCanvas.context.drawCalls.length === drawsBeforeStaleDecode &&
		bufferedSession.videoFrames.length === 0 &&
		bufferedSession.videoBufferBytes === 0 &&
		bufferedSession.videoDecodeBytes === 0,
		'cleanup retained bytes or allowed a stale JPEG to overwrite the canvas');
	app._scheduleCpuBufferedPresentation = originalPresentationScheduler;
	window.Blob = originalBlob;

	/* A Web Audio failure in strict CPU mode is fatal: it must close the audio
	 * context, detach the router session, and never continue via source audio. */
	const closeContext = fakeContext();
	closeContext.currentTime = 11;
	const closingAudio = {
		active: true,
		context: closeContext,
		gain: closeContext.createGain(),
		url: '/cgi-bin/videoplayer-audio?token=' + '1'.repeat(32),
		fetchSequence: 12,
		batchMaxChunks: 2,
		pollGeneration: 0,
		timer: null,
		inFlight: false,
		inFlightGeneration: null,
		bufferedChunks: Object.create(null),
		bufferedBytes: 0,
		bufferedUntil: 180,
		producerEnded: false,
		bufferPaused: false,
		nextPlayTime: 11,
		sources: []
	};
	const closingSession = {
		active: true,
		generation: 122,
		token: '1'.repeat(32),
		label: 'closing-audio.mp4',
		relPath: 'closing-audio.mp4',
		bufferedPlayback: true,
		bufferState: 'playing',
		producerEnded: false,
		videoProducerDrained: false,
		fps: 10,
		durationSeconds: 600,
		renderedSeconds: 180,
		playedSeconds: 0,
		playClockMediaBase: 0,
		playClockContextAt: 1,
		playClockWallAt: null,
		audio: closingAudio,
		pendingAudio: null,
		presentationTimer: null,
		finishing: null
	};
	app._cpuSession = closingSession;
	app._playGeneration = 122;
	app._currentKind = 'local';
	app._currentRenderMode = 'router';
	await app._disableCpuAudio(
		closingSession, 'forced mid-play PCM close'
	);
	check(
		closingSession.audio === null &&
		app._cpuSession === null &&
		app._currentRenderMode === null &&
		closeContext.closed,
		'mid-play PCM failure did not stop strict CPU playback'
	);

	/* A resume requested while AudioContext.suspend() is still pending must be
	 * serialized after that suspend; otherwise a late suspend leaves a session
	 * marked playing with a stopped clock. */
	const deferredSuspend = deferred();
	const suspendContext = fakeContext();
	suspendContext.currentTime = 11;
	suspendContext.suspend = function () {
		this.suspendCalls++;
		return deferredSuspend.promise.then(() => {
			this.state = 'suspended';
		});
	};
	const suspendAudio = {
		active: true,
		context: suspendContext,
		gain: suspendContext.createGain(),
		bufferedChunks: Object.create(null),
		bufferedBytes: 0,
		bufferedUntil: 40,
		producerEnded: false,
		playSequence: 0,
		nextPlayTime: 11,
		bufferPaused: false,
		suspendGeneration: 0,
		suspendPromise: null,
		resumeFailed: false,
		sources: []
	};
	const suspendSession = {
		active: true,
		generation: 123,
		label: 'deferred-suspend.mp4',
		bufferedPlayback: true,
		bufferState: 'playing',
		producerEnded: false,
		videoProducerDrained: false,
		fps: 10,
		durationSeconds: 600,
		renderedSeconds: 40,
		playedSeconds: 0,
		playClockMediaBase: 0,
		playClockContextAt: 1,
		playClockWallAt: null,
		bufferResumeGeneration: 0,
		audio: suspendAudio,
		presentationTimer: null,
		finishing: null
	};
	app._cpuSession = suspendSession;
	app._playGeneration = 123;
	app._currentKind = 'local';
	app._currentRenderMode = 'router';
	const originalBufferedScheduler = app._scheduleCpuBufferedPresentation;
	app._scheduleCpuBufferedPresentation = () => {};
	app._enterCpuBufferedRebuffer(suspendSession, false);
	app._maybeStartCpuBufferedPlayback(suspendSession);
	check(suspendSession.bufferState === 'resuming' &&
		suspendContext.resumeCalls === 0,
		'buffered playback raced resume ahead of an unfinished suspend');
	deferredSuspend.resolve();
	await flushMicrotasks();
	check(suspendSession.bufferState === 'playing' &&
		suspendContext.resumeCalls === 1 &&
		Math.abs(app._cpuBufferedPlaybackTime(suspendSession) - 10) < 0.001,
		'deferred suspend/resume did not preserve the media clock');
	app._stopPlayback();

	/* Hiding/rebuffering while resume() itself is pending must queue a suspend
	 * after it. Otherwise the late resume leaks audible PCM in a hidden tab. */
	const lateResume = deferred();
	const lateResumeContext = fakeContext({ state: 'suspended' });
	lateResumeContext.currentTime = 11;
	lateResumeContext.resume = function () {
		this.resumeCalls++;
		return lateResume.promise.then(() => {
			this.state = 'running';
		});
	};
	const lateResumeAudio = {
		active: true,
		context: lateResumeContext,
		gain: lateResumeContext.createGain(),
		bufferedChunks: Object.create(null),
		bufferedBytes: 0,
		bufferedUntil: 40,
		producerEnded: false,
		playSequence: 0,
		nextPlayTime: 11,
		bufferPaused: true,
		suspendGeneration: 1,
		suspendPromise: Promise.resolve(true),
		resumePromise: null,
		resumeFailed: false,
		sources: []
	};
	const lateResumeSession = {
		active: true,
		generation: 132,
		label: 'late-resume.mp4',
		bufferedPlayback: true,
		bufferState: 'rebuffering',
		producerEnded: false,
		videoProducerDrained: false,
		fps: 10,
		durationSeconds: 600,
		durationSealed: false,
		renderedSeconds: 40,
		playedSeconds: 10,
		playClockMediaBase: 10,
		playClockContextAt: 11,
		playClockWallAt: null,
		bufferResumeGeneration: 0,
		audio: lateResumeAudio,
		presentationTimer: null,
		finishing: null
	};
	app._cpuSession = lateResumeSession;
	app._playGeneration = 132;
	app._currentKind = 'local';
	app._currentRenderMode = 'router';
	app._resumeCpuBufferedPlayback(lateResumeSession);
	await flushMicrotasks(2);
	check(lateResumeSession.bufferState === 'resuming' &&
		lateResumeContext.resumeCalls === 1,
		'late-resume race did not enter its pending resume operation');
	app._enterCpuBufferedRebuffer(lateResumeSession, true);
	check(lateResumeSession.bufferState === 'hidden' &&
		lateResumeContext.suspendCalls === 0,
		'hide raced an immediate suspend against a pending resume');
	lateResume.resolve();
	await flushMicrotasks();
	check(lateResumeSession.bufferState === 'hidden' &&
		lateResumeContext.suspendCalls === 1 &&
		lateResumeContext.state === 'suspended',
		'late resume left the synchronized audio clock running while hidden');
	app._stopPlayback();
	app._scheduleCpuBufferedPresentation = originalBufferedScheduler;


	/* A closed AudioContext must be handled by its statechange callback even
	 * after PCM EOF has stopped polling. */
	const previousAudioContextClass = window.AudioContext;
	const lifecycleContext = fakeContext();
	window.AudioContext = function () { return lifecycleContext; };
	const lifecycleAudio = app._createCpuAudio();
	lifecycleAudio.url = '/cgi-bin/videoplayer-audio?token=' + '2'.repeat(32);
	lifecycleAudio.fetchSequence = 16;
	lifecycleAudio.batchMaxChunks = 2;
	lifecycleAudio.bufferedChunks = Object.create(null);
	lifecycleAudio.bufferedBytes = 0;
	lifecycleAudio.bufferedUntil = 120;
	lifecycleAudio.producerEnded = true;
	lifecycleAudio.bufferPaused = false;
	lifecycleContext.currentTime = 21;
	const lifecycleSession = {
		active: true,
		generation: 131,
		token: '2'.repeat(32),
		label: 'closed-context.mp4',
		relPath: 'closed-context.mp4',
		bufferedPlayback: true,
		bufferState: 'playing',
		producerEnded: true,
		videoProducerDrained: true,
		fps: 10,
		durationSeconds: 180,
		durationSealed: true,
		renderedSeconds: 180,
		playedSeconds: 0,
		playClockMediaBase: 0,
		playClockContextAt: 1,
		playClockWallAt: null,
		audio: lifecycleAudio,
		pendingAudio: null,
		presentationTimer: null,
		finishing: null
	};
	app._cpuSession = lifecycleSession;
	app._playGeneration = 131;
	app._currentKind = 'local';
	app._currentRenderMode = 'router';
	lifecycleContext.state = 'closed';
	lifecycleContext.onstatechange();
	check(lifecycleSession.audio === null && app._cpuSession === null,
		'closed post-EOF AudioContext did not stop strict CPU playback');
	window.AudioContext = previousAudioContextClass;

	/* A bounded multipart EOF is only a handoff. Even if renderer status arrives
	 * in the no-successor gap, the browser must issue an explicit terminal drain
	 * and wait for its authenticated 204 acknowledgement before sealing time. */
	const originalEofMaybeStart = app._maybeStartCpuBufferedPlayback;
	const originalEofPresentation = app._scheduleCpuBufferedPresentation;
	const originalEofStatusScheduler = app._scheduleCpuStreamStatus;
	const originalEofReconnectScheduler = app._scheduleCpuStreamReconnect;
	const originalEofFailure = app._failCpuBufferedPlayback;
	const originalEofFetch = window.fetch;
	const originalEofAbortController = window.AbortController;
	let eofStarts = 0;
	let eofFailures = 0;
	let eofReconnects = 0;
	let eofReconnectDelays = [];
	let eofStatusSchedules = 0;
	app._maybeStartCpuBufferedPlayback = () => { eofStarts++; };
	app._scheduleCpuBufferedPresentation = () => {};
	app._scheduleCpuStreamStatus = () => { eofStatusSchedules++; };
	app._scheduleCpuStreamReconnect = (activeSession, delay) => {
		check(activeSession === app._cpuSession,
			'EOF reconnect targeted a stale CPU session');
		eofReconnects++;
		eofReconnectDelays.push(delay);
	};
	app._failCpuBufferedPlayback = () => { eofFailures++; };
	app._currentKind = 'local';
	app._currentRenderMode = 'router';
	const makeEofSession = generation => ({
		active: true,
		generation,
		token: String(generation % 10).repeat(32),
		label: 'eof-order.mp4',
		bufferedPlayback: true,
		bufferState: 'buffering',
		producerEnded: false,
		videoProducerDrained: false,
		videoTerminalDrainConfirmed: false,
		videoTerminalDrainBodyClean: false,
		fps: 10,
		durationSeconds: null,
		totalFrames: null,
		renderedSeconds: 30,
		playedSeconds: 0,
		videoFrames: [],
		videoFrameIndex: 0,
		videoBufferBytes: 0,
		videoDecodeBytes: 0,
		audio: null,
		streamPending: null,
		streamVisibleAttempt: null,
		streamProbeTimer: null,
		streamProbeAttempt: null,
		streamRefreshTimer: null,
		streamReconnectTimer: null,
		streamNextHandoffAt: null,
		streamOutageStartedAt: null,
		streamErrors: 0,
		streamFetchErrors: 0,
		streamStatusInFlight: false,
		streamStatusAgain: false,
		streamStatusErrors: 0,
		streamStatusWarned: false,
		finishing: null
	});
	/* Fetch EOF is observed only after the CGI has closed stdout and released
	 * stream.lock. Repeated buffered handoffs therefore reconnect immediately;
	 * retaining the native-image 250 ms grace here needlessly throttles a slow
	 * renderer by five percent at the five-media-second segment cap. */
	for (let round = 0; round < 2; round++) {
		const handoffSession = makeEofSession(140 + round);
		const handoffAttempt = {
			mode: 'fetch', streamId: String(140 + round) + '-1',
			responseStatus: 200, bodyEndedClean: true, ready: true,
			ended: false, cancelled: false, completed: false,
			transportEnded: true, terminalDrain: false, terminalCheck: false,
			decodeInFlight: null, queuedFrame: null, reader: null, controller: null
		};

		handoffSession.streamVisibleAttempt = handoffAttempt;
		handoffSession.videoTerminalDrainCandidateId = handoffAttempt.streamId;
		app._cpuSession = handoffSession;
		app._playGeneration = handoffSession.generation;
		app._completeCpuFetchStream(handoffSession, handoffAttempt);
		check(handoffAttempt.ended && eofReconnectDelays.at(-1) === 0 &&
			handoffSession.streamNextHandoffAt <= Date.now(),
			'clean buffered Fetch EOF retained an unnecessary handoff delay');
	}
	const verifyingSession = makeEofSession(142);
	const verifyingCleanAttempt = {
		mode: 'fetch', streamId: '142-1', responseStatus: 200,
		bodyEndedClean: true, ready: true, ended: false, cancelled: false,
		completed: false, transportEnded: true, terminalDrain: false,
		terminalCheck: false, decodeInFlight: null, queuedFrame: null,
		reader: null, controller: null
	};
	verifyingSession.videoTerminalDrainCandidateId = '142-1';
	verifyingSession.streamVisibleAttempt = verifyingCleanAttempt;
	app._cpuSession = verifyingSession;
	app._playGeneration = 142;
	app._completeCpuFetchStream(verifyingSession, verifyingCleanAttempt);
	let resolveDeferredStatus;
	rpcHandlers.renderer_status = () => new Promise(resolve => {
		resolveDeferredStatus = resolve;
	});
	const deferredStatusPoll = app._pollCpuStreamStatus(verifyingSession);
	await Promise.resolve();
	const eofGapStatuses = [ 409, 202, 410 ];
	for (let retry = 0; retry < eofGapStatuses.length; retry++) {
		const eofGapAttempt = {
			mode: 'fetch', streamId: '142-' + String(retry + 2),
			responseStatus: eofGapStatuses[retry], ready: false, ended: false,
			cancelled: false, completed: false, terminalDrain: false,
			terminalCheck: false, bodyEndedClean: false,
			decodeInFlight: null, queuedFrame: null, reader: null, controller: null
		};

		verifyingSession.streamPending = eofGapAttempt;
		app._handleCpuStreamFailure(verifyingSession, eofGapAttempt);
	}
	check(eofFailures === 0 && verifyingSession.streamFetchErrors === 0,
		'bodyless 202/409/410 EOF-gap responses exhausted the fetch startup budget');
	resolveDeferredStatus(attestedRendererStatus('ended'));
	await deferredStatusPoll;
	check(verifyingSession.producerEnded && eofFailures === 0,
		'deferred terminal status lost the preceding clean handoff evidence');
	eofReconnects = 0;
	eofReconnectDelays = [];
	eofStatusSchedules = 0;
	const pressureSession = makeEofSession(123);
	const pressureAttempt = {
		mode: 'fetch',
		ready: false,
		ended: false,
		cancelled: false,
		backpressured: true
	};
	pressureSession.streamSegmentMs = 45000;
	pressureSession.streamPending = pressureAttempt;
	app._cpuSession = pressureSession;
	app._playGeneration = 123;
	app._currentKind = 'local';
	app._currentRenderMode = 'router';
	app._markCpuBufferedAttemptReady(pressureSession, pressureAttempt);
	check(pressureSession.streamVisibleAttempt === pressureAttempt &&
		pressureSession.streamRefreshTimer === null &&
		!pressureAttempt.cancelled,
		'buffered fetch armed a destructive deadline abort under backpressure');
	pressureAttempt.ended = true;
	pressureSession.streamVisibleAttempt = null;
	const statusFirstSession = makeEofSession(124);
	const statusFirstAttempt = {
		mode: 'fetch',
		ready: true,
		ended: false,
		cancelled: false,
		completed: false,
		transportEnded: true,
		decodeInFlight: null,
		queuedFrame: null
	};
	statusFirstSession.streamVisibleAttempt = statusFirstAttempt;
	app._cpuSession = statusFirstSession;
	app._playGeneration = 124;
	app._currentKind = 'local';
	app._currentRenderMode = 'router';
	rpcHandlers.renderer_status = () => attestedRendererStatus('ended');
	await app._pollCpuStreamStatus(statusFirstSession);
	check(statusFirstSession.producerEnded &&
		!statusFirstSession.videoProducerDrained && eofReconnects === 0,
		'status-first EOF sealed before the open transport drained');
	app._completeCpuFetchStream(statusFirstSession, statusFirstAttempt);
	check(!statusFirstSession.videoProducerDrained && eofReconnects === 1,
		'status-first bounded EOF did not request terminal drain confirmation');

	const transportFirstSession = makeEofSession(125);
	const transportFirstAttempt = {
		mode: 'fetch',
		ready: true,
		ended: false,
		cancelled: false,
		completed: false,
		transportEnded: true,
		decodeInFlight: null,
		queuedFrame: null
	};
	transportFirstSession.streamVisibleAttempt = transportFirstAttempt;
	app._cpuSession = transportFirstSession;
	app._playGeneration = 125;
	app._completeCpuFetchStream(transportFirstSession, transportFirstAttempt);
	check(!transportFirstSession.videoProducerDrained && eofReconnects === 2,
		'transport-first EOF was finalized before terminal renderer status');
	await app._pollCpuStreamStatus(transportFirstSession);
	check(transportFirstSession.producerEnded &&
		!transportFirstSession.videoProducerDrained && eofReconnects === 3,
		'no-successor terminal gap did not request the retained FIFO drain');

	/* HTTP 410 is not proof that queued FIFO bytes were delivered. It may only
	 * trigger another bounded retry while the worker owns its terminal anchor. */
	const terminalGoneAttempt = {
		mode: 'fetch',
		ready: false,
		ended: false,
		cancelled: false,
		completed: false,
		transportEnded: false,
		terminalDrain: true,
		responseStatus: 410,
		decodeInFlight: null,
		queuedFrame: null,
		reader: null,
		controller: null
	};
	transportFirstSession.streamPending = terminalGoneAttempt;
	app._handleCpuStreamFailure(transportFirstSession, terminalGoneAttempt);
	check(!transportFirstSession.videoProducerDrained &&
		!transportFirstSession.videoTerminalDrainConfirmed &&
		eofReconnects === 4 && eofFailures === 0,
		'terminal 410 was incorrectly accepted as a complete FIFO drain');

	/* A terminal 200 must reach a clean Fetch body EOF before the backend-authored
	 * 204 may seal playback. The marker alone only proves relay-to-CGI delivery;
	 * it cannot prove that uhttpd flushed its buffered socket tail. */
	window.AbortController = function () {
		this.signal = {};
		this.abort = () => {};
	};
	window.fetch = () => Promise.resolve({
		status: 200,
		ok: true,
		headers: {
			get: name => String(name).toLowerCase() === 'content-type'
				? 'multipart/x-mixed-replace; boundary=videoplayer-' +
					transportFirstSession.token
				: null
		},
		body: {
			getReader: () => ({
				read: () => Promise.resolve({ done: true }),
				cancel: () => Promise.resolve()
			})
		}
	});
	const cleanTerminalBodyAttempt = {
		mode: 'fetch',
		streamId: '125-4',
		ready: false,
		ended: false,
		cancelled: false,
		completed: false,
		transportEnded: false,
		terminalDrain: true,
		bodyEndedClean: false,
		decodeInFlight: null,
		queuedFrame: null,
		reader: null,
		controller: null
	};
	transportFirstSession.streamPending = cleanTerminalBodyAttempt;
	app._startCpuFetchStream(
		transportFirstSession,
		cleanTerminalBodyAttempt,
		transportFirstSession.streamUrl + '&stream=125-4&drain=1'
	);
	await cleanTerminalBodyAttempt.fetchPromise;
	check(transportFirstSession.videoTerminalDrainBodyClean &&
		!transportFirstSession.videoProducerDrained,
		'clean terminal 200 body was not retained for 204 confirmation');

	/* A terminal socket failure followed by a valid server marker is not
	 * recoverable: the FIFO was consumed, but its final bytes may never have
	 * reached this browser. It must fall back instead of silently sealing. */
	const truncatedTerminalSession = makeEofSession(126);
	truncatedTerminalSession.producerEnded = true;
	const reconnectsBeforeTruncated = eofReconnects;
	app._cpuSession = truncatedTerminalSession;
	app._playGeneration = 126;
	window.fetch = () => Promise.resolve({
		status: 200,
		ok: true,
		headers: {
			get: name => String(name).toLowerCase() === 'content-type'
				? 'multipart/x-mixed-replace; boundary=videoplayer-' +
					truncatedTerminalSession.token
				: null
		},
		body: {
			getReader: () => ({
				read: () => Promise.reject(new Error('terminal socket cut')),
				cancel: () => Promise.resolve()
			})
		}
	});
	const truncatedTerminalAttempt = {
		mode: 'fetch', ready: false, ended: false, cancelled: false,
		streamId: '126-1',
		completed: false, transportEnded: false, terminalDrain: true,
		bodyEndedClean: false, decodeInFlight: null, queuedFrame: null,
		reader: null, controller: null
	};
	truncatedTerminalSession.streamPending = truncatedTerminalAttempt;
	app._startCpuFetchStream(
		truncatedTerminalSession,
		truncatedTerminalAttempt,
		truncatedTerminalSession.streamUrl + '&stream=126-1&drain=1'
	);
	await truncatedTerminalAttempt.fetchPromise;
	check(!truncatedTerminalSession.videoProducerDrained && eofFailures === 1 &&
		eofReconnects === reconnectsBeforeTruncated,
		'ambiguous terminal 200 failure was retried after consuming FIFO data');

	/* A 204 without the exact nonce-bound acknowledgement headers is never
	 * terminal proof, even after a prior request has populated local evidence. */
	window.fetch = () => Promise.resolve({
		status: 204,
		ok: true,
		headers: {
			get: name => String(name).toLowerCase() ===
				'x-videoplayer-video-drain'
				? 'complete'
				: null
		}
	});
	const rejectedTerminalConfirmation = {
		mode: 'fetch', ready: false, ended: false, cancelled: false,
		completed: false, transportEnded: false, terminalDrain: true,
		terminalCheck: true, streamId: '126-1',
		bodyEndedClean: false, decodeInFlight: null, queuedFrame: null,
		reader: null, controller: null
	};
	truncatedTerminalSession.streamPending = rejectedTerminalConfirmation;
	app._startCpuFetchStream(
		truncatedTerminalSession,
		rejectedTerminalConfirmation,
		truncatedTerminalSession.streamUrl + '&stream=126-1&drain=check'
	);
	await rejectedTerminalConfirmation.fetchPromise;
	check(!truncatedTerminalSession.videoProducerDrained && eofFailures === 2,
		'incomplete terminal 204 acknowledgement silently sealed missing frames');

	app._cpuSession = transportFirstSession;
	app._playGeneration = 125;
	window.fetch = () => Promise.resolve({
		status: 204,
		ok: true,
		headers: {
			get: name => {
				switch (String(name).toLowerCase()) {
				case 'x-videoplayer-video-drain': return 'complete';
				case 'x-videoplayer-video-drain-id': return '125-4';
				default: return null;
				}
			}
		}
	});
	const confirmedTerminalAttempt = {
		mode: 'fetch',
		streamId: '125-4',
		ready: false,
		ended: false,
		cancelled: false,
		completed: false,
		transportEnded: false,
		terminalDrain: true,
		terminalCheck: true,
		bodyEndedClean: false,
		decodeInFlight: null,
		queuedFrame: null,
		reader: null,
		controller: null
	};
	transportFirstSession.streamPending = confirmedTerminalAttempt;
	app._startCpuFetchStream(
		transportFirstSession,
		confirmedTerminalAttempt,
		transportFirstSession.streamUrl + '&stream=125-4&drain=check'
	);
	await confirmedTerminalAttempt.fetchPromise;
	check(transportFirstSession.videoTerminalDrainConfirmed &&
		transportFirstSession.videoProducerDrained &&
		transportFirstSession.durationSeconds === 30 &&
		eofFailures === 2 && eofStarts === 1,
		'authenticated terminal drain did not seal the complete buffer');
	check(eofStatusSchedules > 0,
		'terminal handoff stopped authenticated renderer-status polling');

	/* A successor B may receive 410 just before the ended status poll. Since B
	 * has no body and consumes no FIFO data, it must not replace the preceding
	 * clean candidate A which the worker can already have marked complete. */
	const nonBodySuccessorSession = makeEofSession(139);
	nonBodySuccessorSession.producerEnded = false;
	nonBodySuccessorSession.videoTerminalDrainCandidateId = '139-7';
	nonBodySuccessorSession.videoTerminalDrainBodyClean = true;
	nonBodySuccessorSession.videoTerminalDrainRetryConsume = false;
	nonBodySuccessorSession.streamUrl = '/cgi-bin/videoplayer-frame?token=' +
		nonBodySuccessorSession.token;
	nonBodySuccessorSession.streamAttempt = 8;
	const nonBodySuccessor = {
		mode: 'fetch', streamId: '139-8', responseStatus: 410,
		ready: false, ended: false, cancelled: false, completed: false,
		transportEnded: false, terminalDrain: false, terminalCheck: false,
		bodyEndedClean: false, decodeInFlight: null, queuedFrame: null,
		reader: null, controller: null
	};
	nonBodySuccessorSession.streamPending = nonBodySuccessor;
	app._cpuSession = nonBodySuccessorSession;
	app._playGeneration = 139;
	rpcHandlers.renderer_status = () => attestedRendererStatus('ended');
	await app._pollCpuStreamStatus(nonBodySuccessorSession);
	check(nonBodySuccessor.terminalDrain &&
		nonBodySuccessorSession.videoTerminalDrainCandidateId === '139-7' &&
		nonBodySuccessorSession.videoTerminalDrainBodyClean,
		'terminal status replaced clean candidate A with non-body successor B');
	app._handleCpuStreamFailure(nonBodySuccessorSession, nonBodySuccessor);
	const nonBodyFrame = fakeImageElement();
	nonBodyFrame.id = 'videoplayer-cpu-frame';
	fakeImageParent(nonBodyFrame);
	nonBodySuccessorSession.visibleFrame = nonBodyFrame;
	const originalNonBodyStart = app._startCpuFetchStream;
	const originalNonBodyProbe = app._scheduleCpuStreamProbe;
	const originalNonBodyCanFetch = app._canUseCpuFetchStream;
	let nonBodyRetryUrl = '';
	app._canUseCpuFetchStream = () => true;
	app._startCpuFetchStream = (activeSession, attempt, url) => {
		check(activeSession === nonBodySuccessorSession &&
			attempt.streamId === '139-7' && attempt.terminalCheck,
			'non-body successor retry did not preserve clean candidate A');
		nonBodyRetryUrl = String(url);
	};
	app._scheduleCpuStreamProbe = () => {};
	app._openCpuStream(nonBodySuccessorSession);
	check(nonBodyRetryUrl.includes('stream=139-7&drain=check'),
		'terminal retry used non-body successor B instead of clean candidate A');
	nonBodySuccessorSession.streamPending = null;
	app._startCpuFetchStream = originalNonBodyStart;
	app._scheduleCpuStreamProbe = originalNonBodyProbe;
	app._canUseCpuFetchStream = originalNonBodyCanFetch;

	/* A relay can hit its segment cap immediately after the CGI publishes
	 * ready(A), leaving the worker pinned to A but check(A) still at 202. The
	 * browser must consume again with A, never invent B. If complete(A) appears
	 * just before that consume is dispatched, its exact 204 may use the saved
	 * clean A body even though dispatch conservatively cleared shared evidence. */
	const nonceRaceSession = makeEofSession(136);
	nonceRaceSession.producerEnded = true;
	nonceRaceSession.videoTerminalDrainCandidateId = '136-7';
	nonceRaceSession.videoTerminalDrainBodyClean = true;
	nonceRaceSession.videoTerminalDrainRetryConsume = false;
	nonceRaceSession.streamUrl = '/cgi-bin/videoplayer-frame?token=' +
		nonceRaceSession.token;
	nonceRaceSession.streamAttempt = 7;
	nonceRaceSession.fetchDisabled = false;
	const nonceRaceFrame = fakeImageElement();
	nonceRaceFrame.id = 'videoplayer-cpu-frame';
	fakeImageParent(nonceRaceFrame);
	nonceRaceSession.visibleFrame = nonceRaceFrame;
	app._cpuSession = nonceRaceSession;
	app._playGeneration = 136;
	const originalNonceRaceCanFetch = app._canUseCpuFetchStream;
	app._canUseCpuFetchStream = () => true;
	window.fetch = () => Promise.resolve({
		status: 202,
		ok: false,
		headers: { get: () => null }
	});
	const pendingNonceCheck = {
		mode: 'fetch', streamId: '136-7', ready: false, ended: false,
		cancelled: false, completed: false, transportEnded: false,
		terminalDrain: true, terminalCheck: true, bodyEndedClean: false,
		decodeInFlight: null, queuedFrame: null, reader: null, controller: null
	};
	nonceRaceSession.streamPending = pendingNonceCheck;
	app._startCpuFetchStream(nonceRaceSession, pendingNonceCheck, '/check-a');
	await pendingNonceCheck.fetchPromise;
	check(nonceRaceSession.videoTerminalDrainCandidateId === '136-7' &&
		nonceRaceSession.videoTerminalDrainBodyClean &&
		nonceRaceSession.videoTerminalDrainRetryConsume,
		'terminal 202 abandoned the nonce already captured by the worker');
	let nonceRaceUrl = '';
	window.fetch = url => {
		nonceRaceUrl = String(url);
		return Promise.resolve({
			status: 204,
			ok: true,
			headers: {
				get: name => {
					switch (String(name).toLowerCase()) {
					case 'x-videoplayer-video-drain': return 'complete';
					case 'x-videoplayer-video-drain-id': return '136-7';
					default: return null;
					}
				}
			}
		});
	};
	app._openCpuStream(nonceRaceSession);
	const lateCompleteAttempt = nonceRaceSession.streamPending;
	check(lateCompleteAttempt && !lateCompleteAttempt.terminalCheck &&
		lateCompleteAttempt.streamId === '136-7' &&
		lateCompleteAttempt.priorTerminalBodyClean,
		'same-nonce terminal retry did not preserve its prior clean body');
	await lateCompleteAttempt.fetchPromise;
	check(nonceRaceUrl.includes('stream=136-7&drain=1') &&
		nonceRaceSession.videoTerminalDrainConfirmed &&
		nonceRaceSession.videoProducerDrained,
		'late complete(A) was not accepted by the idempotent drain(A) retry');
	app._canUseCpuFetchStream = originalNonceRaceCanFetch;

	/* Repeated authenticated `ended` status polls may release an ordinary
	 * response that transitioned into the terminal drainer, but must never
	 * rewrite an already explicit check(A) or erase its clean A evidence while
	 * the 204 response is delayed. */
	const repeatedEndedSession = makeEofSession(137);
	repeatedEndedSession.producerEnded = true;
	repeatedEndedSession.videoTerminalDrainStartedAt = Date.now();
	repeatedEndedSession.videoTerminalDrainCandidateId = '137-2';
	repeatedEndedSession.videoTerminalDrainBodyClean = true;
	const delayedEndedCheck = deferred();
	window.fetch = () => delayedEndedCheck.promise;
	const repeatedEndedAttempt = {
		mode: 'fetch', streamId: '137-2', ready: false, ended: false,
		cancelled: false, completed: false, transportEnded: false,
		terminalDrain: true, terminalCheck: true, bodyEndedClean: false,
		decodeInFlight: null, queuedFrame: null, reader: null, controller: null
	};
	repeatedEndedSession.streamPending = repeatedEndedAttempt;
	app._cpuSession = repeatedEndedSession;
	app._playGeneration = 137;
	app._startCpuFetchStream(
		repeatedEndedSession, repeatedEndedAttempt, '/delayed-ended-check'
	);
	await app._pollCpuStreamStatus(repeatedEndedSession);
	check(repeatedEndedAttempt.terminalDrain &&
		repeatedEndedAttempt.terminalCheck &&
		repeatedEndedSession.videoTerminalDrainBodyClean,
		'repeated ended status rewrote an in-flight terminal confirmation');
	delayedEndedCheck.resolve({
		status: 204,
		ok: true,
		headers: {
			get: name => {
				switch (String(name).toLowerCase()) {
				case 'x-videoplayer-video-drain': return 'complete';
				case 'x-videoplayer-video-drain-id': return '137-2';
				default: return null;
				}
			}
		}
	});
	await repeatedEndedAttempt.fetchPromise;
	check(repeatedEndedSession.videoTerminalDrainConfirmed &&
		repeatedEndedSession.videoProducerDrained,
		'delayed terminal 204 failed after a repeated ended status poll');

	/* The last ordinary successor can consist solely of FFmpeg's closing
	 * multipart boundary. It accepts no JPEG (`ready` stays false), but its clean
	 * nonce-bound body must remain valid evidence when renderer status becomes
	 * ended before the following drain check. */
	const closeOnlySession = makeEofSession(131);
	const closeOnlyNonce = '131-1';
	const closeOnlyBytes = Uint8Array.from(Buffer.from(
		'--videoplayer-' + closeOnlySession.token + '--\r\n', 'ascii'
	));
	let closeOnlyReads = 0;
	const failuresBeforeCloseOnly = eofFailures;
	app._cpuSession = closeOnlySession;
	app._playGeneration = 131;
	window.fetch = () => Promise.resolve({
		status: 200,
		ok: true,
		headers: {
			get: name => String(name).toLowerCase() === 'content-type'
				? 'multipart/x-mixed-replace; boundary=videoplayer-' +
					closeOnlySession.token
				: null
		},
		body: {
			getReader: () => ({
				read: () => {
					if (closeOnlyReads++ === 0)
						return Promise.resolve({
							done: false,
							value: closeOnlyBytes
						});
					closeOnlySession.producerEnded = true;
					return Promise.resolve({ done: true });
				},
				cancel: () => Promise.resolve()
			})
		}
	});
	const closeOnlyAttempt = {
		mode: 'fetch', streamId: closeOnlyNonce, responseStatus: 0,
		ready: false, ended: false, cancelled: false, completed: false,
		transportEnded: false, terminalDrain: false, terminalCheck: false,
		bodyEndedClean: false, decodeInFlight: null, queuedFrame: null,
		reader: null, controller: null
	};
	closeOnlySession.streamPending = closeOnlyAttempt;
	app._startCpuFetchStream(closeOnlySession, closeOnlyAttempt, '/close-only');
	await closeOnlyAttempt.fetchPromise;
	check(!closeOnlyAttempt.ready && closeOnlyAttempt.ended &&
		closeOnlySession.videoTerminalDrainCandidateId === closeOnlyNonce &&
		closeOnlySession.videoTerminalDrainBodyClean &&
		eofFailures === failuresBeforeCloseOnly,
		'clean close-only successor was rejected before terminal status confirmation');
	window.fetch = () => Promise.resolve({
		status: 204,
		ok: true,
		headers: {
			get: name => {
				switch (String(name).toLowerCase()) {
				case 'x-videoplayer-video-drain': return 'complete';
				case 'x-videoplayer-video-drain-id': return closeOnlyNonce;
				default: return null;
				}
			}
		}
	});
	const closeOnlyCheck = {
		mode: 'fetch', streamId: closeOnlyNonce, ready: false, ended: false,
		cancelled: false, completed: false, transportEnded: false,
		terminalDrain: true, terminalCheck: true, bodyEndedClean: false,
		decodeInFlight: null, queuedFrame: null, reader: null, controller: null
	};
	closeOnlySession.streamPending = closeOnlyCheck;
	app._startCpuFetchStream(closeOnlySession, closeOnlyCheck, '/close-only-check');
	await closeOnlyCheck.fetchPromise;
	check(closeOnlySession.videoTerminalDrainConfirmed &&
		closeOnlySession.videoProducerDrained && eofFailures === failuresBeforeCloseOnly,
		'authenticated close-only successor did not seal terminal video');

	/* Disposing a consuming terminal request must erase any older clean-body
	 * observation for the same nonce. Otherwise a later 204 could authenticate
	 * bytes consumed by this cancelled request but never delivered to JS. */
	const cancelledTerminalSession = makeEofSession(127);
	cancelledTerminalSession.producerEnded = true;
	cancelledTerminalSession.videoTerminalDrainCandidateId = '127-1';
	cancelledTerminalSession.videoTerminalDrainBodyClean = true;
	const cancelledTerminalAttempt = {
		mode: 'fetch', streamId: '127-1', terminalDrain: true,
		terminalCheck: false, bodyEndedClean: false, ready: false,
		ended: false, cancelled: false, completed: false, reader: null,
		controller: { abort() {} }, decodeInFlight: null, queuedFrame: null
	};
	cancelledTerminalSession.streamPending = cancelledTerminalAttempt;
	app._cpuSession = cancelledTerminalSession;
	app._playGeneration = 127;
	app._clearCpuStreamRequest(cancelledTerminalSession, false);
	check(!cancelledTerminalSession.videoTerminalDrainBodyClean &&
		cancelledTerminalAttempt.cancelled,
		'cancelled terminal request retained stale clean-body evidence');

	/* A terminal fetch may legitimately take more than the ordinary five-second
	 * startup window. It still gets a 15-second first-frame bound, while the
	 * entire status-driven handshake shares one 120-second safety deadline. */
	const terminalClock = installFakeClock(2000000);
	const delayedTerminalSession = makeEofSession(128);
	delayedTerminalSession.producerEnded = true;
	delayedTerminalSession.videoTerminalDrainStartedAt = Date.now();
	const delayedTerminalAttempt = {
		mode: 'fetch', streamId: '128-1', terminalDrain: true,
		terminalCheck: false, bodyEndedClean: false, ready: false,
		ended: false, cancelled: false, completed: false,
		openedAt: Date.now(), lastProgressAt: Date.now(),
		reader: null, controller: { abort() {} }, decodeInFlight: null,
		queuedFrame: null
	};
	delayedTerminalSession.streamPending = delayedTerminalAttempt;
	app._cpuSession = delayedTerminalSession;
	app._playGeneration = 128;
	const failuresBeforeFirstFrameTimeout = eofFailures;
	app._scheduleCpuStreamProbe(delayedTerminalSession, delayedTerminalAttempt);
	terminalClock.advance(6000);
	check(delayedTerminalSession.streamPending === delayedTerminalAttempt &&
		eofFailures === failuresBeforeFirstFrameTimeout,
		'terminal drain incorrectly inherited the five-second startup timeout');
	terminalClock.advance(9000);
	check(delayedTerminalSession.streamPending === null &&
		delayedTerminalAttempt.cancelled &&
		eofFailures === failuresBeforeFirstFrameTimeout + 1,
		'terminal first-frame wait exceeded its 15-second safety bound');

	const deadlineSession = makeEofSession(129);
	deadlineSession.producerEnded = true;
	deadlineSession.videoTerminalDrainStartedAt = Date.now();
	app._cpuSession = deadlineSession;
	app._playGeneration = 129;
	let deadlineStatusCalls = 0;
	rpcHandlers.renderer_status = () => {
		deadlineStatusCalls++;
		return attestedRendererStatus('ended');
	};
	terminalClock.jump(119000);
	const failuresBeforeDeadline = eofFailures;
	await app._pollCpuStreamStatus(deadlineSession);
	check(deadlineStatusCalls === 1 && eofFailures === failuresBeforeDeadline,
		'terminal status polling stopped before the shared deadline');
	terminalClock.jump(1000);
	await app._pollCpuStreamStatus(deadlineSession);
	check(deadlineStatusCalls === 1 && eofFailures === failuresBeforeDeadline + 1,
		'terminal handshake exceeded its 120-second global deadline');

	/* A confirmed terminal drain can leave minutes of queued playback. Keep
	 * authenticated status-touch polling alive past the handshake deadline so
	 * the terminal session remains authenticated while its already-buffered
	 * JPEG/PCM outputs play; detaching playback must cancel that status lease
	 * timer immediately. */
	const drainedLeaseSession = makeEofSession(138);
	drainedLeaseSession.bufferState = 'playing';
	drainedLeaseSession.producerEnded = true;
	drainedLeaseSession.videoProducerDrained = true;
	drainedLeaseSession.videoTerminalDrainConfirmed = true;
	drainedLeaseSession.videoTerminalDrainStartedAt = Date.now();
	app._cpuSession = drainedLeaseSession;
	app._playGeneration = 138;
	let drainedLeaseStatusCalls = 0;
	rpcHandlers.renderer_status = () => {
		drainedLeaseStatusCalls++;
		return attestedRendererStatus('ended');
	};
	terminalClock.jump(121000);
	const failuresBeforeDrainedLease = eofFailures;
	app._scheduleCpuStreamStatus = originalEofStatusScheduler;
	await app._pollCpuStreamStatus(drainedLeaseSession);
	check(drainedLeaseStatusCalls === 1 &&
		eofFailures === failuresBeforeDrainedLease &&
		drainedLeaseSession.streamStatusTimer != null,
		'confirmed terminal playback stopped renewing its status lease');
	const originalDrainedLeaseStop = app._stopRendererBestEffort;
	let stoppedDrainedLease = null;
	app._stopRendererBestEffort = stoppedSession => {
		stoppedDrainedLease = stoppedSession;
	};
	await app._finishCpuPlayback(
		drainedLeaseSession, 'terminal buffered playback finished', false, true
	);
	check(stoppedDrainedLease === drainedLeaseSession &&
		drainedLeaseSession.streamStatusTimer === null && app._cpuSession === null,
		'finishing confirmed terminal playback retained its status lease');
	app._stopRendererBestEffort = originalDrainedLeaseStop;
	app._currentKind = 'local';
	app._currentRenderMode = 'router';
	app._scheduleCpuStreamStatus = () => { eofStatusSchedules++; };
	terminalClock.restore();

	/* Any ambiguous failure after dispatching a buffered 200 stream is fatal,
	 * even outside terminal drain: the relay may have consumed multiple frames
	 * which never reached JavaScript, so a guessed reconnect would drift PCM. */
	const interruptedBodySession = makeEofSession(130);
	const interruptedBodyAttempt = {
		mode: 'fetch', streamId: '130-1', responseStatus: 200,
		bodyEndedClean: false, ready: true, ended: false, cancelled: false,
		completed: false, terminalDrain: false, terminalCheck: false,
		reader: null, controller: { abort() {} }, decodeInFlight: null,
		queuedFrame: null
	};
	interruptedBodySession.streamVisibleAttempt = interruptedBodyAttempt;
	app._cpuSession = interruptedBodySession;
	app._playGeneration = 130;
	const reconnectsBeforeInterruptedBody = eofReconnects;
	const failuresBeforeInterruptedBody = eofFailures;
	app._handleCpuStreamFailure(interruptedBodySession, interruptedBodyAttempt);
	check(eofFailures === failuresBeforeInterruptedBody + 1 &&
		eofReconnects === reconnectsBeforeInterruptedBody &&
		interruptedBodyAttempt.cancelled,
		'interrupted buffered 200 body was retried with an invented frame clock');

	/* High-water applies only between bounded responses. An already-dispatched
	 * body is always drained, then successors remain closed for arbitrarily long
	 * hidden/playback holds and reopen as soon as capacity returns. During the
	 * initial two-minute gate, reserving less than one maximum segment cannot
	 * make progress, so the player falls back deterministically instead of
	 * polling forever at 90% of the hard byte cap. */
	const capacityClock = installFakeClock(3000000);
	const originalCapacityOpen = app._openCpuStream;
	let capacityOpens = 0;
	app._scheduleCpuStreamReconnect = originalEofReconnectScheduler;
	app._openCpuStream = activeSession => {
		check(activeSession === app._cpuSession,
			'capacity gate opened a stale CPU stream');
		capacityOpens++;
	};
	const activeBodyAttempt = { backpressured: true };
	await app._waitForCpuBufferedCapacity(interruptedBodySession, activeBodyAttempt);
	check(!activeBodyAttempt.backpressured,
		'active buffered HTTP 200 body remained paused at high-water');
	const stalledResponseSession = makeEofSession(135);
	stalledResponseSession.bufferState = 'playing';
	stalledResponseSession.streamSegmentMs = 45000;
	const stalledResponseAttempt = {
		mode: 'fetch', streamId: '135-1', responseStatus: 200,
		responseStartedAt: capacityClock.now(), openedAt: capacityClock.now(),
		lastProgressAt: capacityClock.now(), ready: false, ended: false,
		cancelled: false, completed: false, transportEnded: false,
		terminalDrain: false, terminalCheck: false, bodyEndedClean: false,
		backpressured: false, reader: null, controller: { abort() {} },
		decodeInFlight: null, queuedFrame: null
	};
	stalledResponseSession.streamPending = stalledResponseAttempt;
	stalledResponseSession.videoTerminalDrainCandidateId = '135-1';
	app._cpuSession = stalledResponseSession;
	app._playGeneration = 135;
	const failuresBeforeStalledResponse = eofFailures;
	app._scheduleCpuStreamProbe(stalledResponseSession, stalledResponseAttempt);
	capacityClock.advance(16000);
	check(eofFailures === failuresBeforeStalledResponse &&
		stalledResponseSession.streamPending === stalledResponseAttempt,
		'accepted buffered 200 was aborted during a valid pre-frame PCM stall');
	stalledResponseAttempt.ready = true;
	stalledResponseAttempt.lastProgressAt = capacityClock.now();
	stalledResponseSession.streamPending = null;
	stalledResponseSession.streamVisibleAttempt = stalledResponseAttempt;
	capacityClock.advance(16000);
	check(eofFailures === failuresBeforeStalledResponse &&
		stalledResponseSession.streamVisibleAttempt === stalledResponseAttempt,
		'accepted buffered 200 was aborted during a valid post-frame PCM stall');
	stalledResponseAttempt.bodyEndedClean = true;
	stalledResponseAttempt.transportEnded = true;
	app._completeCpuFetchStream(stalledResponseSession, stalledResponseAttempt);
	check(stalledResponseAttempt.ended &&
		stalledResponseSession.videoTerminalDrainBodyClean &&
		eofFailures === failuresBeforeStalledResponse,
		'clean frame-aligned close was rejected after a long PCM stall');
	if (stalledResponseSession.streamReconnectTimer != null)
		window.clearTimeout(stalledResponseSession.streamReconnectTimer);
	stalledResponseSession.streamReconnectTimer = null;
	for (const withPcm of [ false, true ]) {
		const heldSession = makeEofSession(withPcm ? 133 : 132);
		heldSession.bufferState = 'playing';
		heldSession.renderedSeconds = 190;
		heldSession.playedSeconds = 0;
		heldSession.videoBufferBytes = 1024 * 1024;
		if (withPcm) {
			heldSession.audio = {
				active: true,
				producerEnded: false,
				bufferedBytes: 1024 * 1024
			};
		}
		app._cpuSession = heldSession;
		app._playGeneration = heldSession.generation;
		const opensBeforeHold = capacityOpens;
		app._scheduleCpuStreamReconnect(heldSession, 0);
		capacityClock.advance(91000);
		check(capacityOpens === opensBeforeHold &&
			heldSession.streamReconnectTimer != null &&
			heldSession.renderCapacityHeld === true &&
			heldSession.renderSpeed == null,
			(withPcm ? 'PCM' : 'audio-less') +
				' high-water hold opened a successor or retained a stale rate');
		heldSession.playedSeconds = 20;
		capacityClock.advance(100);
		check(capacityOpens === opensBeforeHold + 1 &&
			heldSession.streamReconnectTimer === null &&
			heldSession.renderCapacityHeld === false &&
			Number.isFinite(heldSession.renderRateAnchorAt),
			(withPcm ? 'PCM' : 'audio-less') +
				' high-water hold did not reopen below the threshold');
	}
	const reserveSession = makeEofSession(134);
	reserveSession.bufferState = 'buffering';
	reserveSession.renderedSeconds = 119;
	reserveSession.videoBufferBytes = 480 * 1024 * 1024;
	reserveSession.audio = {
		active: true,
		producerEnded: false,
		bufferedBytes: 12 * 1024 * 1024
	};
	app._cpuSession = reserveSession;
	app._playGeneration = 134;
	const failuresBeforeReserve = eofFailures;
	const opensBeforeReserve = capacityOpens;
	app._scheduleCpuStreamReconnect(reserveSession, 0);
	capacityClock.advance(1000);
	check(eofFailures === failuresBeforeReserve + 1 &&
		capacityOpens === opensBeforeReserve &&
		reserveSession.streamReconnectTimer === null,
		'initial 492 MiB buffer deadlocked below the two-minute start gate');
	app._openCpuStream = originalCapacityOpen;
	capacityClock.restore();
	app._stopPlayback();
	app._maybeStartCpuBufferedPlayback = originalEofMaybeStart;
	app._scheduleCpuBufferedPresentation = originalEofPresentation;
	app._scheduleCpuStreamStatus = originalEofStatusScheduler;
	app._scheduleCpuStreamReconnect = originalEofReconnectScheduler;
	app._failCpuBufferedPlayback = originalEofFailure;
	if (originalEofFetch === undefined)
		delete window.fetch;
	else
		window.fetch = originalEofFetch;
	if (originalEofAbortController === undefined)
		delete window.AbortController;
	else
		window.AbortController = originalEofAbortController;


	/* Strict CPU mode accepts only the attested private runtime contract and
	 * never reaches browser source decoding or original-track audio fallback. */
	const strictCanvas = fakeCanvasElement();
	elements['videoplayer-cpu-canvas'] = strictCanvas;
	const originalStrictOpen = app._openCpuStream;
	const originalStrictStatusSchedule = app._scheduleCpuStreamStatus;
	const originalStrictPlayInVideo = app._playInVideo;
	const originalStrictPrepare = app._preparePlaybackSurface;
	const originalStrictCanFetch = app._canUseCpuFetchStream;
	app._openCpuStream = () => {};
	app._scheduleCpuStreamStatus = () => {};
	app._canUseCpuFetchStream = () => true;
	let strictBrowserPlays = 0;
	app._playInVideo = () => {
		strictBrowserPlays++;
		return Promise.resolve();
	};

	rpcCalls.length = 0;
	app._playGeneration = 201;
	await app._playCpuStream(strictCpuSession('a'.repeat(32), {
		runtime_attested: false
	}), 'unattested.mp4', 201, null, 'unattested.mp4');
	check(app._cpuSession === null && strictBrowserPlays === 0 &&
		rpcCalls.some(call => call.method === 'stop_renderer'),
		'unattested CPU session was accepted or fell back to browser decoding');

	app._playGeneration = 202;
	await app._playCpuStream(
		strictCpuSession('b'.repeat(32)),
		'video-only.mp4', 202, null, 'video-only.mp4'
	);
	check(app._cpuSession && app._cpuSession.runtimeAttested === true &&
		app._cpuSession.rendererBackend === 'private-software-cpu' &&
		app._cpuSession.presentation === 'browser-managed' &&
		app._cpuSession.audio === null && app._cpuSession.pendingAudio === null,
		'attested video-only CPU source did not start silently');
	app._stopPlayback();

	rpcCalls.length = 0;
	app._playGeneration = 203;
	await app._playCpuStream(strictCpuSession('c'.repeat(32), {
		has_audio: true,
		audio_state: 'ready',
		audio_url: '/cgi-bin/videoplayer-audio?token=' + 'c'.repeat(32),
		audio_type: 'pcm-s16le-chunks',
		audio_sample_rate: 48000,
		audio_channels: 2,
		audio_frames_per_chunk: 48000
	}), 'no-webaudio.mp4', 203, null, 'no-webaudio.mp4');
	check(app._cpuSession === null && strictBrowserPlays === 0 &&
		rpcCalls.some(call => call.method === 'stop_renderer'),
		'advertised PCM without Web Audio did not fail closed');

	const throwingStrictCanvas = fakeCanvasElement();
	throwingStrictCanvas.getContext = () => { throw new Error('canvas blocked'); };
	elements['videoplayer-cpu-canvas'] = throwingStrictCanvas;
	rpcCalls.length = 0;
	app._playGeneration = 204;
	await app._playCpuStream(
		strictCpuSession('d'.repeat(32)),
		'canvas-error.mp4', 204, null, 'canvas-error.mp4'
	);
	check(app._cpuSession === null && strictBrowserPlays === 0 &&
		rpcCalls.some(call => call.method === 'stop_renderer'),
		'canvas failure invoked browser decoding or leaked the renderer');

	const remoteInput = { value: 'https://example.test/video.mp4' };
	elements['videoplayer-remote-url'] = remoteInput;
	const originalClearStrictField = app._clearFieldError;
	const originalSetStrictField = app._setFieldError;
	app._clearFieldError = () => {};
	app._setFieldError = () => {};
	app._allowRemote = true;
	app._renderMode = 'router';
	await app._playRemote();
	check(strictBrowserPlays === 0,
		'remote URL used browser decoding while strict CPU mode was active');

	rpcCalls.length = 0;
	rpcHandlers.start_renderer = () => ({
		error: 'forced start failure',
		session_token: 'f'.repeat(32)
	});
	rpcHandlers.resolve = () => fail('strict CPU start failure called resolve');
	app._localEnabled = true;
	app._canWriteSettings = true;
	app._rendererAvailable = true;
	app._status = {
		media_path_valid: true,
		media_path_exists: true,
		media_path_readable: true
	};
	app._preparePlaybackSurface = () => {};
	await app._playLocal('strict-start.mp4', 'strict-start.mp4');
	check(rpcCalls.filter(call => call.method === 'start_renderer').length === 1 &&
		rpcCalls.filter(call => call.method === 'resolve').length === 0 &&
		rpcCalls.some(call => call.method === 'stop_renderer' &&
			call.args[0] === 'f'.repeat(32)) &&
		strictBrowserPlays === 0,
		'strict CPU start failure leaked its renderer or reached browser playback');

	rpcCalls.length = 0;
	rpcHandlers.start_renderer = () => ({ session_token: '9'.repeat(32) });
	await app._playLocal('strict-malformed.mp4', 'strict-malformed.mp4');
	check(rpcCalls.some(call => call.method === 'stop_renderer' &&
			call.args[0] === '9'.repeat(32)) && strictBrowserPlays === 0,
		'malformed strict CPU response leaked its renderer session');

	rpcCalls.length = 0;
	rpcHandlers.start_renderer = () => strictCpuSession('8'.repeat(32));
	elements['videoplayer-cpu-canvas'] = strictCanvas;
	await app._playLocal('strict-transport.mp4', 'strict-transport.mp4');
	const reconnectFailureSession = app._cpuSession;
	const reconnectFailureFrame = fakeImageElement();
	const reconnectFailureClock = installFakeClock(4000000);
	const reconnectOriginalFetch = window.fetch;
	const reconnectOriginalAbortController = window.AbortController;
	reconnectFailureFrame.id = 'videoplayer-cpu-frame';
	fakeImageParent(reconnectFailureFrame);
	reconnectFailureSession.visibleFrame = reconnectFailureFrame;
	window.AbortController = function () {
		this.signal = {};
		this.abort = () => {};
	};
	window.fetch = () => {
		throw new Error('synchronous reconnect fetch failure');
	};
	app._openCpuStream = originalStrictOpen;
	app._scheduleCpuStreamReconnect(reconnectFailureSession, 0);
	reconnectFailureClock.advance(0);
	await flushMicrotasks();
	check(app._cpuSession === null &&
		rpcCalls.some(call => call.method === 'stop_renderer' &&
			call.args[0] === '8'.repeat(32)) && strictBrowserPlays === 0,
		'synchronous strict reconnect failure leaked its renderer session');
	reconnectFailureClock.restore();
	if (reconnectOriginalFetch === undefined)
		delete window.fetch;
	else
		window.fetch = reconnectOriginalFetch;
	if (reconnectOriginalAbortController === undefined)
		delete window.AbortController;
	else
		window.AbortController = reconnectOriginalAbortController;
	app._openCpuStream = () => {};

	const statusLossSession = {
		active: true,
		generation: 205,
		token: 'e'.repeat(32),
		bufferedPlayback: true,
		finishing: null,
		streamStatusInFlight: false,
		streamStatusAgain: false,
		streamStatusErrors: 0
	};
	app._cpuSession = statusLossSession;
	app._playGeneration = 205;
	app._currentKind = 'local';
	app._currentRenderMode = 'router';
	let statusAttestationFailures = 0;
	const originalStrictBufferedFailure = app._failCpuBufferedPlayback;
	app._failCpuBufferedPlayback = activeSession => {
		check(activeSession === statusLossSession,
			'status attestation failure targeted the wrong session');
		statusAttestationFailures++;
	};
	rpcHandlers.renderer_status = () => ({ state: 'running' });
	await app._pollCpuStreamStatus(statusLossSession);
	check(statusAttestationFailures === 1,
		'unattested renderer status did not fail strict CPU playback');
	app._failCpuBufferedPlayback = originalStrictBufferedFailure;
	app._cpuSession = null;
	app._openCpuStream = originalStrictOpen;
	app._scheduleCpuStreamStatus = originalStrictStatusSchedule;
	app._playInVideo = originalStrictPlayInVideo;
	app._preparePlaybackSurface = originalStrictPrepare;
	app._canUseCpuFetchStream = originalStrictCanFetch;
	app._clearFieldError = originalClearStrictField;
	app._setFieldError = originalSetStrictField;
	delete elements['videoplayer-remote-url'];

	/* The raw settings controls use LuCI's native Save / Save & Apply / Reset
	 * footer contract. Save only stages UCI changes; it must not mutate active
	 * player state or stop a live renderer before LuCI applies and reloads. */
	const originalUciGet = uci.get;
	const originalUciSet = uci.set;
	const originalUciSave = uci.save;
	const originalUciApply = uci.apply;
	const originalChangesApply = ui.changes.apply;
	const originalClearFieldForProfile = app._clearFieldError;
	const originalHandleStopForProfile = app.handleStop;
	const stagedSettings = {
		enabled: '1',
		media_path: '/mnt/video',
		allow_remote: '1',
		render_mode: 'router',
		router_profile: 'fast',
		router_fps: '60',
		router_max_threads: '0'
	};
	const activeSettings = {
		enabled: '1',
		media_path: '/mnt/video',
		allow_remote: '1',
		render_mode: 'router',
		router_profile: 'fast',
		router_fps: '8',
		router_max_threads: '0'
	};
	const profileControl = { value: 'fast' };
	const fpsControl = {
		value: '60',
		options: [ 5, 8, 12, 15, 20, 24, 30, 48, 50, 60 ].map(value => ({
			value: String(value),
			disabled: false
		}))
	};
	elements['vp-enabled'] = { checked: true };
	elements['vp-media-path'] = {
		value: '/mnt/video',
		setAttribute() {},
		focus() {}
	};
	elements['vp-allow-remote'] = { checked: true };
	elements['vp-render-mode'] = { value: 'router' };
	elements['vp-router-profile'] = profileControl;
	elements['vp-router-fps'] = fpsControl;
	elements['vp-router-max-threads'] = { checked: true };
	uci.get = (config, section, option) => stagedSettings[option];
	uci.set = (config, section, option, value) => {
		stagedSettings[option] = String(value);
	};
	let uciSaveCalls = 0;
	let rawUciApplyCalls = 0;
	const nativeApplyCalls = [];
	uci.save = () => {
		uciSaveCalls++;
		return Promise.resolve();
	};
	uci.apply = () => {
		rawUciApplyCalls++;
		return Promise.resolve();
	};
	ui.changes.apply = checked => nativeApplyCalls.push(checked);
	app._canWriteSettings = true;
	app._rendererAvailable = true;
	app._renderMode = 'router';
	app._routerProfile = 'fast';
	app._routerFps = 8;
	app._routerMaxThreads = false;
	app._status = { media_path: '/mnt/video', renderer_available: 1 };
	app._browseRequestId = 0;
	app._cwd = '';
	app._currentKind = null;
	app._currentRenderMode = null;
	app._clearFieldError = () => {};
	let profileStops = 0;
	app.handleStop = function () {
		profileStops++;
		this._currentKind = null;
		this._currentRenderMode = null;
		return Promise.resolve();
	};
	app.handleRouterProfileChange();
	check(fpsControl.value === '8' &&
		fpsControl.options.filter(option => Number(option.value) > 8)
			.every(option => option.disabled),
		'fast profile UI did not clamp and disable stale FPS values above 8');
	fpsControl.value = '60';
	check(await app.handleSave() === true,
		'native Save did not report successful UCI staging');
	check(stagedSettings.router_profile === 'fast' &&
		stagedSettings.router_fps === '8' &&
		stagedSettings.router_max_threads === '1' &&
		app._routerFps === 8 && app._routerMaxThreads === false,
		'Save did not stage maximum threads or changed the active CPU settings');
	check(uciSaveCalls === 1 && rawUciApplyCalls === 0 &&
		nativeApplyCalls.length === 0 && profileStops === 0,
		'native Save applied settings or changed active player state');
	profileControl.value = 'quality';
	app.handleRouterProfileChange();
	fpsControl.value = '60';
	app._currentKind = 'local';
	app._currentRenderMode = 'router';
	check(await app.handleSaveApply(null, 0) === true,
		'native checked Save & Apply did not complete staging');
	check(stagedSettings.router_profile === 'quality' &&
		stagedSettings.router_fps === '60' && app._routerFps === 8 &&
		fpsControl.options.every(option => !option.disabled),
		'quality profile did not retain and expose its 60 FPS target');
	check(uciSaveCalls === 2 && rawUciApplyCalls === 0 &&
		nativeApplyCalls.length === 1 && nativeApplyCalls[0] === true &&
		profileStops === 0,
		'native checked Save & Apply bypassed LuCI or changed active state early');
	check(await app.handleSaveApply(null, '1') === true &&
		nativeApplyCalls.length === 2 && nativeApplyCalls[1] === false,
		'native unchecked apply mode was not preserved');

	/* Reset discards only unsaved DOM edits and restores the current staged
	 * values. The active profile remains the backend's Fast/8 pair. */
	elements['vp-enabled'].checked = false;
	elements['vp-media-path'].value = '/dirty/path';
	elements['vp-allow-remote'].checked = false;
	elements['vp-render-mode'].value = 'browser';
	profileControl.value = 'fast';
	fpsControl.value = '5';
	elements['vp-router-max-threads'].checked = false;
	await app.handleReset();
	check(elements['vp-enabled'].checked === true &&
		elements['vp-media-path'].value === '/mnt/video' &&
		elements['vp-allow-remote'].checked === true &&
		elements['vp-render-mode'].value === 'router' &&
		profileControl.value === 'quality' && fpsControl.value === '60' &&
		elements['vp-router-max-threads'].checked === true &&
		app._routerProfile === activeSettings.router_profile &&
		app._routerFps === Number(activeSettings.router_fps) &&
		app._routerMaxThreads === false,
		'native Reset did not restore staged controls without changing runtime');

	/* Validation and save failures must never fall through into Apply. */
	const appliesBeforeInvalid = nativeApplyCalls.length;
	const savesBeforeInvalid = uciSaveCalls;
	elements['vp-media-path'].value = 'relative/path';
	check(await app.handleSaveApply(null, '0') !== true &&
		nativeApplyCalls.length === appliesBeforeInvalid &&
		uciSaveCalls === savesBeforeInvalid,
		'invalid native Save & Apply still staged or applied settings');
	elements['vp-media-path'].value = '/mnt/video';
	uci.save = () => {
		uciSaveCalls++;
		return Promise.reject(new Error('expected native save failure'));
	};
	check(await app.handleSaveApply(null, '0') === false &&
		nativeApplyCalls.length === appliesBeforeInvalid,
		'failed native Save still launched Apply');
	app._canWriteSettings = false;
	check(await app.handleSaveApply(null, '0') !== true &&
		nativeApplyCalls.length === appliesBeforeInvalid,
		'read-only native Save & Apply launched Apply');
	app._canWriteSettings = true;

	/* A page reload after Save but before Apply receives staged values through
	 * UCI and active values through get_status. The form must show the former,
	 * while player controls and its runtime clock continue using the latter. */
	Object.assign(stagedSettings, {
		enabled: '0',
		media_path: '/mnt/staged',
		allow_remote: '0',
		render_mode: 'browser',
		router_profile: 'quality',
		router_fps: '60',
		router_max_threads: '1'
	});
	Object.assign(activeSettings, {
		enabled: '1',
		media_path: '/mnt/active',
		allow_remote: '1',
		render_mode: 'router',
		router_profile: 'fast',
		router_fps: '8',
		router_max_threads: '0'
	});
	Object.keys(renderedElements).forEach(key => delete renderedElements[key]);
	const originalWindowSetTimeoutForRender = window.setTimeout;
	const originalWindowAddEventListener = window.addEventListener;
	const originalWindowRemoveEventListener = window.removeEventListener;
	const originalDocumentAddEventListener = document.addEventListener;
	const originalDocumentRemoveEventListener = document.removeEventListener;
	const originalDetachForRender = app._detachCpuSession;
	const originalStopBestEffortForRender = app._stopRendererBestEffort;
	const originalClearVideoForRender = app._clearVideoElement;
	window.setTimeout = () => 0;
	window.addEventListener = () => {};
	window.removeEventListener = () => {};
	document.addEventListener = () => {};
	document.removeEventListener = () => {};
	app._detachCpuSession = () => null;
	app._stopRendererBestEffort = () => {};
	app._clearVideoElement = () => {};
	app.render([ null, {
		status: Object.assign({
			renderer_available: 1,
			media_path_valid: 1,
			media_path_exists: 1,
			media_path_readable: 1
		}, activeSettings),
		error: null
	} ]);
	const selectedSetting = id => {
		const control = renderedElements[id];
		const option = control && Array.isArray(control.children)
			? control.children.find(child => child && child.attrs && child.attrs.selected)
			: null;
		return option && option.attrs.value;
	};
	check(renderedElements['vp-enabled'].attrs.checked == null &&
		renderedElements['vp-media-path'].attrs.value === '/mnt/staged' &&
		renderedElements['vp-allow-remote'].attrs.checked == null &&
		selectedSetting('vp-render-mode') === 'browser' &&
		selectedSetting('vp-router-profile') === 'quality' &&
		selectedSetting('vp-router-fps') === '60' &&
		renderedElements['vp-router-max-threads'].attrs.checked === 'checked',
		'native settings form did not render staged UCI values');
	check(app._localEnabled === true && app._allowRemote === true &&
		app._renderMode === 'router' && app._routerProfile === 'fast' &&
		app._routerFps === 8 && app._routerMaxThreads === false &&
		app._status.media_path === '/mnt/active' &&
		renderedElements['videoplayer-remote-url'].attrs.disabled === 'disabled' &&
		renderedElements['vp-play-remote-btn'].attrs.disabled === 'disabled' &&
		renderedElements['vp-root-btn'].attrs.disabled == null,
		'staged UCI values changed active player state before Apply');
	check(renderedElements['vp-router-max-threads'].attrs['aria-describedby'] ===
			'vp-router-max-threads-desc vp-router-max-threads-warning' &&
		renderedElements['vp-router-max-threads-warning'].attrs.class ===
			'cbi-value-description alert-message warning' &&
		renderedElements['vp-router-max-threads-warning'].attrs.role === 'note' &&
		String(renderedElements['vp-router-max-threads-warning'].children)
			.includes('router may become unstable') &&
		String(renderedElements['vp-router-max-threads-warning'].children)
			.includes('internet access may be interrupted'),
		'maximum-resource warning or accessibility linkage is incomplete');
	window.setTimeout = originalWindowSetTimeoutForRender;
	window.addEventListener = originalWindowAddEventListener;
	window.removeEventListener = originalWindowRemoveEventListener;
	document.addEventListener = originalDocumentAddEventListener;
	document.removeEventListener = originalDocumentRemoveEventListener;
	app._detachCpuSession = originalDetachForRender;
	app._stopRendererBestEffort = originalStopBestEffortForRender;
	app._clearVideoElement = originalClearVideoForRender;

	check(!source.includes('vp-save-settings') &&
		!source.includes('handleSaveSettings') &&
		!source.includes('uci.apply()') &&
		!source.includes("class: 'cbi-page-actions'") &&
		typeof app.handleSave === 'function' &&
		typeof app.handleSaveApply === 'function' &&
		typeof app.handleReset === 'function',
		'custom save UI remains or native LuCI handlers are incomplete');
	uci.get = originalUciGet;
	uci.set = originalUciSet;
	uci.save = originalUciSave;
	uci.apply = originalUciApply;
	ui.changes.apply = originalChangesApply;
	app._clearFieldError = originalClearFieldForProfile;
	app.handleStop = originalHandleStopForProfile;
	delete elements['vp-enabled'];
	delete elements['vp-media-path'];
	delete elements['vp-allow-remote'];
	delete elements['vp-render-mode'];
	delete elements['vp-router-profile'];
	delete elements['vp-router-fps'];
	delete elements['vp-router-max-threads'];

	process.stdout.write('web-audio-test: ok\n');
}

main().catch(error => {
	process.stderr.write(`${error.stack || error}\n`);
	process.exit(1);
});
