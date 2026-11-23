// The voice plugin's barge-in detector (plugins/voice/barge-in.ts, ported from pibot) and the microphone's echo
// canceller choice by output (policy.ts): what counts as the speaker talking over the agent's speech, against the
// microphone's own noise floor and the playback's echo. Apart from voice.test.ts, which loads the browser engine.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BargeInDetector, type BargeInPhase, MAX_LEVEL, MIN_LEVEL, speechLevel } from "../../plugins/voice/barge-in.ts";
import { echoCancellationFor } from "../../plugins/voice/policy.ts";

describe("voice barge-in detector", () => {
	const rate = 16000;
	const frame = 1024;
	const tone = (start: number, length: number) =>
		Float32Array.from({ length }, (_, index) => 0.5 * Math.sin((2 * Math.PI * 300 * (start + index)) / rate));
	let seed = 1;
	const noise = (length: number, amplitude: number) =>
		Float32Array.from({ length }, () => {
			seed = (seed * 16807) % 2147483647;
			return (seed / 2147483647 - 0.5) * 2 * amplitude;
		});
	const pcmOf = (input: Float32Array) => Int16Array.from(input, (sample) => Math.round(sample * 0x7fff));
	/** Plays `seconds` of the tone into the reference; returns how many samples played. */
	const playing = (detector: BargeInDetector, seconds: number) => {
		for (let at = 0; at < seconds * rate; at += frame) detector.handlePlaybackAudio(tone(at, frame), rate);
		return Math.ceil((seconds * rate) / frame) * frame;
	};
	/** Feeds `frames` frames made by `make`; the first triggering result, if any. */
	const feed = (detector: BargeInDetector, frames: number, make: () => Float32Array, phase: BargeInPhase) => {
		for (let index = 0; index < frames; index++) {
			const input = make();
			const result = detector.observeMic(input, rate, pcmOf(input), phase, true);
			if (result.triggered) return result;
		}
		return undefined;
	};

	it("streams normally only while listening or hearing, and buffers for barge-in otherwise", () => {
		const detector = new BargeInDetector(rate);
		assert.equal(detector.shouldStreamMicNormally("listening"), true);
		assert.equal(detector.shouldStreamMicNormally("hearing"), true);
		for (const phase of ["thinking", "tool", "speaking", "inactive", "error"] as const)
			assert.equal(detector.shouldStreamMicNormally(phase), false);
		// A loud voice while listening is never a barge-in (it is streamed anyway).
		assert.equal(
			feed(detector, 20, () => noise(frame, 0.5), "listening"),
			undefined,
		);
	});

	it("takes the playback's own echo for echo while speaking", () => {
		const detector = new BargeInDetector(rate);
		const end = playing(detector, 1);
		// The microphone hears the playback 100 ms late, frame after frame.
		let at = end - 10 * frame - 0.1 * rate;
		assert.equal(
			feed(
				detector,
				10,
				() => {
					const echo = tone(at, frame);
					at += frame;
					return echo;
				},
				"speaking",
			),
			undefined,
		);
	});

	it("interrupts after five frames of sound the playback does not explain, then streams until reset", () => {
		const detector = new BargeInDetector(rate);
		playing(detector, 1);
		const result = feed(detector, 20, () => noise(frame, 0.5), "speaking");
		assert(result?.preroll && result.metrics);
		assert(result.metrics.residualRatio >= 0.62 && result.metrics.micRms >= 0.018);
		// The preroll is the last second of microphone audio (16 kHz).
		assert.equal(result.preroll.length, 5 * frame);
		assert.equal(detector.isStreaming(), true);
		detector.resetStreaming();
		assert.equal(detector.isStreaming(), false);
		// The next trigger's preroll holds only what was not streamed yet (noise triggering again and again must not
		// send more than real time).
		const again = feed(detector, 20, () => noise(frame, 0.5), "speaking");
		assert.equal(again?.preroll?.length, 5 * frame);
	});

	/** Uniform noise of RMS `rms`. */
	const hiss = (rms: number) => noise(frame, rms * Math.sqrt(3));
	/** A voice-like 210 Hz tone of RMS `rms` over hiss at a tenth of it, continuing from sample `at`. */
	const voice = (rms: number) => {
		let at = 0;
		return () => {
			const sound = Float32Array.from(
				{ length: frame },
				(_, index) => rms * Math.SQRT2 * Math.sin((2 * Math.PI * 210 * (at + index)) / rate),
			);
			at += frame;
			const under = hiss(rms / 10);
			return sound.map((sample, index) => sample + (under[index] ?? 0));
		};
	};

	it("hears a quiet microphone over its own noise floor: a voice at 0.006 over a floor of 0.001", () => {
		const detector = new BargeInDetector(rate);
		playing(detector, 1);
		// Two seconds of the room: the floor settles at the microphone's hiss, which never triggers.
		assert.equal(
			feed(detector, 32, () => hiss(0.001), "speaking"),
			undefined,
		);
		assert(Math.abs(detector.floor - 0.001) < 0.0003, `floor ${detector.floor}`);
		assert.equal(speechLevel(detector.floor), Math.max(MIN_LEVEL, detector.floor * 3.5));
		// The speaker at arm's length, far under pibot's fixed 0.018: a barge-in.
		const result = feed(detector, 10, voice(0.006), "speaking");
		assert(result?.metrics, "a quiet voice triggers");
		assert(result.metrics.micRms < MAX_LEVEL);
	});

	it("never triggers on steady noise at the floor, however long, nor on near silence", () => {
		const detector = new BargeInDetector(rate);
		playing(detector, 1);
		assert.equal(
			feed(detector, 300, () => hiss(0.001), "speaking"),
			undefined,
		);
		// Digital near silence: the floor drops to nothing, the absolute minimum holds.
		const silent = new BargeInDetector(rate);
		playing(silent, 1);
		assert.equal(
			feed(silent, 100, () => hiss(0.00005), "speaking"),
			undefined,
		);
		assert.equal(speechLevel(silent.floor), MIN_LEVEL);
		assert.equal(
			feed(silent, 20, () => hiss(0.002), "speaking"),
			undefined,
		);
	});

	it("does not take the playback's echo for a quiet voice: its residual ratio stays low", () => {
		const detector = new BargeInDetector(rate);
		const end = playing(detector, 2);
		assert.equal(
			feed(detector, 16, () => hiss(0.001), "speaking"),
			undefined,
		);
		detector.takeLevels();
		// The agent's speech heard 100 ms late at RMS 0.007 (well over the floor), with the room's hiss under it.
		let at = end - 10 * frame - 0.1 * rate;
		assert.equal(
			feed(
				detector,
				10,
				() => {
					const under = hiss(0.0002);
					const echo = tone(at, frame).map((sample, index) => sample * 0.02 + (under[index] ?? 0));
					at += frame;
					return echo;
				},
				"speaking",
			),
			undefined,
		);
		const [levels] = detector.takeLevels();
		// Every frame was loud enough: only the residual check (the playback explains the frames) kept it from
		// triggering. The search's 10 ms grid explains some frames worse than others, as in pibot.
		assert(levels?.playing && levels.meanRms > levels.level, JSON.stringify(levels));
		assert(levels.candidates < 5, JSON.stringify(levels));
	});

	it("reports raw levels for the voice log, apart while the agent's speech plays and while it does not", () => {
		const detector = new BargeInDetector(rate);
		playing(detector, 1);
		for (let index = 0; index < 4; index++) {
			const input = hiss(0.001);
			detector.observeMic(input, rate, pcmOf(input), "listening", false);
		}
		for (let index = 0; index < 3; index++) {
			const input = hiss(0.004);
			detector.observeMic(input, rate, pcmOf(input), "speaking", true);
		}
		const levels = detector.takeLevels();
		assert.deepEqual(
			levels.map((each) => [each.playing, each.frames, each.residualAtPeak === undefined]),
			[
				[false, 4, true],
				[true, 3, false],
			],
		);
		assert(levels[1]!.peakRms > 0.003 && levels[1]!.peakRms < 0.006);
		assert.deepEqual(detector.takeLevels(), []);
	});

	it("turns the echo canceller off for headphones and earphones, and keeps it on for speakers or unknown outputs", () => {
		const output = (label: string, deviceId = "default") => ({ kind: "audiooutput", deviceId, label });
		assert.equal(
			echoCancellationFor([output("Default - External Headphones"), output("MacBook Pro Speakers", "x")]),
			false,
		);
		assert.equal(echoCancellationFor([output("Default - AirPods Pro")]), false);
		assert.equal(echoCancellationFor([output("Default - MacBook Pro Speakers (Built-in)")]), true);
		// The default is what plays, whatever else is plugged in.
		assert.equal(echoCancellationFor([output("Default - Speakers"), output("External Headphones", "y")]), true);
		// No labels yet (before the microphone was allowed), or no outputs listed: on.
		assert.equal(echoCancellationFor([output("")]), true);
		assert.equal(
			echoCancellationFor([{ kind: "audioinput", deviceId: "default", label: "Headset Microphone" }]),
			true,
		);
	});
});
