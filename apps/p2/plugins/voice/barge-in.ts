// Talking over the agent (ported from badlogic/pibot src/client/barge-in.ts at 2ef6b69; the phase type and the class
// syntax are adapted, the resampler keeps its state across frames, and the level is relative to the microphone's own
// noise floor instead of pibot's fixed 0.018). A trigger only streams the speaker to the room; whether it interrupts is
// interruption.ts's decision. While the agent works or speaks, the microphone is buffered rather than streamed; the
// speaker interrupts when enough frames in a row are loud enough and hold energy that the played audio does not explain
// (its residual after the best-correlated delay of the playback reference). The detector then streams until the phase
// leaves "hearing".
//
// Loud enough: a frame's RMS at least MARGIN times the noise floor (about +11 dB), never below MIN_LEVEL (silence and
// faint hiss never count) and never above pibot's 0.018 (no stricter than before). Without automatic gain control a
// laptop's built-in microphone hears a speaker at arm's length at about 0.005: under pibot's fixed level, so only a
// voice right at the keyboard interrupted. The floor follows every frame: down quickly (a pause), up slowly (steady
// noise, a fan), so a few seconds of speech hardly move it. Automatic gain control is no alternative: it pumps while
// the agent's speech plays.

/** The phases the detector tells apart (pibot's robot phases; voice mode maps its own onto them). */
export type BargeInPhase = "inactive" | "listening" | "hearing" | "thinking" | "tool" | "speaking" | "error";

/** A frame's RMS must reach this many times the noise floor to count as speech. */
export const MARGIN = 3.5;
/** The lowest RMS that ever counts as speech, however quiet the floor. */
export const MIN_LEVEL = 0.003;
/** The highest level ever required: pibot's fixed one. */
export const MAX_LEVEL = 0.018;
/** How fast the floor follows a quieter frame, and a louder one (time constants, seconds). */
const FLOOR_FALL_S = 0.3;
const FLOOR_RISE_S = 8;

/** The level a frame must reach over a noise floor of `floor` (see the header). */
export const speechLevel = (floor: number): number => Math.min(MAX_LEVEL, Math.max(MIN_LEVEL, floor * MARGIN));

/** What the microphone heard over some frames, for the voice log: while the agent's speech played, or not. */
export type MicLevels = {
	readonly playing: boolean;
	readonly frames: number;
	readonly peakRms: number;
	readonly meanRms: number;
	/** The noise floor and the level required, at the end of the window. */
	readonly floor: number;
	readonly level: number;
	/** The residual ratio of the loudest frame, and the highest one (frames buffered for barge-in only). */
	readonly residualAtPeak?: number;
	readonly maxResidual?: number;
	/** Frames that passed both checks. */
	readonly candidates: number;
};

/** A window of `MicLevels` being collected. */
type LevelWindow = {
	frames: number;
	peakRms: number;
	energy: number;
	residualAtPeak?: number;
	maxResidual?: number;
	candidates: number;
};

export interface BargeInResult {
	triggered: boolean;
	preroll?: Int16Array;
	metrics?: {
		micRms: number;
		residualRatio: number;
	};
}

export class BargeInDetector {
	#streaming = false;
	#consecutiveFrames = 0;
	#playbackReferenceSampleRate = 0;
	#playbackReferenceWrite = 0;
	#playbackReferenceSamples = 0;
	#playbackReferenceRing = new Float32Array(48000 * 8);
	#micBufferWrite = 0;
	#micBufferSamples = 0;
	readonly #micBufferRing: Int16Array;
	readonly #residualThreshold: number;
	readonly #triggerFrames: number;
	/** The microphone's noise floor (frame RMS); undefined before the first frame. */
	#floor: number | undefined;
	/** The levels since the last `takeLevels`, while the agent's speech played and while it did not. */
	readonly #windows = new Map<boolean, LevelWindow>();

	constructor(targetSampleRate: number, residualThreshold = 0.62, triggerFrames = 5) {
		this.#micBufferRing = new Int16Array(targetSampleRate);
		this.#residualThreshold = residualThreshold;
		this.#triggerFrames = triggerFrames;
	}

	/** The noise floor now (0 before any frame). */
	get floor(): number {
		return this.#floor ?? 0;
	}

	/** The levels heard since the last call (at most one window while playing and one while not), then cleared. */
	takeLevels(): MicLevels[] {
		const floor = this.floor;
		const taken = [...this.#windows].map(
			([playing, window]): MicLevels => ({
				playing,
				frames: window.frames,
				peakRms: window.peakRms,
				meanRms: Math.sqrt(window.energy / window.frames),
				floor,
				level: speechLevel(floor),
				...(window.residualAtPeak === undefined ? {} : { residualAtPeak: window.residualAtPeak }),
				...(window.maxResidual === undefined ? {} : { maxResidual: window.maxResidual }),
				candidates: window.candidates,
			}),
		);
		this.#windows.clear();
		return taken;
	}

	resetStreaming(): void {
		// What the stream sent is not sent again as the next trigger's preroll (repeated triggers on noise would
		// otherwise send more than real time, which the room drops and finally closes the socket for).
		if (this.#streaming) this.#micBufferSamples = 0;
		this.#streaming = false;
		this.#consecutiveFrames = 0;
	}

	isStreaming(): boolean {
		return this.#streaming;
	}

	handlePlaybackAudio(samples: Float32Array, sampleRate: number): void {
		if (this.#playbackReferenceSampleRate !== sampleRate) {
			this.#playbackReferenceSampleRate = sampleRate;
			this.#playbackReferenceRing = new Float32Array(sampleRate * 8);
			this.#playbackReferenceWrite = 0;
			this.#playbackReferenceSamples = 0;
		}
		for (const sample of samples) {
			this.#playbackReferenceRing[this.#playbackReferenceWrite] = sample;
			this.#playbackReferenceWrite = (this.#playbackReferenceWrite + 1) % this.#playbackReferenceRing.length;
			this.#playbackReferenceSamples += 1;
		}
	}

	observeMic(
		input: Float32Array,
		sampleRate: number,
		pcm: Int16Array,
		phase: BargeInPhase,
		ttsSpeaking: boolean,
	): BargeInResult {
		this.#appendMicBuffer(pcm);
		const rms = this.#micRms(input);
		// The level against the floor before this frame: a frame of speech does not raise its own bar.
		const level = speechLevel(this.#floor ?? rms);
		this.#follow(rms, input.length / sampleRate);
		const buffering = this.#shouldBufferForBargeIn(phase) && !this.#streaming;
		const ratio = !buffering
			? undefined
			: phase === "tool" && !ttsSpeaking
				? 1
				: this.#bargeResidualRatio(input, sampleRate);
		const triggered = ratio !== undefined && rms >= level && ratio >= this.#residualThreshold;
		this.#record(ttsSpeaking, rms, ratio, triggered);
		if (ratio === undefined) return { triggered: false };
		this.#consecutiveFrames = triggered ? this.#consecutiveFrames + 1 : Math.max(0, this.#consecutiveFrames - 1);
		if (this.#consecutiveFrames < this.#triggerFrames) return { triggered: false };
		this.#streaming = true;
		this.#consecutiveFrames = 0;
		return { triggered: true, preroll: this.#bufferedMicPcm(), metrics: { micRms: rms, residualRatio: ratio } };
	}

	shouldStreamMicNormally(phase: BargeInPhase): boolean {
		return phase === "listening" || phase === "hearing";
	}

	#shouldBufferForBargeIn(phase: BargeInPhase): boolean {
		return phase === "thinking" || phase === "tool" || phase === "speaking";
	}

	#appendMicBuffer(pcm: Int16Array): void {
		for (const sample of pcm) {
			this.#micBufferRing[this.#micBufferWrite] = sample;
			this.#micBufferWrite = (this.#micBufferWrite + 1) % this.#micBufferRing.length;
			this.#micBufferSamples = Math.min(this.#micBufferSamples + 1, this.#micBufferRing.length);
		}
	}

	#bufferedMicPcm(): Int16Array {
		const output = new Int16Array(this.#micBufferSamples);
		const start =
			(this.#micBufferWrite - this.#micBufferSamples + this.#micBufferRing.length) % this.#micBufferRing.length;
		for (let index = 0; index < this.#micBufferSamples; index++) {
			output[index] = this.#micBufferRing[(start + index) % this.#micBufferRing.length] ?? 0;
		}
		return output;
	}

	/** The floor follows a frame of `rms` lasting `seconds`: down fast, up slowly. */
	#follow(rms: number, seconds: number): void {
		if (this.#floor === undefined) {
			this.#floor = rms;
			return;
		}
		const tau = rms < this.#floor ? FLOOR_FALL_S : FLOOR_RISE_S;
		this.#floor += (rms - this.#floor) * (1 - Math.exp(-seconds / tau));
	}

	#record(playing: boolean, rms: number, ratio: number | undefined, candidate: boolean): void {
		let window = this.#windows.get(playing);
		if (!window) {
			window = { frames: 0, peakRms: 0, energy: 0, candidates: 0 };
			this.#windows.set(playing, window);
		}
		window.frames += 1;
		window.energy += rms * rms;
		if (candidate) window.candidates += 1;
		if (rms >= window.peakRms) {
			window.peakRms = rms;
			if (ratio !== undefined) window.residualAtPeak = ratio;
		}
		if (ratio !== undefined) window.maxResidual = Math.max(window.maxResidual ?? 0, ratio);
	}

	#micRms(input: Float32Array): number {
		let energy = 0;
		for (const sample of input) energy += sample * sample;
		return Math.sqrt(energy / Math.max(1, input.length));
	}

	#bargeResidualRatio(input: Float32Array, sampleRate: number): number {
		if (this.#playbackReferenceSampleRate !== sampleRate || this.#playbackReferenceSamples < input.length) return 1;
		let micEnergy = 0;
		for (const sample of input) micEnergy += sample * sample;
		micEnergy /= Math.max(1, input.length);
		if (micEnergy < 1e-7) return 0;
		let bestCorrelation = 0;
		let bestRatio = 1;
		for (let delayMs = 20; delayMs <= 420; delayMs += 10) {
			const delaySamples = Math.round((delayMs / 1000) * sampleRate);
			const start = this.#playbackReferenceSamples - delaySamples - input.length;
			let referenceEnergy = 0;
			let dot = 0;
			for (let index = 0; index < input.length; index++) {
				const reference = this.#readPlaybackReference(start + index);
				referenceEnergy += reference * reference;
				dot += (input[index] ?? 0) * reference;
			}
			referenceEnergy /= Math.max(1, input.length);
			dot /= Math.max(1, input.length);
			if (referenceEnergy < 1e-7) continue;
			const correlation = Math.abs(dot) / Math.sqrt(referenceEnergy * micEnergy);
			const explained = (dot * dot) / referenceEnergy;
			const ratio = Math.max(0, micEnergy - explained) / micEnergy;
			if (correlation > bestCorrelation) {
				bestCorrelation = correlation;
				bestRatio = ratio;
			}
		}
		return bestRatio;
	}

	#readPlaybackReference(totalIndex: number): number {
		if (totalIndex < 0 || totalIndex >= this.#playbackReferenceSamples) return 0;
		return this.#playbackReferenceRing[totalIndex % this.#playbackReferenceRing.length] ?? 0;
	}
}

/**
 * Mono float microphone audio as 16 kHz PCM16, frame after frame (pibot's resampleToPcm16, averaging each output
 * sample's span of input). Stateful: the input a frame leaves over, and the fractional position, carry into the next,
 * so no sample is dropped at frame boundaries (resampling each 1024-sample frame on its own lost a third of a sample at
 * 48 kHz and half a sample at 44.1 kHz per frame: a click every 21 ms in what the room hears and relays).
 */
export class Pcm16kResampler {
	#rest = new Float32Array(0);
	/** Where the next output sample starts in the input, past the start of `#rest` (0 <= offset < ratio). */
	#offset = 0;
	#rate = 0;

	/** The 16 kHz PCM16 of `input` (at `rate`) and what the previous frames left over. */
	push(input: Float32Array, rate: number): Int16Array {
		if (rate !== this.#rate) {
			this.reset();
			this.#rate = rate;
		}
		const ratio = rate / 16000;
		const samples = new Float32Array(this.#rest.length + input.length);
		samples.set(this.#rest);
		samples.set(input, this.#rest.length);
		const length = Math.max(0, Math.floor((samples.length - this.#offset) / ratio));
		const output = new Int16Array(length);
		for (let index = 0; index < length; index++) {
			const start = Math.floor(this.#offset + index * ratio);
			const end = Math.min(samples.length, Math.max(start + 1, Math.floor(this.#offset + (index + 1) * ratio)));
			let sum = 0;
			for (let at = start; at < end; at++) sum += samples[at] ?? 0;
			const sample = Math.max(-1, Math.min(1, sum / (end - start)));
			output[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
		}
		const consumed = this.#offset + length * ratio;
		const whole = Math.min(samples.length, Math.floor(consumed));
		this.#offset = consumed - whole;
		this.#rest = samples.slice(whole);
		return output;
	}

	reset(): void {
		this.#rest = new Float32Array(0);
		this.#offset = 0;
	}
}
