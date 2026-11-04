// Speech output (ported from badlogic/pibot src/client/tools/speech.ts at 2ef6b69: its PCM stream). One stream per
// spoken answer: PCM chunks are scheduled back to back on the playback AudioContext after a 0.4 s prebuffer, through
// pibot's voice chain (high-pass 150 Hz, low-pass 7.2 kHz, +3.5 dB presence at 2.6 kHz, a compressor, gain 0.98) to the
// output. The chain's output also feeds the barge-in reference (a script processor through a muted gain) and an
// analyser for the orb's level. When the stream ends or is cancelled the microphone stays blocked for 500 ms (the
// room's echo); a barge-in unblocks it at once.
//
// Adapted: the AudioContext is this object's (created on first use, as pibot's), callbacks replace pibot's face and
// RPC plumbing, finished audio may be pushed as an AudioBuffer too, and a watchdog ends a stream whose audio clock
// stalled (a suspended context never ends its sources), and an underrun re-buffers (pibot scheduled every later chunk
// 20 ms ahead, so one late chunk made the rest of the answer choppy). Voice rooms add the other people's microphones:
// each plays on its own schedule (16 kHz chunks, a jitter buffer that grows with each underrun), and the barge-in
// reference is one bus that hears both Pi and the people (pibot's tap moved from the stream to that bus), so voices
// from the speaker are not taken for yours.

const pcmInitialPrebufferSeconds = 0.4;
/** How far ahead a person's audio is scheduled when its stream starts: room relay jitter. */
const humanPrebufferSeconds = 0.15;
/** Each underrun of a person's audio adds this much delay, up to the most: a jittery link settles on enough. */
const humanPrebufferStepSeconds = 0.1;
const humanPrebufferMaxSeconds = 0.6;
const pcmScheduleLeadSeconds = 0.02;
/**
 * After an underrun of the agent's speech, the next chunk is scheduled this far ahead (more with each underrun, up to
 * the most), so the chunks after it join without gaps instead of each arriving just too late.
 */
const pcmRebufferSeconds = 0.15;
const pcmRebufferStepSeconds = 0.1;
const pcmRebufferMaxSeconds = 0.5;
/** A stream not finished this long after its last scheduled audio is taken as finished. */
const WATCHDOG_SLACK_MS = 2000;

export type PlaybackDeps = {
	log: (message: string) => void;
	setMicInputBlockedUntil: (time: number) => void;
	onSpeakingChange: (speaking: boolean) => void;
	onPlaybackAudio: (samples: Float32Array, sampleRate: number) => void;
	/** The output's loudness 0..1, smoothed (pibot's face amplitude). */
	onLevel: (level: number) => void;
	/** The watchdog ended a stream whose context does not run. */
	onStalled: (context: AudioContext) => void;
	/** The playback context changed state (also called once when it is created). */
	onContextState: (context: AudioContext) => void;
};

interface ActivePcmStream {
	generation: number;
	sampleRate: number;
	nextPlayTime: number | undefined;
	pendingSources: number;
	doneRequested: boolean;
	finishResolve: (() => void) | undefined;
	nodes: AudioNode[];
	cleanup: () => void;
	lastChunkWallTime: number | undefined;
	underruns: number;
	chunks: number;
	watchdog: ReturnType<typeof setTimeout> | undefined;
}

export class SpeechPlayback {
	readonly #deps: PlaybackDeps;
	#audioContext: AudioContext | undefined;
	#ttsGeneration = 0;
	#activePcmStream: ActivePcmStream | undefined;
	/** What plays into the barge-in reference (Pi and people); created with the context. */
	#reference: AudioNode | undefined;
	/** People's audio: their bus, and when each one's next chunk starts (on the context's clock). */
	#humans: { bus: GainNode; next: Map<string, number>; delay: Map<string, number> } | undefined;

	constructor(deps: PlaybackDeps) {
		this.#deps = deps;
	}

	/** The playback context, created on first use. */
	context(): AudioContext {
		if (this.#audioContext) return this.#audioContext;
		const context = new AudioContext();
		this.#audioContext = context;
		context.onstatechange = () => this.#deps.onContextState(context);
		// pibot's playback tap, on a bus every played sound reaches.
		const reference = context.createGain();
		const referenceTap = context.createScriptProcessor(1024, 1, 1);
		const silentReference = context.createGain();
		silentReference.gain.value = 0;
		referenceTap.onaudioprocess = (event) => {
			const input = event.inputBuffer.getChannelData(0);
			this.#deps.onPlaybackAudio(input, event.inputBuffer.sampleRate);
		};
		reference.connect(referenceTap);
		referenceTap.connect(silentReference);
		silentReference.connect(context.destination);
		this.#reference = reference;
		this.#deps.onContextState(context);
		return context;
	}

	/** The playback context if it exists (for diagnostics and resuming). */
	get existingContext(): AudioContext | undefined {
		return this.#audioContext;
	}

	/** A stream is open: speech is scheduled or more is expected (pibot's `ttsSpeaking`). */
	get speaking(): boolean {
		return this.#activePcmStream !== undefined;
	}

	#startFaceAmpLoop(analyser: AnalyserNode): () => void {
		const data = new Uint8Array(analyser.fftSize);
		let smoothed = 0;
		let frameHandle = 0;
		let stopped = false;
		const tick = () => {
			if (stopped) return;
			analyser.getByteTimeDomainData(data);
			let sum = 0;
			for (const sample of data) {
				const centered = (sample - 128) / 128;
				sum += centered * centered;
			}
			const rms = Math.sqrt(sum / data.length);
			const amp = Math.min(1, rms * 3.4);
			smoothed = smoothed * 0.55 + amp * 0.45;
			this.#deps.onLevel(smoothed);
			frameHandle = requestAnimationFrame(tick);
		};
		frameHandle = requestAnimationFrame(tick);
		return () => {
			stopped = true;
			cancelAnimationFrame(frameHandle);
			this.#deps.onLevel(0);
		};
	}

	#clearActivePcmStream(resolveFinished: boolean): void {
		const stream = this.#activePcmStream;
		this.#activePcmStream = undefined;
		if (!stream) return;
		clearTimeout(stream.watchdog);
		stream.cleanup();
		for (const node of stream.nodes) node.disconnect();
		if (resolveFinished) stream.finishResolve?.();
	}

	#maybeFinishPcmStream(stream: ActivePcmStream): void {
		if (this.#activePcmStream !== stream || !stream.doneRequested || stream.pendingSources > 0) return;
		this.#clearActivePcmStream(true);
		this.#deps.onSpeakingChange(false);
		this.#deps.setMicInputBlockedUntil(Date.now() + 500);
		this.#deps.log(`PCM stream finished (${stream.chunks} chunks, ${stream.underruns} underruns)`);
	}

	#interruptTtsOnly(resolvePcmFinished = true): void {
		this.#ttsGeneration++;
		this.#clearActivePcmStream(resolvePcmFinished);
	}

	cancelSpeech(reason: string): void {
		const was = this.speaking;
		this.#interruptTtsOnly();
		this.#deps.onSpeakingChange(false);
		this.#deps.setMicInputBlockedUntil(Date.now() + 500);
		if (was) this.#deps.log(`TTS cancelled: ${reason}`);
	}

	cancelSpeechForBargeIn(): void {
		this.#interruptTtsOnly(false);
		this.#deps.onSpeakingChange(false);
		this.#deps.setMicInputBlockedUntil(0);
		this.#deps.log("TTS cancelled: barge-in");
	}

	startPcmStream(sampleRate: number): void {
		this.#interruptTtsOnly();
		const context = this.context();
		void context.resume();
		const highpass = context.createBiquadFilter();
		highpass.type = "highpass";
		highpass.frequency.value = 150;
		const lowpass = context.createBiquadFilter();
		lowpass.type = "lowpass";
		lowpass.frequency.value = 7200;
		const presence = context.createBiquadFilter();
		presence.type = "peaking";
		presence.frequency.value = 2600;
		presence.Q.value = 0.9;
		presence.gain.value = 3.5;
		const compressor = context.createDynamicsCompressor();
		compressor.threshold.value = -24;
		compressor.knee.value = 18;
		compressor.ratio.value = 3;
		compressor.attack.value = 0.006;
		compressor.release.value = 0.12;
		const output = context.createGain();
		output.gain.value = 0.98;
		const analyser = context.createAnalyser();
		analyser.fftSize = 512;
		analyser.smoothingTimeConstant = 0.55;
		highpass.connect(lowpass);
		lowpass.connect(presence);
		presence.connect(compressor);
		compressor.connect(output);
		output.connect(context.destination);
		if (this.#reference) output.connect(this.#reference);
		output.connect(analyser);
		this.#activePcmStream = {
			generation: ++this.#ttsGeneration,
			sampleRate,
			nextPlayTime: undefined,
			pendingSources: 0,
			doneRequested: false,
			finishResolve: undefined,
			nodes: [highpass, lowpass, presence, compressor, output, analyser],
			cleanup: this.#startFaceAmpLoop(analyser),
			lastChunkWallTime: undefined,
			underruns: 0,
			chunks: 0,
			watchdog: undefined,
		};
		this.#deps.onSpeakingChange(true);
		this.#deps.setMicInputBlockedUntil(0);
		this.#deps.log(
			`PCM stream started sampleRate=${sampleRate} prebufferMs=${pcmInitialPrebufferSeconds * 1000} context ${context.state} ${context.sampleRate} Hz`,
		);
	}

	/** PCM16LE mono; `sampleRate` defaults to the stream's (a later sentence may come from another engine). */
	pushPcmAudio(pcm: Uint8Array, sampleRate?: number): void {
		const stream = this.#activePcmStream;
		const audioContext = this.#audioContext;
		if (!stream || !audioContext || pcm.byteLength < 2) return;
		const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
		const sampleCount = Math.floor(pcm.byteLength / 2);
		const audioBuffer = audioContext.createBuffer(1, sampleCount, sampleRate ?? stream.sampleRate);
		const channel = audioBuffer.getChannelData(0);
		for (let index = 0; index < sampleCount; index++) channel[index] = view.getInt16(index * 2, true) / 32768;
		this.pushAudioBuffer(audioBuffer, pcm.byteLength);
	}

	/** Schedules decoded audio on the open stream (pibot's chunk scheduling, shared by `pushPcmAudio`). */
	pushAudioBuffer(audioBuffer: AudioBuffer, bytes = audioBuffer.length * 2): void {
		const stream = this.#activePcmStream;
		const audioContext = this.#audioContext;
		if (!stream || !audioContext) return;
		// More audio after the end was asked for: the stream goes on (the next sentence arrived in time).
		stream.doneRequested = false;
		const now = performance.now();
		stream.chunks++;
		const arrivalGapMs = stream.lastChunkWallTime === undefined ? 0 : now - stream.lastChunkWallTime;
		stream.lastChunkWallTime = now;
		if (stream.nextPlayTime === undefined)
			stream.nextPlayTime = audioContext.currentTime + pcmInitialPrebufferSeconds;
		const queuedMs = (stream.nextPlayTime - audioContext.currentTime) * 1000;
		if (stream.chunks === 1 || queuedMs < 50 || arrivalGapMs > 250) {
			this.#deps.log(
				`PCM chunk #${stream.chunks} bytes=${bytes} durationMs=${(audioBuffer.duration * 1000).toFixed(1)} queuedMs=${queuedMs.toFixed(1)} arrivalGapMs=${arrivalGapMs.toFixed(1)} pending=${stream.pendingSources}`,
			);
		}
		const source = audioContext.createBufferSource();
		source.buffer = audioBuffer;
		source.connect(stream.nodes[0] ?? audioContext.destination);
		stream.pendingSources++;
		source.onended = () => {
			source.disconnect();
			stream.pendingSources--;
			this.#maybeFinishPcmStream(stream);
		};
		const underrunMs = (audioContext.currentTime + pcmScheduleLeadSeconds - stream.nextPlayTime) * 1000;
		let startAt = stream.nextPlayTime;
		if (underrunMs > 0) {
			stream.underruns++;
			const rebuffer = Math.min(
				pcmRebufferMaxSeconds,
				pcmRebufferSeconds + (stream.underruns - 1) * pcmRebufferStepSeconds,
			);
			startAt = audioContext.currentTime + rebuffer;
			this.#deps.log(
				`PCM underrun #${stream.underruns}: lateByMs=${underrunMs.toFixed(1)} chunk=${stream.chunks} arrivalGapMs=${arrivalGapMs.toFixed(1)} rebufferMs=${Math.round(rebuffer * 1000)}`,
			);
		}
		source.start(startAt);
		stream.nextPlayTime = startAt + audioBuffer.duration;
		this.#armWatchdog(stream, audioContext);
	}

	async finishPcmStream(): Promise<void> {
		const stream = this.#activePcmStream;
		if (!stream) return;
		stream.doneRequested = true;
		if (stream.pendingSources === 0) {
			this.#maybeFinishPcmStream(stream);
			return;
		}
		await new Promise<void>((resolve) => {
			stream.finishResolve = resolve;
		});
	}

	failPcmStream(message: string): void {
		this.#clearActivePcmStream(true);
		this.#deps.onSpeakingChange(false);
		this.#deps.setMicInputBlockedUntil(Date.now() + 500);
		this.#deps.log(`PCM stream failed: ${message}`);
	}

	/** A person's microphone audio from the room (PCM16LE mono at `sampleRate`), played on that person's schedule. */
	pushHumanAudio(participant: string, pcm: Uint8Array, sampleRate: number): void {
		if (pcm.byteLength < 2) return;
		const context = this.context();
		void context.resume();
		if (!this.#humans) {
			const bus = context.createGain();
			bus.connect(context.destination);
			if (this.#reference) bus.connect(this.#reference);
			this.#humans = { bus, next: new Map(), delay: new Map() };
		}
		const { bus, next, delay } = this.#humans;
		const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
		const count = Math.floor(pcm.byteLength / 2);
		const buffer = context.createBuffer(1, count, sampleRate);
		const channel = buffer.getChannelData(0);
		for (let index = 0; index < count; index++) channel[index] = view.getInt16(index * 2, true) / 32768;
		const source = context.createBufferSource();
		source.buffer = buffer;
		source.connect(bus);
		source.onended = () => source.disconnect();
		// Behind (a gap, or the first chunk): start again a little ahead, so the next chunks join without gaps. A gap
		// while the person talks on (an underrun, not a pause) makes the buffer larger for the rest of the room.
		let startAt = next.get(participant);
		if (startAt === undefined || startAt < context.currentTime + pcmScheduleLeadSeconds) {
			const late = startAt === undefined ? 0 : context.currentTime - startAt;
			let ahead = delay.get(participant) ?? humanPrebufferSeconds;
			if (late > 0 && late < 1 && ahead < humanPrebufferMaxSeconds) {
				ahead = Math.min(humanPrebufferMaxSeconds, ahead + humanPrebufferStepSeconds);
				this.#deps.log(`voice ${participant}: underrun, delay now ${Math.round(ahead * 1000)} ms`);
			}
			delay.set(participant, ahead);
			startAt = context.currentTime + ahead;
		}
		source.start(startAt);
		next.set(participant, startAt + buffer.duration);
	}

	/** Ends everything and closes the context (voice mode off). */
	close(): void {
		this.#interruptTtsOnly();
		this.#reference = undefined;
		this.#humans = undefined;
		if (this.#audioContext) this.#audioContext.onstatechange = null;
		void this.#audioContext?.close().catch(() => {});
		this.#audioContext = undefined;
	}

	/** Ends the stream when its scheduled audio should long have played out (re-armed by every chunk). */
	#armWatchdog(stream: ActivePcmStream, context: AudioContext): void {
		clearTimeout(stream.watchdog);
		const remainingMs = Math.max(0, ((stream.nextPlayTime ?? context.currentTime) - context.currentTime) * 1000);
		stream.watchdog = setTimeout(() => {
			if (this.#activePcmStream !== stream || stream.pendingSources === 0) return;
			this.#deps.log(
				`PCM stream watchdog: ${stream.pendingSources} chunks never ended, context ${context.state} at ${context.currentTime.toFixed(2)} s`,
			);
			this.#clearActivePcmStream(true);
			this.#deps.onSpeakingChange(false);
			this.#deps.setMicInputBlockedUntil(Date.now() + 500);
			if (context.state !== "running") this.#deps.onStalled(context);
		}, remainingMs + WATCHDOG_SLACK_MS);
	}
}
