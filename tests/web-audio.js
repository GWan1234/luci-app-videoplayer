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
global.document = {
	hidden: false,
	getElementById: id => elements[id] || null,
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

	/* Short video EOF can race resolve_audio, a pending play() promise, or a
	 * delayed first JPEG. Keep each phase alive for the bounded drain window
	 * instead of destroying its hidden audio or queued frame immediately. */
	const pendingEofCases = [
		{ name: 'resolving', generation: 51, token: '5', audio: true },
		{ name: 'playPending', generation: 52, token: '6', audio: true },
		{ name: 'waitingForVideo', generation: 53, token: '7', audio: true },
		{ name: 'queuedFrame', generation: 54, token: '8', audio: false }
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
			timer: null,
			decodeTimer: null,
			cancelDecode: null,
			decoder: null,
			nextObjectUrl: null,
			objectUrl: null,
			pendingFrames: pendingPhase === 'queuedFrame'
				? [ { url: 'blob:queued-short-frame', timer: null } ]
				: [],
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
		if (pendingPhase === 'queuedFrame') {
			check(
				pendingEofSession.pendingFrames.length === 1,
				'video EOF discarded the delayed final JPEG'
			);
		}
		await app._finishCpuPlayback(
			pendingEofSession, `finished-${pendingPhase}`, false, true
		);
		check(
			app._cpuSession === null,
			`forced ${pendingPhase} drain retained the session`
		);
	}

	/* When router PCM is unavailable, keep CPU-rendered frames but resolve the
	 * original protected stream into a hidden browser audio element. A delayed
	 * audible play may be blocked, so muted playback starts the clock and the
	 * visible Unmute button supplies the next user gesture. */
	const browserElement = fakeMediaElement([
		new Error('NotAllowedError'),
		null,
		null
	]);
	const browserButton = fakeButton();
	const browserNote = { textContent: '', hidden: false };
	const browserNowPlaying = { textContent: '' };
	const browserFrame = {
		src: '',
		hidden: true,
		setAttribute() {},
		removeAttribute(name) {
			if (name === 'src')
				this.src = '';
		}
	};
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
	rpcCalls.length = 0;
	const previousFrameScheduler = app._scheduleCpuFramePoll;
	app._scheduleCpuFramePoll = () => {};
	app._playGeneration = 6;
	await app._playCpuFrames({
		session_token: 'b'.repeat(32),
		stream_url: '/cgi-bin/videoplayer-frame?token=' + 'b'.repeat(32),
		has_audio: 0,
		router_fps: 30,
		frame_interval_ms: 33
	}, 'bad apple.mp4', 6, null);
	app._scheduleCpuFramePoll = previousFrameScheduler;

	const browserSession = app._cpuSession;
	const browserAudio = browserSession && browserSession.browserAudio;
	check(browserSession && browserSession.active, 'CPU session was not retained');
	check(browserSession.fps === 30, '30 FPS was normalized to another frame rate');
	check(browserSession.frameIntervalMs === 33,
		'30 FPS was normalized to another polling interval');
	check(browserAudio && browserAudio.active, 'browser audio fallback was not attached');
	check(browserAudio.waitingForVideo,
		'browser audio started before the first CPU-rendered frame');
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
	app._presentCpuFrame(browserSession, 'blob:first-frame');
	await browserAudio.playPromise;
	check(browserSession.firstFrameSeen && browserSession.firstFrameAt,
		'first frame did not establish the audio clock');
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
