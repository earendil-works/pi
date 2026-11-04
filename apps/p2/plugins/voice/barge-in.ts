// Talking over the agent (ported from badlogic/pibot src/client/barge-in.ts at 2ef6b69, kept as it is there; only
// the phase type and the class syntax are adapted, and the resampler keeps its state across frames). A trigger only
// streams the speaker to the room; whether it interrupts is interruption.ts's decision. While the agent works or speaks, the microphone is buffered rather
// than streamed; the speaker interrupts when enough frames in a row hold energy that the played audio does not explain
// (its residual after the best-correlated delay of the playback reference). The detector then streams until the phase
// leaves "hearing".

/** The phases the detector tells apart (pibot's robot phases; voice mode maps its own onto them). */
export type BargeInPhase = "inactive" | "listening" | "hearing" | "thinking" | "tool" | "speaking" | "error";

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
	readonly #micThreshold: number;
	readonly #residualThreshold: number;
	readonly #triggerFrames: number;

	constructor(targetSampleRate: number, micThreshold = 0.018, residualThreshold = 0.62, triggerFrames = 5) {
		this.#micBufferRing = new Int16Array(targetSampleRate);
		this.#micThreshold = micThreshold;
		this.#residualThreshold = residualThreshold;
		this.#triggerFrames = triggerFrames;
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
		if (!this.#shouldBufferForBargeIn(phase) || this.#streaming) return { triggered: false };
		const rms = this.#micRms(input);
		const ratio = phase === "tool" && !ttsSpeaking ? 1 : this.#bargeResidualRatio(input, sampleRate);
		const triggered = rms >= this.#micThreshold && ratio >= this.#residualThreshold;
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
