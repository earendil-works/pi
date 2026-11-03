// Voice mode in the browser, one voice room per conversation (p2's /voice/room, bridged to the speech service's
// /room). The microphone goes to the room: each finished utterance becomes this person's message in the conversation,
// and the others hear it. The owner's browser has the agent's new answers read aloud sentence by sentence (each with
// a stable ID, `<answer>-<index>`, so the owner's other tabs do not say it twice); the room synthesizes them once and
// everyone hears them. A tap on the orb while it speaks stops the speech (for the room when the owner taps, else for
// this browser); a message while the agent works stops that run first, and "stop" stops it without a message.
// Transcripts wait in order until the conversation accepted them (transcripts.ts), so a link that drops for a while
// loses none.
//
// The audio pipeline is pibot's (badlogic/pibot src/client at 2ef6b69), ported as a unit: its microphone constraints
// (applied again after getUserMedia), a microphone AudioContext of its own, the playback stream with its voice chain
// and reference tap (playback.ts), its input blocking (0 while speech starts, 500 ms after it ends or is cancelled), and
// its barge-in detector and state transitions (barge-in.ts). Only the backend is p2's: the conversation instead of
// pibot's server, and the room's speech instead of pibot's TTS frames.
//
// Barge-in is pibot's detector, while the agent's speech plays (policy.ts): the microphone is buffered, not streamed;
// sound the playback does not explain streams the speaker from a second before, while the agent goes on speaking.
// Only words interrupt (interruption.ts): once the room's interim (or final) transcript holds a real word, the speech
// is cut and the run stopped (outside chat mode), whether the agent spoke or only worked; a trigger the room never
// hears as words is dropped. A transcript without words is never sent.
//
// What happens is also logged to the server (POST /voice/log, batched): a phone's console is out of reach.

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ConversationView } from "@earendil-works/pi-durable";
import { follow, type Watchable } from "@p2/app/v1";
import { BargeInDetector, type BargeInPhase, Pcm16kResampler } from "./barge-in.ts";
import { Interruption } from "./interruption.ts";
import { SpeechPlayback } from "./playback.ts";
import { bargeInPhase } from "./policy.ts";
import {
	AGENT_AUDIO,
	HUMAN_AUDIO,
	HUMAN_RATE,
	type LogBatch,
	MAX_LOG_EVENTS,
	MAX_LOG_MESSAGE,
	parseRoomFrame,
	type RoomCommand,
	type RoomEvent,
	type RoomMember,
} from "./protocol.ts";
import { isStopCommand, SpeechChunker } from "./speech-text.ts";
import { PendingTranscripts, voiceMessage } from "./transcripts.ts";

/**
 * `preparing`: an answer's speech is asked for and nothing plays yet; `speaking`: the speech stream is open;
 * `talking`: someone else in the room is talking.
 */
export type VoicePhase =
	| "off"
	| "connecting"
	| "listening"
	| "hearing"
	| "thinking"
	| "talking"
	| "preparing"
	| "speaking"
	| "error";

/** The conversation whose voice room this is. */
export type VoiceRoom = { session: string; conversation: number };

/**
 * What voice mode needs of the conversation: its view, and sending (with a request ID kept across retries, so the
 * server admits a message once) and stopping as the owner.
 */
export type VoiceChat = {
	readonly view: Watchable<ConversationView | null>;
	/** Chat mode is on: people talk with each other, Pi answers when addressed (`voiceMessage`). */
	readonly chatMode: boolean;
	/** What people call the agent ("Pi" unless the owner renamed it): "Claude, …" addresses it by voice. */
	readonly agentName: string;
	send(text: string, requestId: string): Promise<unknown>;
	/** Aborts the run (as the Stop button); the caller's queued inputs come back as text. */
	stop(): Promise<{ readonly restored: readonly string[] }>;
};

/** The engine and voice of the speech service (IDs from its `/voices`), the speed, and the language (if it has several). */
export type VoiceSettings = { engine: string; voice: string; speed: number; language?: string };

const targetSttSampleRate = 16000;
/** The room's largest microphone frame: 16000 bytes of PCM16. */
const MAX_MIC_SAMPLES = 8000;
type ExtendedMicAudioConstraints = MediaTrackConstraints & { latency?: ConstrainDouble };
/** pibot's microphone constraints. */
const micAudioConstraints: ExtendedMicAudioConstraints = {
	echoCancellation: { ideal: true },
	noiseSuppression: { ideal: false },
	autoGainControl: { ideal: false },
	channelCount: { ideal: 1 },
	sampleRate: { ideal: 48000 },
	latency: { ideal: 0.02 },
};
/** A sentence whose speech has not ended this long after it was asked for is given up (the room queues them). */
const SPEAK_TIMEOUT_MS = 120_000;
/**
 * How many of the owner's sentences wait in the room at a time; the rest wait here. The room refuses more than 32
 * pending, and an answer committed at once can bring more: each refused sentence was a gap in the speech.
 */
const MAX_IN_ROOM = 8;
/** How long `AudioContext.resume()` may take before the audio counts as blocked (it stays pending without a gesture). */
const RESUME_WAIT_MS = 1500;
/** How long the last transcript and a passing error stay visible. */
const HEARD_MS = 5000;
const ERROR_MS = 8000;
const AUDIO_BLOCKED = "Audio is blocked: tap the orb";
const LOG_FLUSH_MS = 2000;
/** Events kept while the server cannot be reached; older ones are dropped (and counted). */
const LOG_BUFFER = 500;
/** How many answer keys `#skip` and `#silenced` keep: older answers are below the baseline or done anyway. */
const KEPT_ANSWERS = 200;

/** Adds `key` to `set`, dropping the oldest beyond KEPT_ANSWERS (a Set keeps insertion order). */
function remember(set: Set<string>, key: string): void {
	set.delete(key);
	set.add(key);
	for (const old of set) {
		if (set.size <= KEPT_ANSWERS) break;
		set.delete(old);
	}
}

/** An agent answer; `entry` is its entry's ID once committed (the streaming one has none yet). */
export type Answer = { key: string; text: string; done: boolean; closed: boolean; entry?: number };

/**
 * The conversation's agent answers in the view: committed ones, then the one streaming. `closed`: its text so far is
 * complete, since another part (a tool call, thinking) follows it; its last sentence is read without waiting for the
 * answer to end (a tool call's arguments may stream for many seconds).
 */
export function responses(view: ConversationView): Answer[] {
	const out: Answer[] = [];
	const add = (message: AssistantMessage, done: boolean, entry?: number) => {
		const parts = message.content.filter((part) => part.type === "text");
		const text = parts.map((part) => part.text).join("\n");
		const closed = parts.length > 0 && message.content.at(-1)?.type !== "text";
		out.push({ key: String(message.timestamp), text, done, closed, entry });
	};
	for (const entry of view.entries) {
		const message = entry.model?.[0];
		if (message?.role === "assistant") add(message, true, entry.id);
	}
	const live = view.docs["pi.live"] as { run?: unknown; generation?: { message?: AssistantMessage } } | undefined;
	const partial = live?.generation?.message;
	if (partial?.role === "assistant") add(partial, false);
	return out;
}

/** A function, so that TypeScript does not keep a state narrowed across an `await`. */
const isRunning = (context: AudioContext): boolean => context.state === "running";

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** What was there when voice mode started (never read): answers up to this entry, and the one streaming then. */
type Baseline = { entry: number; live: string | undefined };

function baselineOf(view: ConversationView): Baseline {
	let entry = -1;
	for (const record of view.entries) entry = Math.max(entry, record.id);
	return { entry, live: responses(view).find((answer) => !answer.done)?.key };
}

export class VoiceEngine {
	phase: VoicePhase = "off";
	/** Loudness 0..1 of what is heard or said now, for the orb. */
	level = 0;
	error: string | undefined;
	/** The last transcript, for a few seconds after it arrived. */
	heard: string | undefined;
	/** The last error and when it happened (kept after `error` clears, for the settings sheet). */
	lastError: { message: string; at: number } | undefined;
	/** The browser holds the audio back (a suspended AudioContext): a tap on the orb calls `unblock()`. */
	audioBlocked = false;

	readonly #chat: () => VoiceChat | undefined;
	readonly #settings: () => VoiceSettings;
	readonly #onChange: () => void;
	readonly #room: VoiceRoom;
	readonly #producer: () => boolean;
	#running = false;
	#micStream: MediaStream | undefined;
	#micAudioContext: AudioContext | undefined;
	#micSource: MediaStreamAudioSourceNode | undefined;
	#micProcessor: ScriptProcessorNode | undefined;
	#socket: WebSocket | undefined;
	#reconnect: ReturnType<typeof setTimeout> | undefined;
	#wakeLock: WakeLockSentinel | undefined;
	/** The view subscribed to, and how to end the subscription. */
	#view: Watchable<ConversationView | null> | undefined;
	#unsubscribe: (() => void) | undefined;
	#heardTimer: ReturnType<typeof setTimeout> | undefined;
	#errorTimer: ReturnType<typeof setTimeout> | undefined;
	readonly #bargeInDetector = new BargeInDetector(targetSttSampleRate);
	readonly #resampler = new Pcm16kResampler();
	readonly #interruption = new Interruption({
		state: () => {
			const chat = this.#chat();
			return {
				busy: this.#busy,
				speaking: this.#speaking(),
				chatMode: chat?.chatMode ?? false,
				agentName: chat?.agentName,
				said: () => this.#recentAnswers(),
			};
		},
		cutSpeech: () => this.#muteCurrent("barge-in", true),
		stopRun: () => {
			const chat = this.#chat();
			if (chat) this.#transcripts.stopping(chat.stop());
		},
		dropStream: () => {
			this.#bargeInDetector.resetStreaming();
			this.#send({ type: "reset" });
			this.#update();
		},
		log: (message) => this.#log(message),
	});
	/** pibot's `ignoreMicUntil`. */
	#ignoreMicUntil = 0;
	#busy = false;
	#userSpeaking = false;
	/** Answers never to read: those present when voice mode started, finished ones, and those talked over. */
	readonly #skip = new Set<string>();
	readonly #chunkers = new Map<string, SpeechChunker>();
	/** Taken from the view when voice mode starts, or from its first view when it had none then. */
	#baseline: Baseline | undefined;
	/** Utterances asked for (the owner's) or started in the room, and not ended, with their give-up timers. */
	readonly #outstanding = new Map<string, ReturnType<typeof setTimeout>>();
	/** The owner's sentences not yet sent to the room (MAX_IN_ROOM are there), in order. */
	readonly #unsent: { id: string; text: string }[] = [];
	/** Each utterance's sample rate, from its `tts_start`. */
	readonly #rates = new Map<string, number>();
	/** Answers (by key) whose speech this browser no longer plays: talked over, tapped, superseded. */
	readonly #silenced = new Set<string>();
	/** The next sentence number per answer (the owner's utterance IDs). */
	readonly #sentenceIndex = new Map<string, number>();
	/** The room's people, and who of them is talking now. */
	readonly #members = new Map<string, RoomMember>();
	readonly #talking = new Set<string>();
	#me: string | undefined;
	/** The microphone is muted (each start begins unmuted). */
	#muted = false;
	/** This person's pause before an utterance ends (seconds), sent to the room. */
	#pause: number | undefined;
	/** Numbers the samples: a newer one (or closing) drops an older one still being fetched. */
	#samples = 0;
	readonly #playback = new SpeechPlayback({
		log: (message) => this.#log(message),
		setMicInputBlockedUntil: (time) => {
			this.#ignoreMicUntil = time;
		},
		onSpeakingChange: () => this.#update(),
		onPlaybackAudio: (samples, sampleRate) => this.#bargeInDetector.handlePlaybackAudio(samples, sampleRate),
		onLevel: (level) => {
			this.level = level;
		},
		onStalled: (context) => {
			this.#log(`speech stalled: ${this.#describe(context)}`);
			if (this.#running) this.#blockAudio();
		},
		onContextState: (context) => {
			this.#log(`playback context ${this.#describe(context)}`);
			if (this.#running && context.state === "running" && this.audioBlocked) {
				this.audioBlocked = false;
				this.#clearError();
				this.#update();
			}
		},
	});
	readonly #transcripts = new PendingTranscripts({
		target: () => this.#chat(),
		busy: () => this.#busy,
		log: (message) => this.#log(message),
		onError: (message) => this.#report(message),
		onChange: () => this.#update(),
	});
	readonly #onDevices = (): void => void this.#logDevices();
	readonly #client = Math.random().toString(36).slice(2, 8);
	#logs: LogBatch["events"] = [];
	#dropped = 0;
	#logTimer: ReturnType<typeof setTimeout> | undefined;
	#flushing = false;
	readonly #onHide = (): void => {
		if (document.visibilityState === "hidden") this.#flush();
	};

	/**
	 * `chat` is asked for the conversation's current reference each time (it is replaced after a server restart).
	 * `producer`: this browser has the answers read aloud and sets the room's voice (the owner's); everyone else only
	 * hears them.
	 */
	constructor(
		room: VoiceRoom,
		chat: () => VoiceChat | undefined,
		settings: () => VoiceSettings,
		onChange: () => void,
		producer: () => boolean,
	) {
		this.#room = room;
		this.#chat = chat;
		this.#settings = settings;
		this.#onChange = onChange;
		this.#producer = producer;
	}

	/** The people of the room talking now (not this one), by name. */
	get talking(): string[] {
		return [...this.#talking].map((id) => this.#members.get(id)?.name ?? id);
	}

	/** This person's "Pause before sending" (seconds of silence that end an utterance): the room is told. */
	setPause(seconds: number): void {
		this.#pause = seconds;
		this.#sendPause();
	}

	#sendPause(): void {
		if (this.#pause !== undefined) this.#send({ type: "vad", silence: this.#pause });
	}

	/** The room's voice changed (the owner's choice): the room is told. */
	voiceChanged(): void {
		if (this.#producer()) this.#sendConfig();
	}

	get running(): boolean {
		return this.#running;
	}

	/** The microphone is muted: this person stays in the room and hears it, but sends nothing. */
	get muted(): boolean {
		return this.#muted;
	}

	/**
	 * Mutes or unmutes the microphone (voice mode stays on). Muting tells the room to drop what it heard of an
	 * unfinished utterance.
	 */
	setMuted(muted: boolean): void {
		if (muted === this.#muted) return;
		this.#muted = muted;
		this.#log(muted ? "microphone muted" : "microphone unmuted");
		if (muted) {
			this.#send({ type: "reset" });
			this.#bargeInDetector.resetStreaming();
			this.#forgetUtterances();
			this.#userSpeaking = false;
		}
		this.#update();
	}

	/** Transcripts held back until the conversation is reachable again. */
	get waiting(): number {
		return this.#transcripts.waiting;
	}

	/** Starts listening; call from a user gesture (microphone permission, audio playback). */
	async start(): Promise<void> {
		if (this.#running) return;
		this.#running = true;
		this.error = undefined;
		this.audioBlocked = false;
		this.#muted = false;
		this.#set("connecting");
		this.#baseline = undefined;
		this.#skip.clear();
		const view = this.#currentView();
		if (view) this.#prime(view, "at start");
		this.#log(`start: view ${view ? "present" : "absent"}`);
		addEventListener("pagehide", this.#onHide);
		document.addEventListener("visibilitychange", this.#onHide);
		try {
			// pibot's startRecognition.
			const micStream = await navigator.mediaDevices.getUserMedia({ audio: micAudioConstraints, video: false });
			this.#micStream = micStream;
			if (!this.#running) return this.#release();
			const [audioTrack] = micStream.getAudioTracks();
			await audioTrack?.applyConstraints(micAudioConstraints).catch((error: unknown) => {
				this.#log(`mic constraint apply failed: ${messageOf(error)}`);
			});
			const settings = audioTrack?.getSettings();
			if (settings) this.#log(`mic settings: ${JSON.stringify(settings)}`);
			const micAudioContext = new AudioContext();
			this.#micAudioContext = micAudioContext;
			this.#micSource = micAudioContext.createMediaStreamSource(micStream);
			const micProcessor = micAudioContext.createScriptProcessor(1024, 1, 1);
			micProcessor.onaudioprocess = (event) => {
				const input = event.inputBuffer.getChannelData(0);
				this.#microphone(input, event.inputBuffer.sampleRate);
			};
			this.#micSource.connect(micProcessor);
			micProcessor.connect(micAudioContext.destination);
			this.#micProcessor = micProcessor;
			this.#log(`local STT started: browserRate=${micAudioContext.sampleRate} ${this.#describe(micAudioContext)}`);
			// A suspended microphone context stops the microphone (its processor no longer runs).
			micAudioContext.onstatechange = () => {
				this.#log(`mic context ${this.#describe(micAudioContext)}`);
				this.#checkContext(micAudioContext);
			};
			// Where the sound goes (labels are readable once the microphone is allowed), now and on every change.
			void this.#logDevices();
			navigator.mediaDevices.addEventListener("devicechange", this.#onDevices);
			this.#wakeLock = await navigator.wakeLock?.request("screen").catch(() => undefined);
		} catch (error) {
			this.#fail(messageOf(error));
			return;
		}
		if (!this.#running) return;
		this.rebind();
		this.#connect();
		this.#checkContext(this.#micAudioContext);
	}

	stop(): void {
		if (!this.#running) return;
		this.#log("stop");
		this.#running = false;
		this.#transcripts.clear();
		this.#release();
		this.error = undefined;
		this.audioBlocked = false;
		this.#set("off");
		this.#flush();
	}

	/** Follows the conversation's current reference: call when it changes. */
	rebind(): void {
		if (!this.#running) return;
		// What waits goes through the new reference.
		if (this.#transcripts.size > 0) void this.#transcripts.flush();
		const view = this.#chat()?.view;
		if (view === this.#view) return;
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		this.#view = view;
		this.#busy = false;
		this.#log(view ? "conversation attached" : "conversation detached");
		try {
			if (view) this.#unsubscribe = follow(view, (value) => this.#onView(value));
		} catch (error) {
			this.#view = undefined;
			this.#report(`Conversation unavailable: ${messageOf(error)}`);
		}
		this.#update();
	}

	/** Whether an answer is being read (asked for or playing): a tap on the orb then calls `interrupt()`. */
	get reading(): boolean {
		return this.#running && this.#speaking();
	}

	/** Stops reading the answers known so far; voice mode stays on, and the agent keeps working. */
	interrupt(): void {
		if (!this.#speaking()) return;
		this.#log("tapped: speech stopped");
		this.#muteCurrent("tap");
		this.#update();
	}

	/** Resumes blocked audio; call from a user gesture (a tap on the orb). */
	unblock(): void {
		this.#log("unblock tapped");
		for (const context of [this.#playback.existingContext, this.#micAudioContext])
			void context
				?.resume()
				.catch(() => {})
				.then(() => this.#checkContext(context));
	}

	/**
	 * Plays the settings sheet's sample of the current voice in this browser only (POST /voice/sample, not the room,
	 * which everyone hears), cutting what this browser plays now.
	 */
	sample(): void {
		// In the tap: the playback context may start here.
		const context = this.#playback.context();
		void context.resume();
		this.#cancelSpeech("sample", false, false);
		const generation = ++this.#samples;
		void fetch("/voice/sample", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(this.#settings()),
		})
			.then(async (response) => {
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				const buffer = await context.decodeAudioData(await response.arrayBuffer());
				if (generation !== this.#samples || this.#playback.context() !== context) return;
				this.#playback.startPcmStream(buffer.sampleRate);
				this.#playback.pushAudioBuffer(buffer);
				void this.#playback.finishPcmStream();
			})
			.catch((error: unknown) => this.#report(`Sample failed: ${messageOf(error)}`));
	}

	/** Ends samples played without voice mode: closes the playback context. */
	endSamples(): void {
		if (this.#running) return;
		this.#samples++;
		this.#playback.close();
	}

	#release(): void {
		clearTimeout(this.#reconnect);
		clearTimeout(this.#heardTimer);
		clearTimeout(this.#errorTimer);
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		this.#view = undefined;
		this.#socket?.close();
		this.#socket = undefined;
		this.#cancelSpeech("voice mode off");
		this.#playback.close();
		this.#micProcessor?.disconnect();
		this.#micProcessor = undefined;
		this.#micSource?.disconnect();
		this.#micSource = undefined;
		for (const track of this.#micStream?.getTracks() ?? []) track.stop();
		this.#micStream = undefined;
		if (this.#micAudioContext) this.#micAudioContext.onstatechange = null;
		void this.#micAudioContext?.close().catch(() => {});
		this.#micAudioContext = undefined;
		void this.#wakeLock?.release().catch(() => {});
		this.#wakeLock = undefined;
		this.#skip.clear();
		this.#chunkers.clear();
		this.#silenced.clear();
		this.#sentenceIndex.clear();
		this.#members.clear();
		this.#talking.clear();
		this.#baseline = undefined;
		this.#userSpeaking = false;
		this.#busy = false;
		this.#bargeInDetector.resetStreaming();
		this.#interruption.reset();
		this.#resampler.reset();
		this.heard = undefined;
		this.level = 0;
		removeEventListener("pagehide", this.#onHide);
		document.removeEventListener("visibilitychange", this.#onHide);
		navigator.mediaDevices?.removeEventListener("devicechange", this.#onDevices);
	}

	#fail(message: string): void {
		console.error(`[voice] ${message}`);
		this.#log(`failed: ${message}`);
		this.#flush();
		this.#running = false;
		this.#release();
		this.error = message;
		this.lastError = { message, at: Date.now() };
		this.#set("error");
	}

	/** Shows `message` (for a few seconds unless `sticky`) and logs it. */
	#report(message: string, sticky = false): void {
		console.error(`[voice] ${message}`);
		this.#log(`error: ${message}`);
		this.#flush();
		this.error = message;
		this.lastError = { message, at: Date.now() };
		clearTimeout(this.#errorTimer);
		if (!sticky)
			this.#errorTimer = setTimeout(() => {
				if (this.error !== message) return;
				this.error = undefined;
				this.#update();
			}, ERROR_MS);
		this.#update();
	}

	#clearError(): void {
		if (this.audioBlocked) return;
		clearTimeout(this.#errorTimer);
		this.error = undefined;
	}

	/** A context that does not run is resumed if it can be; else the audio counts as blocked. */
	#checkContext(context: AudioContext | undefined): void {
		if (!context || !this.#running) return;
		if (isRunning(context)) {
			if (!this.audioBlocked) return;
			const playback = this.#playback.existingContext;
			if (this.#micAudioContext && !isRunning(this.#micAudioContext)) return;
			if (playback && !isRunning(playback)) return;
			this.audioBlocked = false;
			this.#clearError();
			this.#update();
			return;
		}
		void this.#resume(context).then((running) => {
			if (!running && this.#running) this.#blockAudio();
		});
	}

	/** Whether `context` runs, resuming it if it can (without a gesture `resume()` may stay pending). */
	async #resume(context: AudioContext): Promise<boolean> {
		if (isRunning(context)) return true;
		const started = performance.now();
		let timer: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([
			context.resume().catch(() => {}),
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, RESUME_WAIT_MS);
			}),
		]);
		clearTimeout(timer);
		this.#log(`resume: ${context.state} after ${Math.round(performance.now() - started)} ms`);
		return isRunning(context);
	}

	/** Audio cannot play (or the microphone not run): what is queued is dropped rather than waited for. */
	#blockAudio(): void {
		this.#log("audio blocked");
		this.#cancelSpeech("audio blocked");
		this.audioBlocked = true;
		this.#report(AUDIO_BLOCKED, true);
	}

	#connect(): void {
		const { session, conversation } = this.#room;
		const query = new URLSearchParams({ session, conversation: String(conversation) });
		const socket = new WebSocket(`${location.origin.replace(/^http/, "ws")}/voice/room?${query}`);
		socket.binaryType = "arraybuffer";
		this.#socket = socket;
		socket.onopen = () => {
			this.#log("room socket open");
			this.#update();
		};
		socket.onmessage = (event) => {
			if (this.#socket !== socket) return;
			if (event.data instanceof ArrayBuffer) {
				this.#onAudio(new Uint8Array(event.data));
				return;
			}
			try {
				this.#onEvent(JSON.parse(String(event.data)) as RoomEvent);
			} catch (error) {
				console.error("[voice] bad room event", error);
			}
		};
		socket.onerror = () => {
			if (this.#socket !== socket) return;
			console.error("[voice] speech service socket error");
			this.#log("socket error");
		};
		socket.onclose = (event) => {
			if (this.#socket !== socket || !this.#running) return;
			this.#log(`socket closed: ${event.code} ${event.reason}`);
			this.#socket = undefined;
			this.#userSpeaking = false;
			this.#forgetUtterances();
			this.#bargeInDetector.resetStreaming();
			this.#talking.clear();
			// What the room was saying ends with it (a new socket gets the current utterance in its welcome).
			this.#cancelSpeech("room disconnected", false, false);
			const code = event.code && event.code !== 1000 && event.code !== 1005 ? ` (${event.code})` : "";
			this.#report(`Speech service disconnected${code}; reconnecting`, true);
			this.#reconnect = setTimeout(() => this.#running && this.#connect(), 2000);
		};
	}

	/** Sends `command` to the room (dropped while it is not connected). */
	#send(command: RoomCommand): void {
		if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(JSON.stringify(command));
	}

	/** The owner's voice for the room. */
	#sendConfig(): void {
		const { engine, voice, speed, language } = this.#settings();
		this.#send({
			type: "config",
			...(engine ? { engine } : {}),
			...(voice ? { voice } : {}),
			speed,
			...(language ? { language } : {}),
		});
	}

	/** A binary room frame: the agent's speech, or someone's microphone. */
	#onAudio(frame: Uint8Array): void {
		const audio = parseRoomFrame(frame);
		if (!audio) return;
		if (audio.kind === HUMAN_AUDIO) this.#playback.pushHumanAudio(audio.id, audio.pcm, HUMAN_RATE);
		else if (audio.kind === AGENT_AUDIO && this.#outstanding.has(audio.id) && !this.#isSilenced(audio.id))
			this.#playback.pushPcmAudio(audio.pcm, this.#rates.get(audio.id));
	}

	/** The answer an utterance ID belongs to (`<answer>-<index>`), if it is one of ours. */
	#isSilenced(id: string): boolean {
		const dash = id.lastIndexOf("-");
		return dash > 0 && this.#silenced.has(id.slice(0, dash));
	}

	#onEvent(event: RoomEvent): void {
		if (event.type === "welcome") {
			this.#log(`welcome: room ${event.room} as ${event.you.id}, ${event.members.length} members`);
			this.#clearError();
			this.#me = event.you.id;
			this.#members.clear();
			for (const member of event.members) this.#members.set(member.id, member);
			this.#sendPause();
			if (this.#producer()) this.#sendConfig();
			// Joined mid-utterance: its remaining audio follows.
			if (event.current) this.#onSpeechStart(event.current.id, event.current.sampleRate);
		} else if (event.type === "member_joined" || event.type === "member_updated")
			this.#members.set(event.member.id, event.member);
		else if (event.type === "member_left") {
			this.#members.delete(event.member.id);
			this.#talking.delete(event.member.id);
		} else if (event.type === "config") this.#log(`room voice ${event.engine}/${event.voice} ${event.speed}`);
		else if (event.type === "vad") this.#log(`pause before sending: ${event.silence} s`);
		else if (event.type === "speak_ack") {
			if (event.duplicate) this.#log(`sentence ${event.id}: already said (another tab)`);
		} else if (event.type === "tts_start") this.#onSpeechStart(event.id, event.sampleRate);
		else if (event.type === "tts_done") this.#onSpeechEnd(event.id, event.cancelled ? "cancelled" : "done");
		else if (event.type === "tts_error") {
			this.#report(`Speech failed: ${event.message}`);
			this.#onSpeechEnd(event.id, "failed");
		} else if (event.type === "talking") {
			if (event.participant === this.#me) return;
			if (event.on) this.#talking.add(event.participant);
			else this.#talking.delete(event.participant);
		} else if (event.type === "speech_start") {
			this.#log(`speech_start${this.#speaking() ? " (while speaking)" : ""}`);
			this.#userSpeaking = true;
			this.#interruption.speechStart();
		} else if (event.type === "speech_end") {
			// The next utterance may start before this one's final arrives: speaking follows the VAD, not the finals.
			this.#log("speech_end");
			this.#userSpeaking = false;
		} else if (event.type === "interim") {
			this.#log(`interim: ${event.text.length} chars, decoded in ${event.ms} ms`);
			this.#interruption.interim(event.text);
		} else if (event.type === "error") {
			if (event.id !== undefined) this.#onSpeechEnd(event.id, "failed");
			// Frames over the room's rate are dropped there; worth a log line, not an alarm.
			if (event.code === "mic_rate") this.#log(`room: ${event.message}`);
			else this.#report(event.message);
		} else if (event.type === "final") {
			const text = event.text.trim();
			this.#log(`final: ${text.length} chars, decoded in ${event.ms} ms`);
			// Words, or nothing: noise and the agent's own speech heard back are never sent; a final the next utterance
			// already follows waits for it (interruption.ts).
			const message = this.#interruption.final(text);
			if (message.text) this.#deliver(message.text, message.stopped);
		}
		this.#update();
	}

	/** Forgets the utterances in progress; what was held of them is still this person's message. */
	#forgetUtterances(): void {
		const held = this.#interruption.reset();
		if (held.text) this.#deliver(held.text, held.stopped);
	}

	/** A final transcript with words: a stop command, or this person's message. */
	#deliver(text: string, stopped: boolean): void {
		this.#hear(text);
		// "Stop" whose interim already stopped the agent is still a stop, not a message.
		if (isStopCommand(text) && (stopped || this.#busy || this.#speaking())) {
			this.#log("stop command: stopping");
			this.#muteCurrent("stop command");
			void this.#chat()
				?.stop()
				.then(({ restored }) =>
					this.#log(restored.length > 0 ? `stopped; ${restored.length} queued message(s) withdrawn` : "stopped"),
				)
				.catch((error: unknown) => this.#report(`Stop failed: ${messageOf(error)}`));
			return;
		}
		const chat = this.#chat();
		const message = voiceMessage(text, chat?.chatMode ?? false, chat?.agentName);
		// What Pi was saying is superseded by a message for Pi (in chat mode, people talking with each other leave Pi
		// be).
		if (message.interrupts) this.#muteCurrent("new message");
		// Talking to Pi interrupts, as in a conversation: a busy run is stopped before the first such message (unless
		// its words stopped it already), so it is answered now. Work handed to a doer subagent keeps going.
		this.#transcripts.push(message.text, message.interrupts && !stopped);
	}

	#hear(text: string): void {
		this.heard = text;
		clearTimeout(this.#heardTimer);
		this.#heardTimer = setTimeout(() => {
			this.heard = undefined;
			this.#update();
		}, HEARD_MS);
	}

	/** The phase as pibot's detector knows it (its robot phases). */
	#bargeInPhase(): BargeInPhase {
		return bargeInPhase({
			hearing: this.#userSpeaking || this.#bargeInDetector.isStreaming(),
			playing: this.#playback.speaking,
		});
	}

	/** pibot's sendMicAudio. */
	#microphone(input: Float32Array, sampleRate: number): void {
		// Muted: nothing is sent, and the barge-in detector neither buffers nor listens.
		if (this.#muted) {
			if (!this.#playback.speaking) this.level = 0;
			return;
		}
		if (!this.#playback.speaking) {
			let sum = 0;
			for (const sample of input) sum += sample * sample;
			this.level = Math.min(1, Math.sqrt(sum / input.length) * 8);
		}
		const socket = this.#socket;
		if (!this.#running || socket?.readyState !== WebSocket.OPEN) return;
		const pcm = this.#resampler.push(input, sampleRate);
		this.#interruption.tick();
		const phase = this.#bargeInPhase();
		const barge = this.#bargeInDetector.observeMic(input, sampleRate, pcm, phase, this.#playback.speaking);
		if (barge.triggered) {
			const metrics = barge.metrics
				? ` rms=${barge.metrics.micRms.toFixed(4)} residual=${barge.metrics.residualRatio.toFixed(3)}`
				: "";
			this.#log(`barge-in during ${phase}: metrics${metrics}`);
			this.#startBargeInStream(socket, barge.preroll ?? new Int16Array());
			return;
		}
		if (
			this.#bargeInDetector.isStreaming() ||
			(Date.now() >= this.#ignoreMicUntil && this.#bargeInDetector.shouldStreamMicNormally(phase))
		)
			socket.send(pcm);
	}

	/**
	 * pibot's startBargeInStream, except that nothing stops yet: the speaker streams from a second before while the
	 * agent goes on speaking, and only words the room hears interrupt (interruption.ts).
	 */
	#startBargeInStream(socket: WebSocket, preroll: Int16Array): void {
		this.#interruption.trigger();
		this.#ignoreMicUntil = 0;
		// The room takes microphone frames of at most 16000 bytes: the second of preroll goes in parts.
		for (let at = 0; at < preroll.length; at += MAX_MIC_SAMPLES)
			socket.send(preroll.slice(at, Math.min(preroll.length, at + MAX_MIC_SAMPLES)));
		this.#log("barge-in candidate: forwarded mic preroll");
		this.#update();
	}

	/** The text of the latest answers, which the agent may be saying now (to tell its echo from the speaker). */
	#recentAnswers(): string[] {
		const view = this.#currentView();
		return view
			? responses(view)
					.slice(-2)
					.map((answer) => answer.text)
			: [];
	}

	#onView(view: ConversationView | null): void {
		if (!view) return;
		const live = view.docs["pi.live"] as { run?: unknown } | undefined;
		this.#busy = Boolean(live?.run);
		// Only answers that start after voice mode did are read, and only by the owner's browser (the room says them).
		if (!this.#baseline) this.#prime(view, "on the first view");
		if (!this.#producer()) {
			this.#update();
			return;
		}
		const baseline = this.#baseline;
		for (const answer of responses(view)) {
			if (this.#skip.has(answer.key)) continue;
			if (
				baseline &&
				(answer.key === baseline.live || (answer.entry !== undefined && answer.entry <= baseline.entry))
			) {
				remember(this.#skip, answer.key);
				continue;
			}
			let chunker = this.#chunkers.get(answer.key);
			if (!chunker) {
				chunker = new SpeechChunker();
				this.#chunkers.set(answer.key, chunker);
				this.#log(`answer ${answer.key}: new${answer.entry === undefined ? "" : ` (entry ${answer.entry})`}`);
			}
			const sentences = chunker.push(answer.text, answer.done || answer.closed);
			if (this.#producer()) for (const sentence of sentences) this.#enqueue(answer.key, sentence);
			if (sentences.length > 0 || answer.done)
				this.#log(`answer ${answer.key}: ${sentences.length} sentences queued${answer.done ? ", done" : ""}`);
			if (answer.done) {
				this.#chunkers.delete(answer.key);
				this.#sentenceIndex.delete(answer.key);
				remember(this.#skip, answer.key);
			}
		}
		this.#endStreamWhenDone();
		this.#update();
	}

	#prime(view: ConversationView, when: string): void {
		const baseline = baselineOf(view);
		this.#baseline = baseline;
		const old = responses(view).length;
		this.#log(
			`primed ${when}: ${old} answers present, up to entry ${baseline.entry}${baseline.live ? `, streaming ${baseline.live}` : ""}`,
		);
	}

	#currentView(): ConversationView | null {
		try {
			return this.#chat()?.view.value ?? null;
		} catch {
			// The reference is not live.
			return null;
		}
	}

	/** Stops reading, and never reads the rest of the answers known so far. */
	#muteCurrent(reason: string, bargeIn = false): void {
		if (this.#speaking() || this.#chunkers.size > 0)
			this.#log(`muted (${reason}): ${[...this.#chunkers.keys()].join(", ") || "the queue"}`);
		for (const key of this.#chunkers.keys()) {
			remember(this.#skip, key);
			remember(this.#silenced, key);
		}
		this.#chunkers.clear();
		let view: ConversationView | null = null;
		try {
			view = this.#view?.value ?? null;
		} catch {
			// The reference ended; its answers are skipped once it is back (they are known by then).
		}
		for (const answer of view ? responses(view) : []) {
			remember(this.#skip, answer.key);
			remember(this.#silenced, answer.key);
		}
		// What plays now, too (a guest may not know its answer yet).
		for (const id of this.#outstanding.keys()) {
			const dash = id.lastIndexOf("-");
			if (dash > 0) remember(this.#silenced, id.slice(0, dash));
		}
		this.#cancelSpeech(reason, bargeIn);
	}

	#speaking(): boolean {
		return this.#playback.speaking || this.#outstanding.size > 0 || this.#unsent.length > 0;
	}

	/** Has the room say the `answer`'s next sentence (the owner's), under its stable ID. */
	#enqueue(answer: string, text: string): void {
		const index = this.#sentenceIndex.get(answer) ?? 0;
		this.#sentenceIndex.set(answer, index + 1);
		const id = `${answer}-${index}`;
		// The room drops commands while it reconnects: a sentence asked for then is lost, not waited for (120 s).
		if (this.#socket?.readyState !== WebSocket.OPEN) {
			this.#log(`sentence ${id}: room not connected, skipped`);
			return;
		}
		this.#unsent.push({ id, text });
		this.#sendSentences();
		this.#update();
	}

	/** Sends waiting sentences while the room holds fewer than MAX_IN_ROOM of them. */
	#sendSentences(): void {
		while (this.#outstanding.size < MAX_IN_ROOM) {
			const next = this.#unsent.shift();
			if (!next) return;
			const { id, text } = next;
			this.#expect(id);
			this.#send({ type: "speak", id, text });
			this.#log(`sentence ${id}: ${text.length} chars, asked`);
		}
	}

	/** An utterance to wait for (asked, or started in the room), given up if it never ends. */
	#expect(id: string): void {
		if (this.#outstanding.has(id)) return;
		this.#outstanding.set(
			id,
			setTimeout(() => {
				if (!this.#outstanding.has(id)) return;
				this.#log(`sentence ${id}: never ended; given up`);
				this.#onSpeechEnd(id, "failed");
			}, SPEAK_TIMEOUT_MS),
		);
	}

	#onSpeechStart(id: string, sampleRate: number): void {
		if (this.#isSilenced(id)) return;
		this.#expect(id);
		this.#rates.set(id, sampleRate);
		this.#log(`sentence ${id}: start ${sampleRate} Hz`);
		if (!this.#playback.speaking) this.#playback.startPcmStream(sampleRate);
		this.#update();
	}

	#onSpeechEnd(id: string, result: "done" | "cancelled" | "failed"): void {
		clearTimeout(this.#outstanding.get(id));
		if (!this.#outstanding.delete(id)) return;
		this.#rates.delete(id);
		this.#log(`sentence ${id}: ${result}`);
		if (this.#socket?.readyState === WebSocket.OPEN) this.#sendSentences();
		this.#endStreamWhenDone();
		this.#update();
	}

	/** Nothing more to say for now (no utterance pending, no answer still streaming): the stream ends as it plays out. */
	#endStreamWhenDone(): void {
		if (this.#outstanding.size > 0 || this.#unsent.length > 0 || this.#chunkers.size > 0 || !this.#playback.speaking)
			return;
		void this.#playback.finishPcmStream();
	}

	/**
	 * pibot's cancelSpeech (and cancelSpeechForBargeIn): drops what is pending and what plays. The owner's also cancels
	 * the room's (everyone stops hearing it), unless only this browser's playback ends (`room` false).
	 */
	#cancelSpeech(reason: string, bargeIn = false, room = true): void {
		if (room && this.#producer() && this.#outstanding.size > 0) this.#send({ type: "cancel" });
		for (const timer of this.#outstanding.values()) clearTimeout(timer);
		this.#outstanding.clear();
		this.#unsent.length = 0;
		this.#rates.clear();
		if (bargeIn) this.#playback.cancelSpeechForBargeIn();
		else this.#playback.cancelSpeech(reason);
	}

	/** The audio devices by label (never their IDs), and the output the playback context uses where the browser says. */
	async #logDevices(): Promise<void> {
		try {
			const devices = await navigator.mediaDevices.enumerateDevices();
			const labels = (kind: MediaDeviceKind) =>
				devices
					.filter((device) => device.kind === kind)
					.map((device) => device.label || "(no label)")
					.join(" | ") || "none listed";
			const context = this.#playback.existingContext as (AudioContext & { sinkId?: unknown }) | undefined;
			const sink = !context
				? "no playback context yet"
				: !("sinkId" in context)
					? "sinkId not exposed"
					: context.sinkId === ""
						? "sinkId default"
						: typeof context.sinkId === "string"
							? "sinkId chosen device"
							: "sinkId none";
			this.#log(`devices: outputs ${labels("audiooutput")}; inputs ${labels("audioinput")}; ${sink}`);
		} catch (error) {
			this.#log(`devices unknown: ${messageOf(error)}`);
		}
	}

	#describe(context: AudioContext): string {
		const latency = (seconds: number | undefined) => (seconds === undefined ? "?" : Math.round(seconds * 1000));
		return `${context.state} ${context.sampleRate} Hz, latency ${latency(context.baseLatency)}+${latency(context.outputLatency)} ms`;
	}

	/** A diagnostic event for the server's log (sent within 2 s, at once after an error). */
	#log(message: string): void {
		console.debug(`[voice] ${message}`);
		this.#logs.push({ t: Date.now(), message: message.slice(0, MAX_LOG_MESSAGE) });
		if (this.#logs.length > LOG_BUFFER) this.#dropped += this.#logs.splice(0, this.#logs.length - LOG_BUFFER).length;
		this.#logTimer ??= setTimeout(() => this.#flush(), LOG_FLUSH_MS);
	}

	#flush(): void {
		clearTimeout(this.#logTimer);
		this.#logTimer = undefined;
		if (this.#flushing || this.#logs.length === 0) return;
		if (this.#dropped > 0) {
			this.#logs.unshift({ t: Date.now(), message: `${this.#dropped} earlier events dropped` });
			this.#dropped = 0;
		}
		const events = this.#logs.splice(0, MAX_LOG_EVENTS);
		const body: LogBatch = { client: this.#client, events };
		this.#flushing = true;
		// `keepalive`: a batch sent as the page goes away still arrives.
		void fetch("/voice/log", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			keepalive: true,
		})
			.then((response) => {
				// A refusal is final; a server error is tried again.
				if (response.status >= 500) throw new Error(`HTTP ${response.status}`);
				if (!response.ok) console.debug(`[voice] log refused (HTTP ${response.status})`);
			})
			.catch((error: unknown) => {
				console.debug("[voice] log not sent", error);
				// Kept for the next try (the server may be restarting).
				this.#logs.unshift(...events);
			})
			.finally(() => {
				this.#flushing = false;
				if (this.#logs.length > 0) this.#logTimer ??= setTimeout(() => this.#flush(), LOG_FLUSH_MS);
			});
	}

	#update(): void {
		if (!this.#running) return;
		const phase: VoicePhase =
			this.#socket?.readyState !== WebSocket.OPEN
				? "connecting"
				: this.#playback.speaking
					? "speaking"
					: this.#userSpeaking
						? "hearing"
						: this.#outstanding.size > 0
							? "preparing"
							: this.#talking.size > 0
								? "talking"
								: this.#busy
									? "thinking"
									: "listening";
		// pibot: the detector's barge-in stream ends when the phase leaves "hearing".
		// A barge-in candidate streams while the agent speaks, until words confirm it or it is dropped.
		if (phase !== "hearing" && !this.#userSpeaking && !this.#interruption.pending)
			this.#bargeInDetector.resetStreaming();
		this.#set(phase);
	}

	#set(phase: VoicePhase): void {
		this.phase = phase;
		this.#onChange();
	}
}
