// Voice mode (plugins/voice): sentences of streaming Markdown, stop commands, transcripts waiting for the conversation,
// pibot's barge-in detector, room frames, the server's routes and the room bridge to a (fake) speech service (the
// owner's and a read/write guest's, view-only guests refused; engines pushed live as voice.json changes), the
// browser's diagnostics log, the owner's and a guest's switch, and the prompt section the per-conversation switch
// turns on.

import assert from "node:assert/strict";
import { once } from "node:events";
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it, mock } from "node:test";
import type { ConversationView } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT, follow, whenLive } from "@p2/app/v1";
import { WebSocket } from "ws";
import { Chat } from "../../plugins/chat/contract.ts";
import { ChatMode, spokenMention } from "../../plugins/chat-mode/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { Sharing } from "../../plugins/sharing/contract.ts";
import { BargeInDetector, type BargeInPhase, Pcm16kResampler } from "../../plugins/voice/barge-in.ts";
import { languagesOf, resolved } from "../../plugins/voice/choice.ts";
import { VoiceMode, VoiceService } from "../../plugins/voice/contract.ts";
import { responses } from "../../plugins/voice/engine.ts";
import {
	CANDIDATE_START_MS,
	Interruption,
	type InterruptionState,
	isEcho,
	meaningful,
} from "../../plugins/voice/interruption.ts";
import { bargeInPhase } from "../../plugins/voice/policy.ts";
import { parseRoomFrame, roomName } from "../../plugins/voice/protocol.ts";
import { isStopCommand, SpeechChunker, speakable } from "../../plugins/voice/speech-text.ts";
import { PendingTranscripts, type TranscriptTarget, voiceMessage } from "../../plugins/voice/transcripts.ts";
import voiceWorker, { VOICE_PROMPT, voicePrompt } from "../../plugins/voice/worker.ts";
import { chatModeHost } from "./chat-mode-host.ts";
import { ChordError, expectChord, type Fixture, holdIn, http, poll, startFixture, until } from "./helpers.ts";
import { fakeSpeechService, VOICES } from "./voice-service.ts";

describe("voice speech text", () => {
	it("reads streaming Markdown sentence by sentence, without code blocks, tables or syntax", () => {
		const chunker = new SpeechChunker();
		const text =
			"I found it. The bug is in `tx.draft()`, see [the docs](https://x.y/z). Next\n\n```ts\nconst a = 1. b;\n```\n| a | b |\n|---|---|\n- **First** item\n1. Second, e.g. this\n## Done\nRead https://example.com now";
		const said: string[] = [];
		// Fed in growing prefixes, as the answer streams.
		for (let end = 1; end <= text.length; end += 7) said.push(...chunker.push(text.slice(0, end)));
		said.push(...chunker.push(text, true));
		assert.deepEqual(said, [
			"I found it.",
			"The bug is in tx.draft(), see the docs.",
			"Next",
			"First item",
			"Second, e.g. this",
			"Done",
			"Read a link now",
		]);
	});

	it("waits for a sentence to end before reading it, and for a code fence to close", () => {
		const chunker = new SpeechChunker();
		assert.deepEqual(chunker.push("Hello wor"), []);
		assert.deepEqual(chunker.push("Hello world. And"), ["Hello world."]);
		assert.deepEqual(chunker.push("Hello world. And then\n```\ncode. more"), ["And then"]);
		assert.deepEqual(chunker.push("Hello world. And then\n```\ncode. more\n```\nAfter."), []);
		assert.deepEqual(chunker.push("Hello world. And then\n```\ncode. more\n```\nAfter.", true), ["After."]);
		assert.equal(speakable("---"), "");
		assert.equal(speakable("| x |"), "");
	});

	it("recognizes stop commands, not sentences containing stop", () => {
		for (const text of ["Stop.", "stop it", "OK, stop!", "Never mind", "Be quiet."])
			assert(isStopCommand(text), text);
		for (const text of ["Stop the server and restart it.", "Don't stop", "stopwatch"])
			assert(!isStopCommand(text), text);
	});
});

/** A conversation whose sends settle when the test says so, recording what happened in order. */
function fakeTarget() {
	const calls: string[] = [];
	const restore: string[] = [];
	const requests = new Map<string, string>();
	const pending: { resolve: () => void; reject: (error: unknown) => void }[] = [];
	let inFlight = 0;
	let maxInFlight = 0;
	const target: TranscriptTarget = {
		send: (text, requestId) => {
			calls.push(`send ${text}`);
			const known = requests.get(text);
			if (known !== undefined) assert.equal(requestId, known, "a retry keeps its request ID");
			requests.set(text, requestId);
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			return new Promise<void>((resolve, reject) => {
				pending.push({
					resolve: () => {
						inFlight--;
						resolve();
					},
					reject: (error) => {
						inFlight--;
						reject(error);
					},
				});
			});
		},
		stop: async () => {
			calls.push("stop");
			// What the stop withdrew of this person's queued messages (once).
			return { restored: restore.splice(0) };
		},
	};
	/** The next send, once it is asked for. */
	const next = async () => {
		await poll(() => pending.length > 0, 2000, "a send");
		const first = pending.shift();
		assert(first);
		return first;
	};
	return { target, calls, next, restore, maxInFlight: () => maxInFlight };
}

describe("voice transcripts waiting for the conversation", () => {
	const setup = (options: { busy?: boolean; limit?: number } = {}) => {
		const fake = fakeTarget();
		let target: TranscriptTarget | undefined = fake.target;
		const errors: string[] = [];
		const queue = new PendingTranscripts({
			target: () => target,
			busy: () => options.busy ?? false,
			log: () => {},
			onError: (message) => errors.push(message),
			onChange: () => {},
			limit: options.limit,
			retryMs: 60_000,
			slowMs: 60_000,
		});
		const setTarget = (value: TranscriptTarget | undefined) => {
			target = value;
		};
		return { ...fake, queue, errors, setTarget };
	};

	it("sends one at a time in the order spoken, stopping the busy run before each, as the Stop button", async () => {
		const { queue, calls, next, maxInFlight } = setup({ busy: true });
		queue.push("one");
		queue.push("two");
		queue.push("three");
		(await next()).resolve();
		(await next()).resolve();
		(await next()).resolve();
		await queue.flush();
		assert.deepEqual(calls, ["stop", "send one", "stop", "send two", "stop", "send three"]);
		assert.equal(maxInFlight(), 1);
		assert.equal(queue.size, 0);
	});

	it("sends this person's queued messages that a stop withdrew with the new one, not lost", async () => {
		const { queue, calls, next, restore } = setup({ busy: true });
		restore.push("first thought");
		queue.push("second thought");
		(await next()).resolve();
		await queue.flush();
		assert.deepEqual(calls, ["stop", "send first thought\n\nsecond thought"]);
	});

	it("does not stop again when a message is sent again after a link failure", async () => {
		const { queue, calls, next, setTarget, target } = setup({ busy: true });
		queue.push("once");
		(await next()).reject(new ChordError({ code: "unavailable", message: "ping timeout" }));
		setTarget(target);
		const flushed = queue.flush();
		(await next()).resolve();
		await flushed;
		assert.deepEqual(calls, ["stop", "send once", "send once"]);
	});

	it("keeps transcripts while the link is down and sends them once through the new reference", async () => {
		const { queue, calls, next, errors, setTarget, target } = setup();
		queue.push("first");
		// The link dies under the first send (a ping timeout): kept, with its request ID.
		(await next()).reject(new ChordError({ code: "unavailable", message: "link to session:x closed: ping timeout" }));
		setTarget(undefined);
		await queue.flush();
		queue.push("second");
		await queue.flush();
		assert.equal(queue.size, 2);
		assert.equal(queue.waiting, 2);
		// The replacement reference arrives (rebind): both go, in order, the first with its old request ID.
		setTarget(target);
		const flushed = queue.flush();
		(await next()).resolve();
		(await next()).resolve();
		await flushed;
		assert.deepEqual(calls, ["send first", "send first", "send second"]);
		assert.equal(queue.size, 0);
		assert.equal(queue.waiting, 0);
		assert.deepEqual(errors, []);
	});

	it("drops a refused transcript with an error, and the oldest waiting beyond the limit", async () => {
		const { queue, next, errors, setTarget } = setup({ limit: 2 });
		queue.push("refused");
		(await next()).reject(new ChordError({ code: "forbidden", message: "no" }));
		await queue.flush();
		assert.equal(queue.size, 0);
		// Chord v2 error messages carry no code prefix.
		assert.match(errors[0] ?? "", /Send failed: no$/);
		setTarget(undefined);
		queue.push("a");
		queue.push("b");
		queue.push("c");
		assert.equal(queue.size, 2);
		assert.match(errors[1] ?? "", /Too many messages waiting/);
		queue.clear();
	});
});

describe("voice barge-in detector (pibot's)", () => {
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
});

describe("voice interruptions", () => {
	const rate = 16000;
	const frame = 1024;
	let seed = 7;
	const loud = () =>
		Float32Array.from({ length: frame }, () => {
			seed = (seed * 16807) % 2147483647;
			return (seed / 2147483647 - 0.5) * 1;
		});
	const pcmOf = (input: Float32Array) => Int16Array.from(input, (sample) => Math.round(sample * 0x7fff));

	it("listens for barge-in only while the agent's speech plays", () => {
		const detector = new BargeInDetector(rate);
		for (let at = 0; at < rate; at += frame) detector.handlePlaybackAudio(new Float32Array(frame).fill(0.1), rate);
		const feed = (playing: boolean) => {
			const phase = bargeInPhase({ hearing: false, playing });
			for (let index = 0; index < 20; index++) {
				const input = loud();
				if (detector.observeMic(input, rate, pcmOf(input), phase, playing).triggered)
					return { phase, barged: true };
			}
			return { phase, barged: false };
		};
		// The agent works silently: the speaker's words stream as usual, no barge-in.
		assert.deepEqual(feed(false), { phase: "listening", barged: false });
		assert.equal(detector.shouldStreamMicNormally(bargeInPhase({ hearing: false, playing: false })), true);
		// Its speech plays: sound it does not explain triggers (a candidate: interruption.ts decides).
		assert.deepEqual(feed(true), { phase: "speaking", barged: true });
		assert.equal(bargeInPhase({ hearing: true, playing: true }), "hearing");
	});

	it("a message sent while the agent works stops it first, unless the speaker's words stopped it already", async () => {
		const calls: string[] = [];
		let busy = true;
		const queue = new PendingTranscripts({
			target: () => ({
				send: async (text) => calls.push(`send ${text}`),
				stop: async () => {
					calls.push("stop");
					busy = false;
					return { restored: [] };
				},
			}),
			busy: () => busy,
			log: () => {},
			onError: () => {},
			onChange: () => {},
		});
		queue.push("wait, do it differently");
		await queue.flush();
		assert.deepEqual(calls, ["stop", "send wait, do it differently"]);
		busy = true;
		queue.push("already stopped by its words", false);
		await queue.flush();
		assert.deepEqual(calls.slice(2), ["send already stopped by its words"]);
	});

	it("waits for a stop in flight before sending, and sends the messages it withdrew with the next one", async () => {
		const calls: string[] = [];
		let settle: (value: { restored: readonly string[] }) => void = () => {};
		const queue = new PendingTranscripts({
			target: () => ({
				send: async (text) => calls.push(`send ${text}`),
				stop: async () => ({ restored: [] }),
			}),
			busy: () => false,
			log: () => {},
			onError: () => {},
			onChange: () => {},
		});
		queue.stopping(
			new Promise((resolve) => {
				settle = resolve;
			}),
		);
		queue.push("said after the interruption", false);
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.deepEqual(calls, [], "no send while the stop is in flight (it would withdraw it)");
		settle({ restored: ["queued before"] });
		await poll(() => calls.length === 1, 2000, "sent");
		assert.deepEqual(calls, ["send queued before\n\nsaid after the interruption"]);
	});

	it("keeps messages a barge-in's stop withdrew: with the next message, or alone after a while", async () => {
		const sent: string[] = [];
		const queue = new PendingTranscripts({
			target: () => ({
				send: async (text) => sent.push(text),
				stop: async () => ({ restored: [] }),
			}),
			busy: () => false,
			log: () => {},
			onError: () => {},
			onChange: () => {},
			carryMs: 50,
		});
		queue.carry(["queued before"]);
		queue.push("said now");
		await queue.flush();
		assert.deepEqual(sent, ["queued before\n\nsaid now"]);
		queue.carry(["nothing follows"]);
		await poll(() => sent.length === 2, 2000, "sent alone");
		await queue.flush();
		assert.equal(sent[1], "nothing follows");
	});
});

describe("voice interruption by words", () => {
	/** An Interruption with a scripted clock and engine state, recording what it did. */
	const setup = (state: Partial<Omit<InterruptionState, "said">> & { said?: string[] } = {}) => {
		const did: string[] = [];
		let now = 0;
		const current = { busy: true, speaking: true, chatMode: false, agentName: undefined, ...state };
		const interruption = new Interruption({
			state: () => ({ ...current, said: () => state.said ?? [] }),
			cutSpeech: () => did.push("cut speech"),
			stopRun: () => did.push("stop run"),
			dropStream: () => did.push("drop stream"),
			log: () => {},
			now: () => now,
		});
		return {
			interruption,
			did,
			current,
			advance: (ms: number) => {
				now += ms;
			},
		};
	};

	it("tells words from noise, fillers and the agent's own speech heard back", () => {
		for (const text of ["", " ", ".", "Mm.", "Uh, um.", "Hmm?", "A", "Oh. Ah."]) assert(!meaningful(text), text);
		for (const text of ["No.", "Stop", "Wait, use the other file.", "42", "Nein, warte."])
			assert(meaningful(text), text);
		const said = ["I will look at the build log and then restart the server."];
		assert(isEcho("look at the build log", said));
		assert(!isEcho("no, the test log", said), "a word the agent did not say");
		assert(!isEcho("the server", said), "two words are the speaker's");
	});

	it("drops a barge-in the room never hears as speech: the agent keeps speaking and working", () => {
		const { interruption, did, advance } = setup();
		interruption.trigger();
		assert.equal(interruption.pending, true);
		advance(CANDIDATE_START_MS - 1);
		interruption.tick();
		assert.deepEqual(did, []);
		advance(2);
		interruption.tick();
		assert.deepEqual(did, ["drop stream"]);
		assert.equal(interruption.pending, false);
	});

	it("drops a barge-in whose speech has no words (wipers): nothing cut, nothing sent", () => {
		for (const final of ["", "Mm.", "look at the build log"]) {
			const { interruption, did } = setup({ said: ["I will look at the build log."] });
			interruption.trigger();
			interruption.speechStart();
			interruption.tick();
			interruption.interim("Hmm.");
			assert.deepEqual(did, [], final);
			assert.deepEqual(interruption.final(final), { text: undefined, stopped: false }, final);
			assert.deepEqual(did, ["drop stream"], final);
		}
	});

	it("interrupts at the first words: speech cut and run stopped once, then the final is the message", () => {
		const { interruption, did } = setup();
		interruption.trigger();
		interruption.speechStart();
		assert.equal(interruption.pending, false, "the room heard speech: it is the speaker's utterance");
		interruption.interim("Wait");
		assert.deepEqual(did, ["cut speech", "stop run"]);
		interruption.interim("Wait, use the other file");
		assert.deepEqual(did, ["cut speech", "stop run"], "once per utterance");
		assert.deepEqual(interruption.final("Wait, use the other file."), {
			text: "Wait, use the other file.",
			stopped: true,
		});
		assert.deepEqual(did, ["cut speech", "stop run"]);
	});

	it("stops a silently working agent at the first words, without waiting for the end of the utterance", () => {
		const { interruption, did } = setup({ speaking: false });
		interruption.speechStart();
		interruption.interim("Um");
		assert.deepEqual(did, []);
		interruption.interim("Actually, no");
		assert.deepEqual(did, ["stop run"]);
	});

	it("interrupts at the final when the service sends no interim transcripts", () => {
		const { interruption, did } = setup();
		interruption.trigger();
		interruption.speechStart();
		assert.deepEqual(interruption.final("No, the other one."), { text: "No, the other one.", stopped: true });
		assert.deepEqual(did, ["cut speech", "stop run"]);
	});

	it("sends a dictation the service split as one message, never stopping the run of its first half", () => {
		// The service ends an utterance at 30 s and the next one starts before the first one's final arrives.
		const { interruption, did, current } = setup({ speaking: false, busy: false });
		interruption.speechStart();
		interruption.interim("First I want you to");
		interruption.speechStart();
		assert.deepEqual(interruption.final("First I want you to look at the logs,"), {
			text: undefined,
			stopped: false,
		});
		// The second half's words belong to the second utterance; nothing ran for the first, nothing is stopped.
		interruption.interim("and then");
		assert.deepEqual(interruption.final("and then restart it."), {
			text: "First I want you to look at the logs, and then restart it.",
			stopped: false,
		});
		assert.deepEqual(did, []);
		// While the agent works: the first half stops it once, the second half does not stop again.
		current.busy = true;
		interruption.speechStart();
		interruption.interim("No wait");
		interruption.speechStart();
		assert.deepEqual(interruption.final("No wait, not that one."), { text: undefined, stopped: false });
		interruption.interim("Use the other");
		assert.deepEqual(interruption.final("Use the other file."), {
			text: "No wait, not that one. Use the other file.",
			stopped: true,
		});
		assert.deepEqual(did, ["stop run"]);
		// A held half whose continuation is noise goes alone.
		interruption.speechStart();
		interruption.speechStart();
		assert.deepEqual(interruption.final("Check the build."), { text: undefined, stopped: false });
		assert.deepEqual(interruption.final(""), { text: "Check the build.", stopped: true });
	});

	it("in chat mode cuts the speech for anyone's words, and stops the run only when they are for the agent", () => {
		const chat = setup({ chatMode: true });
		chat.interruption.speechStart();
		chat.interruption.interim("lunch at noon?");
		assert.deepEqual(chat.did, ["cut speech"]);
		const addressed = setup({ chatMode: true, speaking: false });
		addressed.interruption.speechStart();
		addressed.interruption.interim("lunch at noon?");
		assert.deepEqual(addressed.did, []);
		assert.deepEqual(addressed.interruption.final("lunch at noon?"), { text: "lunch at noon?", stopped: false });
		addressed.interruption.speechStart();
		addressed.interruption.interim("Pi, stop that");
		assert.deepEqual(addressed.did, ["stop run"]);
		// People talking over the agent cut its speech; the agent's name later in the same utterance stops its run.
		const later = setup({ chatMode: true });
		later.interruption.speechStart();
		later.interruption.interim("lunch at noon?");
		later.interruption.interim("lunch at noon? Pi, stop that");
		assert.deepEqual(later.did, ["cut speech", "stop run"]);
		const stop = setup({ chatMode: true, speaking: false });
		stop.interruption.speechStart();
		stop.interruption.interim("Stop.");
		assert.deepEqual(stop.did, ["stop run"]);
	});

	it("forgets the utterances in progress when the room's connection ends, returning what was held", () => {
		const { interruption, did, advance } = setup();
		interruption.trigger();
		assert.deepEqual(interruption.reset(), { text: undefined, stopped: false });
		advance(CANDIDATE_START_MS * 2);
		interruption.tick();
		assert.deepEqual(did, []);
		assert.equal(interruption.pending, false);
		interruption.speechStart();
		interruption.speechStart();
		interruption.final("Keep this.");
		assert.deepEqual(interruption.reset(), { text: "Keep this.", stopped: true });
	});
});

describe("voice microphone resampling", () => {
	it("keeps every sample across frames at 48 and 44.1 kHz", () => {
		for (const rate of [48000, 44100]) {
			const resampler = new Pcm16kResampler();
			let out = 0;
			const frames = 200;
			for (let index = 0; index < frames; index++)
				out += resampler.push(new Float32Array(1024).fill(0.5), rate).length;
			const expected = (frames * 1024 * 16000) / rate;
			assert(Math.abs(out - expected) <= 1, `${rate}: ${out} samples, expected ${expected}`);
		}
		// A constant stays constant over frame boundaries (no clicks).
		const resampler = new Pcm16kResampler();
		const samples = [0, 1, 2].flatMap(() => [...resampler.push(new Float32Array(1024).fill(0.25), 44100)]);
		assert(samples.every((sample) => sample === samples[0]));
	});
});

describe("voice answers read while they stream", () => {
	it("reads the text before a tool call without waiting for the call's arguments", () => {
		const view = (content: unknown[]) =>
			({
				entries: [],
				docs: { "pi.live": { run: {}, generation: { message: { role: "assistant", timestamp: 1, content } } } },
			}) as unknown as ConversationView;
		const [streaming] = responses(view([{ type: "text", text: "I will hand this to a doer." }]));
		assert.deepEqual({ done: streaming?.done, closed: streaming?.closed }, { done: false, closed: false });
		const [calling] = responses(
			view([
				{ type: "text", text: "I will hand this to a doer." },
				{ type: "toolCall", id: "1", name: "subagent", arguments: { brief: "a long br" } },
			]),
		);
		assert.deepEqual({ done: calling?.done, closed: calling?.closed }, { done: false, closed: true });
		const chunker = new SpeechChunker();
		assert.deepEqual(chunker.push(streaming?.text ?? "", streaming?.closed), []);
		assert.deepEqual(chunker.push(calling?.text ?? "", calling?.closed), ["I will hand this to a doer."]);
		// Text after the call continues where the chunker stopped.
		assert.deepEqual(chunker.push(`${calling?.text}\nDone. It works.`, true), ["Done.", "It works."]);
	});
});

describe("voice room frames", () => {
	it("splits a binary frame into kind, ID and PCM past the pad byte, copied to a buffer of its own", () => {
		// Kind 1, ID "a-1": 2 + 3 bytes is odd, so one pad byte; the PCM starts at 6.
		const odd = parseRoomFrame(new Uint8Array([1, 3, 0x61, 0x2d, 0x31, 0, 1, 2, 3, 4]));
		assert.deepEqual({ ...odd, pcm: [...(odd?.pcm ?? [])] }, { kind: 1, id: "a-1", pcm: [1, 2, 3, 4] });
		// Kind 2, ID "ab": 2 + 2 bytes is even, no pad.
		const even = parseRoomFrame(new Uint8Array([2, 2, 0x61, 0x62, 5, 6]));
		assert.deepEqual({ ...even, pcm: [...(even?.pcm ?? [])] }, { kind: 2, id: "ab", pcm: [5, 6] });
		assert.equal(odd?.pcm.byteOffset, 0);
		assert.equal(parseRoomFrame(new Uint8Array([1, 9, 1])), undefined);
		assert.equal(roomName("s1", 1), "p2-s1-1");
		assert.equal(roomName("bad id", 1), undefined);
	});
});

describe("voice in chat mode", () => {
	it("turns the agent's name spoken anywhere into a mention in front, keeping what was said", () => {
		for (const [spoken, written] of [
			["Pi, what time is it?", "@pi Pi, what time is it?"],
			["Hey Pi, are you there?", "@pi Hey Pi, are you there?"],
			["can Pi summarize this", "@pi can Pi summarize this"],
			["what do you think, Pi?", "@pi what do you think, Pi?"],
			["  PI.", "@pi PI."],
			["Ask @pi later", "Ask @pi later"],
		])
			assert.equal(spokenMention(spoken), written, spoken);
		// Whole words only; a possessive or contraction ("Pi's") talks about the agent, not to it.
		for (const text of ["Pie is great.", "Piano lessons today", "pip install it", "Pi's answer was odd", "pi-hole"])
			assert.equal(spokenMention(text), text, text);
		// A renamed agent: its name counts, Pi's does not.
		assert.equal(spokenMention("hey Claude, run it", "Claude"), "@claude hey Claude, run it");
		assert.equal(spokenMention("Pi, do it", "Claude"), "Pi, do it");
		assert.equal(spokenMention("Claudette called", "Claude"), "Claudette called");
		assert.deepEqual(voiceMessage("Pi, go", false), { text: "Pi, go", interrupts: true });
		assert.deepEqual(voiceMessage("Pi, go", true), { text: "@pi Pi, go", interrupts: true });
		assert.deepEqual(voiceMessage("lunch?", true), { text: "lunch?", interrupts: false });
		assert.deepEqual(voiceMessage("thanks Claude", true, "Claude"), {
			text: "@claude thanks Claude",
			interrupts: true,
		});
	});

	it("does not stop a busy run for a message that is not for Pi", async () => {
		const calls: string[] = [];
		const queue = new PendingTranscripts({
			target: () => ({
				send: async (text) => calls.push(`send ${text}`),
				stop: async () => {
					calls.push("stop");
					return { restored: [] };
				},
			}),
			busy: () => true,
			log: () => {},
			onError: () => {},
			onChange: () => {},
		});
		queue.push("lunch?", false);
		await queue.flush();
		queue.push("@pi which place?", true);
		await queue.flush();
		assert.deepEqual(calls, ["send lunch?", "stop", "send @pi which place?"]);
	});

	it("places spoken chat as the speaker's chat entry, and a spoken address as a mention that Pi answers", async (t) => {
		const fixture = await chatModeHost();
		t.after(() => fixture.close());
		const OWNER = { kind: "owner", access: "local" } as const;
		const ALICE = {
			kind: "guest",
			id: "alice",
			name: "Alice",
			home: "s1",
			sessions: { s1: "full" },
			revision: 1,
		} as const;
		const where = { session: "s1", conversation: 1 };
		const owner = await holdIn(fixture.client(OWNER), Chat, where, "participant");
		const alice = await holdIn(fixture.client(ALICE), Chat, where, "participant");
		const mode = await holdIn(fixture.client(OWNER), ChatMode, where, "owner");
		await mode.set({ enabled: true }, BACKGROUND_CONTEXT);
		await until(mode.enabled, (value) => value === true);
		const answered = (view: ConversationView | null | undefined) =>
			view?.entries.some((entry) => entry.model?.[0]?.role === "assistant") ?? false;
		// What the voice engine sends: the transcript as `voiceMessage` makes it.
		await owner.send({ text: voiceMessage("lunch first?", true).text, requestId: "1" }, BACKGROUND_CONTEXT);
		await alice.send({ text: voiceMessage("Pie sounds good", true).text, requestId: "2" }, BACKGROUND_CONTEXT);
		const chatted = await until(
			owner.view,
			(view) => (view?.entries ?? []).filter((entry) => entry.kind === "chat.message").length === 2,
		);
		assert.deepEqual(
			chatted?.entries.filter((entry) => entry.kind === "chat.message").map((entry) => entry.data),
			[
				{ author: { kind: "owner", id: "owner", name: "Owner" }, text: "lunch first?", attachments: [] },
				{ author: { kind: "guest", id: "alice", name: "Alice" }, text: "Pie sounds good", attachments: [] },
			],
		);
		assert(!answered(chatted), "no run for chat");
		await alice.send({ text: voiceMessage("Hey Pi, which place?", true).text, requestId: "3" }, BACKGROUND_CONTEXT);
		const view = await until(owner.view, answered);
		assert.deepEqual(view?.entries.find((entry) => entry.kind === "chat.mention")?.data, {
			author: { kind: "guest", id: "alice", name: "Alice" },
			text: "@pi Hey Pi, which place?",
			attachments: [],
			included: chatted?.entries.filter((entry) => entry.kind === "chat.message").map((entry) => entry.id),
		});
	});
});

describe("voice choice against the service", () => {
	it("keeps a language the engine speaks, else falls back to its default; lists English and Deutsch first", () => {
		const supertonic = VOICES.engines[0];
		assert.deepEqual(
			languagesOf(supertonic).map((option) => option.id),
			["en", "de", "fr"],
		);
		const german = { engine: "supertonic", voice: "supertonic-F2", speed: 1, language: "de" };
		assert.deepEqual(resolved(VOICES, german), german);
		// Kokoro speaks English only: switching to it resets the language.
		assert.equal(resolved(VOICES, { ...german, engine: "kokoro", voice: "kokoro-af_heart" }).language, "en");
		// Unknown or absent: the engine's (here the service's) default.
		assert.equal(resolved(VOICES, { ...german, language: "xx" }).language, "en");
		assert.equal(resolved(VOICES, { engine: "", voice: "", speed: 1 }).language, "en");
		// An engine gone: the service's default voice and language.
		assert.deepEqual(resolved(VOICES, { engine: "gone", voice: "gone-1", speed: 1.2, language: "de" }), {
			engine: "supertonic",
			voice: "supertonic-F1",
			speed: 1.2,
			language: "de",
		});
	});
});

describe("voice prompt language", () => {
	it("asks for answers in the voice's language, unless it is English or unset", () => {
		assert.equal(voicePrompt(undefined), VOICE_PROMPT);
		assert.equal(voicePrompt("en"), VOICE_PROMPT);
		assert.equal(voicePrompt("en-GB"), VOICE_PROMPT);
		assert.match(voicePrompt("de"), /Speak German: reply in German/);
		assert.match(voicePrompt("pt-BR"), /Speak Brazilian Portuguese/);
		assert(voicePrompt("de").startsWith(VOICE_PROMPT));
	});
});

describe("voice mode's switch and voice", () => {
	it("keeps the owner's switch and voice; a read/write guest switches only its own and cannot choose", async (t) => {
		const fixture = await chatModeHost({ facet: voiceWorker });
		t.after(() => fixture.close());
		const where = { session: "s1", conversation: 1 };
		const owner = await holdIn(fixture.client({ kind: "owner", access: "local" }), VoiceMode, where, "owner");
		const alice = await holdIn(
			fixture.client({
				kind: "guest",
				id: "alice",
				name: "Alice",
				home: "s1",
				sessions: { s1: "full" },
				revision: 1,
			}),
			VoiceMode,
			where,
			"participant",
		);
		await owner.set({ enabled: true }, BACKGROUND_CONTEXT);
		// The answer follows its state: the owner's switch and voice are on the page when each call resolves.
		assert.equal(owner.enabled.value, true);
		await owner.choose({ engine: "kokoro", voice: "kokoro-af_heart", speed: 1, language: "de" }, BACKGROUND_CONTEXT);
		assert.equal(owner.voice.value?.voice, "kokoro-af_heart");
		// The guest sees the owner's choice, language included.
		assert.equal((await until(alice.voice, (voice) => voice?.voice === "kokoro-af_heart"))?.language, "de");
		assert.equal(alice.enabled.value, false, "a guest's switch is its own");
		await alice.set({ enabled: true }, BACKGROUND_CONTEXT);
		assert.equal(alice.enabled.value, true);
		// The guest turning its microphone off leaves the owner's voice mode on.
		await alice.set({ enabled: false }, BACKGROUND_CONTEXT);
		assert.equal(alice.enabled.value, false);
		assert.equal(owner.enabled.value, true);
		// A reference carries every variant's members; the participant's binding refuses the owner's (cast: the type has
		// only the participant's).
		const asOwner = alice as unknown as typeof owner;
		await expectChord(
			asOwner.choose({ engine: "kokoro", voice: "kokoro-af_heart", speed: 1, language: "de" }, BACKGROUND_CONTEXT),
			"invalid",
		);
		// A view-only guest has no voice mode.
		const bob = fixture
			.client({ kind: "guest", id: "bob", name: "Bob", home: "s1", sessions: { s1: "view" }, revision: 1 })
			.hold(VoiceMode, where, BACKGROUND_CONTEXT);
		await expectChord(whenLive(bob), "forbidden");
	});
});

describe("voice routes and mode", () => {
	let fixture: Fixture;
	let speech: Awaited<ReturnType<typeof fakeSpeechService>>;
	const tunnel = { Host: "share.test" };
	before(async () => {
		fixture = await startFixture({ allowedHosts: ["share.test"] });
		speech = await fakeSpeechService("secret-token");
	});
	after(async () => {
		speech?.close();
		await fixture?.close();
	});

	it("publishes the service's engines live as voice.json appears, breaks, moves away and returns", async () => {
		const service = await holdIn(fixture.browser(), VoiceService, {}, "talker");
		await until(service.voices, (value) => value === null);
		const file = join(fixture.dataDir, "voice.json");
		writeFileSync(file, JSON.stringify({ url: `${speech.url}/`, token: "secret-token" }));
		assert.deepEqual(await until(service.voices, (value) => value !== null), VOICES);
		writeFileSync(file, "{ not json");
		await until(service.voices, (value) => value === null);
		writeFileSync(file, JSON.stringify({ url: `${speech.url}/`, token: "secret-token" }));
		await until(service.voices, (value) => value !== null);
		renameSync(file, `${file}.away`);
		await until(service.voices, (value) => value === null);
		renameSync(`${file}.away`, file);
		assert.deepEqual(await until(service.voices, (value) => value !== null), VOICES);
		assert.equal(service.failure.value, null);
		service.release();
	});

	it("bridges the conversation's room: p2's identity, the owner's commands, speech for everyone", async () => {
		const port = fixture.server.port;
		const owner = fixture.browser();
		const session = (
			await (await holdIn(owner, Sessions, {}, "owner")).create({ cwd: fixture.workspace }, BACKGROUND_CONTEXT)
		).id;
		const sharing = owner.hold(Sharing, { session }, BACKGROUND_CONTEXT);
		await sharing.link({ mode: "full" }, BACKGROUND_CONTEXT);
		await sharing.link({ mode: "view" }, BACKGROUND_CONTEXT);
		const links = await until(sharing.links, (value) => (value?.length ?? 0) >= 2);
		const headers = { Host: "share.test", Origin: "https://share.test", "Content-Type": "application/json" };
		const join = async (mode: "full" | "view", name: string) => {
			const joined = await http(port, "/join", {
				method: "POST",
				headers,
				body: JSON.stringify({ token: links?.find((link) => link.mode === mode)?.token, name }),
			});
			return { ...headers, Cookie: String(joined.headers["set-cookie"]).split(";")[0] ?? "" };
		};
		const full = await join("full", "Alice");
		const view = await join("view", "Bob");
		const path = `/voice/room?session=${session}&conversation=1`;
		// What a browser claims about itself is never passed on.
		const spoofed = { "X-Room": "p2-other-room", "X-Participant-Id": "mallory", "X-Participant-Role": "owner" };
		const join_ = async (as: Record<string, string>) => {
			const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers: { ...as, ...spoofed } });
			const texts: { type: string; id?: string; code?: string; duplicate?: boolean; participant?: string }[] = [];
			const frames: Buffer[] = [];
			socket.on("message", (data: Buffer, binary: boolean) => {
				if (binary) frames.push(data);
				else texts.push(JSON.parse(data.toString()) as { type: string });
			});
			await once(socket, "open");
			await poll(() => texts.some((event) => event.type === "welcome"), 5000, "welcome");
			return { socket, texts, frames };
		};
		const ownerRoom = await join_({});
		const guestRoom = await join_(full);
		const room = `p2-${session}-1`;
		const [ownerHeaders, guestHeaders] = speech.upgrades.slice(-2);
		assert.deepEqual(
			{
				room: ownerHeaders?.["x-room"],
				id: ownerHeaders?.["x-participant-id"],
				name: ownerHeaders?.["x-participant-name"],
				role: ownerHeaders?.["x-participant-role"],
				auth: ownerHeaders?.authorization,
			},
			{ room, id: "owner", name: "Owner", role: "owner", auth: "Bearer secret-token" },
		);
		assert.equal(guestHeaders?.["x-room"], room);
		assert.equal(guestHeaders?.["x-participant-role"], "guest");
		assert.equal(guestHeaders?.["x-participant-name"], "Alice");
		const guestId = String(guestHeaders?.["x-participant-id"]);
		assert.match(guestId, /^[A-Za-z0-9_-]+$/);
		assert.notEqual(guestId, "mallory");

		// The owner's tabs say a sentence once: the repeat is the room's duplicate. Everyone hears it.
		ownerRoom.socket.send(JSON.stringify({ type: "speak", id: "17-0", text: "Hello there." }));
		ownerRoom.socket.send(JSON.stringify({ type: "speak", id: "17-0", text: "Hello there." }));
		await poll(() => ownerRoom.texts.filter((event) => event.type === "speak_ack").length === 2, 5000, "acks");
		assert.deepEqual(
			ownerRoom.texts.filter((event) => event.type === "speak_ack").map((event) => event.duplicate),
			[false, true],
		);
		assert.deepEqual(
			speech.spoken.filter((said) => said.room === room).map((said) => said.id),
			["17-0"],
		);
		await poll(() => guestRoom.texts.some((event) => event.type === "tts_done"), 5000, "guest hears it");
		const heard = guestRoom.frames.map((frame) => parseRoomFrame(new Uint8Array(frame)));
		assert(heard.every((frame) => frame?.kind === 1 && frame.id === "17-0"));
		assert.equal(
			heard.reduce((sum, frame) => sum + (frame?.pcm.byteLength ?? 0), 0),
			0.3 * 16000 * 2,
		);

		// A guest may only reset its own microphone; anything else stops at p2.
		const before = speech.commands.length;
		guestRoom.socket.send(JSON.stringify({ type: "speak", id: "x-0", text: "I am Pi now." }));
		guestRoom.socket.send(JSON.stringify({ type: "config", voice: "kokoro-af_heart" }));
		guestRoom.socket.send(JSON.stringify({ type: "reset" }));
		await poll(() => guestRoom.texts.filter((event) => event.code === "forbidden").length === 2, 5000, "refusals");
		await poll(() => speech.commands.length === before + 1, 5000, "reset passed");
		assert.deepEqual(speech.commands.at(-1), { from: guestId, command: { type: "reset" } });
		// The owner's language reaches the room; a malformed one stops at p2.
		ownerRoom.socket.send(JSON.stringify({ type: "config", language: "de" }));
		ownerRoom.socket.send(JSON.stringify({ type: "config", language: "Deutsch" }));
		await poll(() => speech.commands.some(({ command }) => command.language === "de"), 5000, "language passed");
		await poll(() => ownerRoom.texts.some((event) => event.code === "invalid_message"), 5000, "bad language");
		assert(!speech.commands.some(({ command }) => command.language === "Deutsch"));
		// Everyone's own pause before sending passes, within 0.5-2 s.
		guestRoom.socket.send(JSON.stringify({ type: "vad", silence: 1.2 }));
		guestRoom.socket.send(JSON.stringify({ type: "vad", silence: 3 }));
		ownerRoom.socket.send(JSON.stringify({ type: "vad", silence: 0.5 }));
		ownerRoom.socket.send(JSON.stringify({ type: "vad", silence: 0.4 }));
		// reset, the language and the two valid pauses passed.
		await poll(() => speech.commands.length === before + 4, 5000, "pauses passed");
		await poll(() => guestRoom.texts.filter((event) => event.code === "forbidden").length === 3, 5000, "guest range");
		await poll(() => ownerRoom.texts.some((event) => event.code === "invalid_message"), 5000, "owner range");
		await poll(() => guestRoom.texts.some((event) => event.type === "vad"), 5000, "guest's pause acknowledged");
		assert.deepEqual(speech.commands.slice(-2), [
			{ from: guestId, command: { type: "vad", silence: 1.2 } },
			{ from: "owner", command: { type: "vad", silence: 0.5 } },
		]);
		// The guest's microphone reaches the others, as the guest's.
		guestRoom.socket.send(Buffer.alloc(640));
		const relayed = () =>
			ownerRoom.frames.map((frame) => parseRoomFrame(new Uint8Array(frame))).find((frame) => frame?.kind === 2);
		await poll(() => relayed() !== undefined, 5000, "relayed audio");
		assert.equal(relayed()?.id, guestId);
		assert.equal(relayed()?.pcm.byteLength, 640);
		ownerRoom.socket.close();
		guestRoom.socket.close();

		const status = async (url: string, as: Record<string, string>) => {
			const socket = new WebSocket(`ws://127.0.0.1:${port}${url}`, { headers: as });
			socket.on("error", () => {});
			const [, response] = (await once(socket, "unexpected-response")) as [unknown, { statusCode: number }];
			return response.statusCode;
		};
		assert.equal(await status(path, view), 403, "view-only guests have no voice");
		assert.equal(await status(`/voice/room?session=other-session&conversation=1`, full), 403, "another session's");
		assert.equal(await status("/voice/room?conversation=1", {}), 400);
		assert.equal(await status(`/voice/room?session=${session}&conversation=0`, {}), 400);

		// The engines for both (pushed live); a sample for the owner only; logs for both, the guest's marked as such.
		const alice = await holdIn(fixture.client(full).host, VoiceService, {}, "talker");
		assert.deepEqual(await until(alice.voices, (value) => value !== null), VOICES);
		alice.release();
		await expectChord(whenLive(fixture.client(view).host.hold(VoiceService, {}, BACKGROUND_CONTEXT)), "forbidden");
		const origin = { Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json" };
		const sample = await http(port, "/voice/sample", {
			method: "POST",
			headers: origin,
			body: JSON.stringify({ engine: "supertonic", voice: "supertonic-F1", speed: 1.1, language: "de" }),
		});
		assert.equal(sample.status, 200);
		assert.equal(sample.headers["content-type"], "audio/wav");
		assert.deepEqual(
			{ voice: speech.samples.at(-1)?.voice, language: speech.samples.at(-1)?.language },
			{ voice: "supertonic-F1", language: "de" },
		);
		assert.equal(
			(await http(port, "/voice/sample", { method: "POST", headers: full, body: '{"speed":1}' })).status,
			403,
		);
		const lines: string[] = [];
		const log = mock.method(console, "log", (line: unknown) => {
			lines.push(String(line));
		});
		try {
			const batch = JSON.stringify({ client: "abc", events: [{ t: 0, message: "hello" }] });
			assert.equal((await http(port, "/voice/log", { method: "POST", headers: full, body: batch })).status, 204);
			assert.equal((await http(port, "/voice/log", { method: "POST", headers: view, body: batch })).status, 403);
			assert.match(lines.find((line) => line.startsWith("[voice")) ?? "", /^\[voice guest:\S+ abc\] /);
		} finally {
			log.mock.restore();
		}
	});

	it("writes the browser's diagnostics to the server log, for the owner only", async () => {
		const port = fixture.server.port;
		const origin = { Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json" };
		const lines: string[] = [];
		const log = mock.method(console, "log", (line: unknown) => {
			lines.push(String(line));
		});
		try {
			const batch = {
				client: "abc123",
				events: [
					{ t: Date.UTC(2026, 0, 1, 12, 34, 56, 789), message: "socket open" },
					{ t: Date.UTC(2026, 0, 1, 12, 34, 57), message: "final: 12 chars\nsecond line" },
				],
			};
			const sent = await http(port, "/voice/log", { method: "POST", headers: origin, body: JSON.stringify(batch) });
			assert.equal(sent.status, 204);
			assert.deepEqual(
				lines.filter((line) => line.startsWith("[voice")),
				["[voice abc123] 12:34:56.789 socket open", "[voice abc123] 12:34:57.000 final: 12 chars second line"],
			);
			const post = (headers: Record<string, string>, body: unknown) =>
				http(port, "/voice/log", { method: "POST", headers, body: JSON.stringify(body) });
			assert.equal((await post({ ...tunnel, ...origin }, batch)).status, 403);
			assert.equal((await post({ Origin: "https://evil.test" }, batch)).status, 403);
			const many = { client: "abc123", events: Array.from({ length: 101 }, () => ({ t: 0, message: "x" })) };
			assert.equal((await post(origin, many)).status, 400);
			assert.equal(
				(await post(origin, { client: "abc123", events: [{ t: 0, message: "x".repeat(501) }] })).status,
				400,
			);
			assert.equal((await post(origin, { client: "a b", events: [] })).status, 400);
			assert.equal(lines.filter((line) => line.startsWith("[voice")).length, 2);
		} finally {
			log.mock.restore();
		}
	});

	it("turns the voice prompt section on per conversation", async () => {
		const owner = fixture.browser();
		const sessions = await holdIn(owner, Sessions, {}, "owner");
		const session = await sessions.create({ cwd: fixture.workspace }, BACKGROUND_CONTEXT);
		const input = { session: session.id, conversation: 1 };
		const chat = await holdIn(owner, Chat, input, "participant");
		const keep = follow(chat.view, () => {});
		const mode = await holdIn(owner, VoiceMode, input, "owner");
		const sections = () => JSON.stringify(chat.view.value?.entries ?? []);
		await chat.send({ text: "typed", requestId: "one" }, BACKGROUND_CONTEXT);
		await until(chat.view, (view) => (view?.entries ?? []).some((entry) => entry.kind === "pi.assistant"));
		assert(!sections().includes(VOICE_PROMPT.slice(0, 40)));
		await mode.set({ enabled: true }, BACKGROUND_CONTEXT);
		await until(mode.enabled, (enabled) => enabled === true);
		await chat.send({ text: "spoken", requestId: "two" }, BACKGROUND_CONTEXT);
		await until(chat.view, () => sections().includes(VOICE_PROMPT.slice(0, 40)), 20_000);
		keep();
		chat.release();
		mode.release();
	});
});
