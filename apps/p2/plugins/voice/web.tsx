// Voice mode in the browser. In the composer only a microphone: on, it is an orb that shows what voice mode does
// (listening, hearing you, the agent working, preparing speech, speaking) and pulses with the sound; a tap stops the
// speech while an answer is read, else turns voice mode off. An error is a dot on the orb (its text in the orb's label
// and in the settings). The settings are the owner's, in the sidebar's footer: the Voice sheet (engine, voice, speed,
// kept in the conversation; this browser's last choice for conversations without one), with voice mode's state on top.
// A read/write guest talks (its transcripts are its own messages) but hears nothing yet: the answers are read aloud only
// in the owner's browser. View-only guests have no voice mode. Only when the server has a speech service (voice.json).

import { BACKGROUND_CONTEXT, contribute, defineFacet, type HeldIn, liveIn } from "@p2/app/v1";
import {
	CheckIcon,
	closeLayers,
	SettingsSections,
	Sheet,
	Slots,
	useCanWrite,
	useComposerState,
	useObject,
	useOptimisticCall,
	useOwner,
	useReadable,
	useRoute,
	useSheet,
} from "@p2/app/v1/web";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Chat } from "../chat/contract.ts";
import { ChatMode, DEFAULT_AGENT_NAME } from "../chat-mode/contract.ts";
import { engineLabel, languagesOf, resolved, resolveVoice } from "./choice.ts";
import { VoiceMode, VoiceService } from "./contract.ts";
import { VoiceEngine, type VoicePhase, type VoiceSettings } from "./engine.ts";
import { DEFAULT_PAUSE, MAX_PAUSE, MIN_PAUSE, type Voices as VoiceConfig } from "./protocol.ts";
import "./style.css";

const SETTINGS_KEY = "p2.voice";

function loadSettings(): VoiceSettings {
	try {
		const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") as Partial<VoiceSettings>;
		return {
			engine: typeof stored.engine === "string" ? stored.engine : "",
			voice: typeof stored.voice === "string" ? stored.voice : "",
			speed: typeof stored.speed === "number" && stored.speed >= 0.5 && stored.speed <= 2 ? stored.speed : 1.05,
			...(typeof stored.language === "string" ? { language: stored.language } : {}),
		};
	} catch {
		return { engine: "", voice: "", speed: 1.05 };
	}
}

/**
 * The owner's last choice on this browser (localStorage): what a conversation without a voice of its own starts with.
 * The conversation's choice (VoiceMode's `voice`) wins. Shared by the composer and the sheet.
 */
const stored = {
	value: loadSettings(),
	listeners: new Set<() => void>(),
	set(next: VoiceSettings): void {
		stored.value = next;
		localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
		for (const listener of stored.listeners) listener();
	},
	subscribe(listener: () => void): () => void {
		stored.listeners.add(listener);
		return () => {
			stored.listeners.delete(listener);
		};
	},
};
const useStored = () => useSyncExternalStore(stored.subscribe, () => stored.value);

const PAUSE_KEY = "p2.voice.pause";
/**
 * This person's "Pause before sending": seconds of silence that end an utterance (localStorage). Personal, unlike the
 * voice: the owner and each guest set their own.
 */
const pause = {
	value: ((): number => {
		const stored = Number(localStorage.getItem(PAUSE_KEY));
		return Number.isFinite(stored) && stored >= MIN_PAUSE && stored <= MAX_PAUSE ? stored : DEFAULT_PAUSE;
	})(),
	listeners: new Set<() => void>(),
	set(seconds: number): void {
		pause.value = seconds;
		localStorage.setItem(PAUSE_KEY, String(seconds));
		for (const listener of pause.listeners) listener();
	},
	subscribe(listener: () => void): () => void {
		pause.listeners.add(listener);
		return () => {
			pause.listeners.delete(listener);
		};
	},
};
const usePause = () => useSyncExternalStore(pause.subscribe, () => pause.value);

/** A language's name in itself ("Deutsch" for "de"); the tag where the browser has none. */
function ownName(language: string): string {
	try {
		return new Intl.DisplayNames([language], { type: "language" }).of(language) ?? language;
	} catch {
		return language;
	}
}

const NO_INPUT = {};
/**
 * The server's speech service: its engines and default, or undefined while voice mode is not configured. Pushed by
 * the server (VoiceService), so writing or removing voice.json shows or hides the button at once.
 */
function useVoiceConfig(allowed: boolean): VoiceConfig | undefined {
	const service = useObject(VoiceService, allowed ? NO_INPUT : undefined);
	return useReadable(service?.voices) ?? undefined;
}

/** The composer's engine of the conversation shown (for the sheet's state and samples); none on other pages. */
/**
 * The conversations whose voice mode is on in this page (`session#conversation`). Leaving a conversation's page (to a
 * subagent, home, another session) suspends its voice mode: the microphone, the room and the audio are released, the
 * conversation's switch (VoiceMode) stays on. Coming back starts it again. Only a tap turning it off forgets it; closing
 * the page forgets everything.
 */
const remembered = new Set<string>();

const shown = {
	engine: undefined as VoiceEngine | undefined,
	listeners: new Set<() => void>(),
	set(engine: VoiceEngine | undefined): void {
		shown.engine = engine;
		shown.changed();
	},
	changed(): void {
		for (const listener of shown.listeners) listener();
	},
	subscribe(listener: () => void): () => void {
		shown.listeners.add(listener);
		return () => {
			shown.listeners.delete(listener);
		};
	},
};

const LABELS: Record<VoicePhase, string> = {
	off: "Voice mode",
	connecting: "Connecting",
	listening: "Listening",
	hearing: "Hearing you",
	thinking: "Working",
	talking: "Someone is talking",
	preparing: "Preparing speech",
	speaking: "Playing",
	error: "Voice error",
};

/** A microphone; `muted`: struck through. */
function MicIcon({ muted = false, size = 18 }: { muted?: boolean; size?: number }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			aria-hidden="true"
		>
			<rect x="9" y="3" width="6" height="11" rx="3" />
			<path d="M5 11a7 7 0 0 0 14 0M12 18v3" strokeLinecap="round" />
			{muted && <path d="M4 3l16 18" strokeLinecap="round" />}
		</svg>
	);
}

/**
 * Whether this browser may use voice mode in the open session: the owner, or a guest with full access to it (a
 * view-only guest only reads).
 */
function useTalker(): { owner: boolean; talker: boolean } {
	return { owner: useOwner(), talker: useCanWrite(useRoute().session) };
}

/** The voice mode switch of a conversation (the owner's variant or a guest's) and its shared voice. */
function useVoiceMode(input: { session: string; conversation: number } | undefined) {
	const mode = useObject(VoiceMode, input);
	const ownerMode = liveIn(mode, "owner");
	const guestMode = liveIn(mode, "participant");
	const voice = useReadable(ownerMode?.voice ?? guestMode?.voice) ?? undefined;
	const set = useMemo(
		() =>
			ownerMode
				? (enabled: boolean) => ownerMode.set({ enabled }, BACKGROUND_CONTEXT)
				: guestMode
					? (enabled: boolean) => guestMode.set({ enabled }, BACKGROUND_CONTEXT)
					: undefined,
		[ownerMode, guestMode],
	);
	return { ownerMode, voice: voice ?? undefined, set };
}

function VoiceChip() {
	const { owner, talker } = useTalker();
	const config = useVoiceConfig(talker);
	const { session, conversation = 1 } = useRoute();
	const input = useMemo(
		() => (session && talker ? { session, conversation } : undefined),
		[session, conversation, talker],
	);
	const [, setTick] = useState(0);
	const configRef = useRef(config);
	configRef.current = config;
	const ownerRef = useRef(owner);
	ownerRef.current = owner;
	const chatRef = useRef<HeldIn<typeof Chat, "participant">>(undefined);
	const chatModeRef = useRef({ enabled: false, name: DEFAULT_AGENT_NAME });
	const orb = useRef<HTMLSpanElement>(null);
	const settingsRef = useRef<VoiceSettings>(stored.value);

	// One engine per conversation. It asks for the conversation's current reference, which is replaced after a server
	// restart; leaving the conversation suspends its voice mode (`remembered`), closing the page ends it.
	const engine = useMemo(() => {
		if (!input) return undefined;
		return new VoiceEngine(
			input,
			() => {
				const chat = chatRef.current;
				return (
					chat && {
						view: chat.view,
						chatMode: chatModeRef.current.enabled,
						agentName: chatModeRef.current.name,
						send: (text, requestId) => chat.send({ text, requestId }, BACKGROUND_CONTEXT),
						stop: () => chat.stop(BACKGROUND_CONTEXT),
					}
				);
			},
			() => resolved(configRef.current, settingsRef.current),
			() => {
				setTick((tick) => tick + 1);
				shown.changed();
			},
			// The owner's browser has the answers said in the room and sets its voice; everyone hears them.
			() => ownerRef.current,
		);
	}, [input]);
	const key = input ? `${input.session}#${input.conversation}` : undefined;
	useEffect(() => {
		shown.set(engine);
		// Back on a conversation whose voice mode was on: it starts again (blocked audio asks for a tap on the orb).
		if (engine && key && remembered.has(key) && !engine.running) void engine.start();
		return () => {
			if (shown.engine === engine) shown.set(undefined);
			// Leaving the conversation suspends its voice mode; it stays remembered and switched on.
			if (engine?.running) engine.stop();
		};
	}, [engine, key]);
	const chat = useObject(Chat, input, { variant: "participant" });
	const { voice: shared, set: setMode } = useVoiceMode(input);
	const chatMode = useObject(ChatMode, input);
	chatModeRef.current = {
		enabled: useReadable(chatMode?.enabled) ?? false,
		name: useReadable(chatMode?.name) ?? DEFAULT_AGENT_NAME,
	};
	chatRef.current = chat;
	// biome-ignore lint/correctness/useExhaustiveDependencies: the engine reads the new reference through chatRef.
	useEffect(() => engine?.rebind(), [engine, chat]);
	// A guest's switch lives with its object, which a suspended voice mode let go: on again once it is back.
	useEffect(() => {
		if (!owner && key && remembered.has(key)) void setMode?.(true).catch(() => {});
	}, [setMode, owner, key]);
	// The conversation's voice, else (for the owner) this browser's last choice; the service's default fills the rest.
	const mine = useStored();
	settingsRef.current = shared ?? mine;
	const {
		engine: wantedEngine,
		voice: wantedVoice,
		speed: wantedSpeed,
		language: wantedLanguage,
	} = settingsRef.current;
	// This person's pause reaches the room (again after each welcome: the engine keeps it).
	const seconds = usePause();
	useEffect(() => engine?.setPause(seconds), [engine, seconds]);
	// The owner's change of voice reaches the room.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the engine reads the settings through settingsRef.
	useEffect(() => engine?.voiceChanged(), [engine, wantedEngine, wantedVoice, wantedSpeed, wantedLanguage, config]);

	const phase = engine?.phase ?? "off";
	const on = engine?.running ?? false;
	// The orb follows the sound frame by frame, outside React.
	useEffect(() => {
		if (!on || !engine) return;
		let frame = requestAnimationFrame(function draw() {
			const loud = engine.phase === "hearing" || engine.phase === "speaking" || engine.phase === "listening";
			orb.current?.style.setProperty("--level", (loud ? engine.level : 0).toFixed(3));
			frame = requestAnimationFrame(draw);
		});
		return () => cancelAnimationFrame(frame);
	}, [on, engine]);

	const toggle = useCallback(() => {
		if (!engine) return;
		// The tap the blocked audio waits for.
		if (engine.running && engine.audioBlocked) {
			engine.unblock();
			return;
		}
		// While an answer is read, a tap stops only that; another turns voice mode off.
		if (engine.reading) {
			engine.interrupt();
			return;
		}
		const enabled = !engine.running;
		if (key) {
			if (enabled) remembered.add(key);
			else remembered.delete(key);
		}
		if (enabled) void engine.start();
		else engine.stop();
		void setMode?.(enabled).catch((error: unknown) => console.error("[voice]", error));
	}, [engine, setMode, key]);

	if (!talker || !config || !engine) return null;
	const error = engine.error;
	const waiting = engine.waiting;
	const state =
		waiting > 0
			? `Waiting to reconnect (${waiting} ${waiting === 1 ? "message" : "messages"})`
			: phase === "talking"
				? `${engine.talking.join(", ")} talking`
				: LABELS[phase];
	const muted = engine.muted;
	const title = `${error ? `${state}: ${error}` : state}${on && muted ? " (microphone muted)" : ""}`;
	return (
		<>
			<button
				type="button"
				className={`chip toggle voice-chip ${on ? "on" : ""}`}
				aria-pressed={on}
				aria-label={
					!on
						? error
							? `Voice error: ${error}. Turn voice mode on`
							: "Turn voice mode on"
						: engine.reading
							? `${title}. Stop speaking`
							: `${title}. Turn voice mode off`
				}
				title={title}
				onClick={toggle}
			>
				{on ? <span ref={orb} className={`voice-orb ${phase}`} /> : <MicIcon />}
				{(error || phase === "error") && <span className="voice-error-dot" aria-hidden="true" />}
			</button>
			{on && (
				// Muted: still in the room, hearing everyone, sending nothing.
				<button
					type="button"
					className={`chip toggle voice-mute ${muted ? "on" : ""}`}
					aria-pressed={muted}
					aria-label={muted ? "Microphone muted. Unmute" : "Mute microphone"}
					title={muted ? "Microphone muted" : "Mute microphone"}
					onClick={() => engine.setMuted(!muted)}
				>
					<MicIcon muted={muted} size={16} />
				</button>
			)}
		</>
	);
}

/**
 * The Voice sheet, laid out as the model picker: state, pause and speed on top, each engine's voices under its name. A
 * guest's has the state and its own pause only (the voice is the owner's).
 */
function VoiceSheet({ config, owner, onClose }: { config: VoiceConfig; owner: boolean; onClose: () => void }) {
	const { session, conversation = 1 } = useRoute();
	const input = useMemo(() => (session ? { session, conversation } : undefined), [session, conversation]);
	const { ownerMode, voice: shared } = useVoiceMode(input);
	const engine = useSyncExternalStore(shown.subscribe, () => shown.engine);
	const [, setTick] = useState(0);
	useEffect(() => shown.subscribe(() => setTick((tick) => tick + 1)), []);
	const mine = useStored();
	// The owner's choice shows at once; a refused one goes back with the error in the toast.
	const [settings, choose] = useOptimisticCall(
		shared ?? mine,
		(_, next: VoiceSettings) => next,
		useComposerState().fail,
	);
	const { engine: ttsEngine, voice, language } = resolveVoice(config, settings);
	const languages = languagesOf(ttsEngine);
	const voiceName = ttsEngine?.voices.find((option) => option.id === voice)?.name ?? voice;
	// The language by the service's name for it, else by its own (an engine that lists none speaks the default).
	const languageName =
		languages.find((option) => option.id === language)?.name ?? ownName(language ?? config.default.language ?? "en");
	const chosen = useRef<HTMLButtonElement>(null);
	// The chosen row in view (Pocket alone lists 21 voices), once the sheet is laid out (it opens animated).
	useEffect(() => {
		const frame = requestAnimationFrame(() =>
			requestAnimationFrame(() => chosen.current?.scrollIntoView({ block: "center" })),
		);
		return () => cancelAnimationFrame(frame);
	}, []);
	// Engines that speak more than English, for the hint when the chosen one does not.
	const multilingual = config.engines.filter((option) => (option.languages?.length ?? 0) > 1);
	// Samples play in this browser only, through an engine of the sheet's own (the room is everyone's).
	const sampling = useRef(settings);
	const sampler = useMemo(
		() =>
			new VoiceEngine(
				{ session: "", conversation: 0 },
				() => undefined,
				() => resolved(config, sampling.current),
				() => {},
				() => false,
			),
		[config],
	);
	useEffect(() => () => sampler.endSamples(), [sampler]);

	/** The owner's choice: the conversation's voice (what everyone hears), and this browser's default for the next. */
	const update = (change: Partial<VoiceSettings>) => {
		const next = resolved(config, { ...settings, ...change });
		sampling.current = next;
		stored.set(next);
		if (ownerMode) choose(next, () => ownerMode.choose(next, BACKGROUND_CONTEXT));
	};
	const sample = () => sampler.sample();

	const seconds = usePause();
	const phase = engine?.phase ?? "off";
	const state = engine?.running ? LABELS[phase] : "Voice mode off";
	const last = engine?.lastError;
	const top = (
		<>
			<p className="muted small voice-state">
				{state}
				{last && (
					<span className="voice-last-error">
						{" · "}Last error {new Date(last.at).toLocaleTimeString()}: {last.message}
					</span>
				)}
				{owner && !input && " · Choices apply to new conversations"}
			</p>
			<label className="field voice-speed">
				<span className="label">
					Pause before sending<span className="voice-speed-value">{seconds.toFixed(1)} s</span>
				</span>
				<input
					type="range"
					min={MIN_PAUSE}
					max={MAX_PAUSE}
					step="0.1"
					value={seconds}
					aria-label="Pause before sending"
					onChange={(event) => pause.set(Number(event.target.value))}
				/>
			</label>
		</>
	);
	if (!owner)
		return (
			<Sheet title="Voice" onClose={onClose} className="voice-sheet">
				{top}
				<p className="muted small voice-shared">
					Voice: {voiceName}
					{languages.length > 1 && languageName ? ` · ${languageName}` : ""} (the owner's)
				</p>
				<p className="muted small">How long you can pause before what you said is sent.</p>
			</Sheet>
		);
	return (
		<Sheet title="Voice" onClose={onClose} className="voice-sheet">
			<div className="sheet-sticky">
				{top}
				{/* The choice in words (the chosen row may be far down the list), and the language beside it. */}
				<div className="voice-choice">
					<p className="small">
						{ttsEngine ? `${engineLabel(ttsEngine)} · ` : ""}
						{voiceName}
						{languages.length <= 1 && ` · ${languageName}`}
						{languages.length <= 1 && multilingual.length > 0 && (
							<span className="muted">
								{" "}
								(other languages: a {multilingual.map((option) => engineLabel(option)).join(" or ")} voice)
							</span>
						)}
					</p>
					{languages.length > 1 && (
						<select
							className="input voice-language"
							aria-label="Language"
							value={language ?? ""}
							onChange={(event) => {
								update({ language: event.target.value });
								sample();
							}}
						>
							{languages.map((option) => (
								<option key={option.id} value={option.id}>
									{option.name}
								</option>
							))}
						</select>
					)}
				</div>
				<label className="field voice-speed">
					<span className="label">
						Speed<span className="voice-speed-value">{settings.speed.toFixed(2)}×</span>
					</span>
					<input
						type="range"
						min="0.8"
						max="1.5"
						step="0.05"
						value={settings.speed}
						aria-label="Speed"
						onChange={(event) => update({ speed: Number(event.target.value) })}
					/>
				</label>
			</div>
			<div className="model-list voice-list">
				{config.engines.map((option) => (
					<section key={option.id}>
						<h3 title={option.name}>{engineLabel(option)}</h3>
						{option.voices.map((choice) => {
							const selected = option.id === ttsEngine?.id && choice.id === voice;
							return (
								<button
									type="button"
									key={choice.id}
									aria-pressed={selected}
									ref={selected ? chosen : undefined}
									className={`model-row ${selected ? "selected" : ""}`}
									onClick={() => {
										update({ engine: option.id, voice: choice.id });
										sample();
									}}
								>
									<span>
										<strong>{choice.name}</strong>
										<small>{choice.id}</small>
									</span>
									{selected && <CheckIcon />}
								</button>
							);
						})}
					</section>
				))}
			</div>
			<p className="muted small">Tap a voice, or choose a language, to hear it.</p>
		</Sheet>
	);
}

/**
 * The Voice sheet while it is open, when the server has a speech service: the owner's whole sheet, a read/write
 * guest's own pause.
 */
function VoiceSheetSlot() {
	const { owner, talker } = useTalker();
	const config = useVoiceConfig(talker);
	const sheet = useSheet("voice");
	return talker && config && sheet ? <VoiceSheet config={config} owner={owner} onClose={closeLayers} /> : null;
}

/** Settings' Voice section while the server has a speech service. */
function VoiceShown({ children }: { children: ReactNode }) {
	const { talker } = useTalker();
	return useVoiceConfig(talker) ? children : null;
}

export default defineFacet((host) => {
	contribute(host, "p2.voice-web", (self) => {
		self.contribute(SettingsSections, {
			voice: {
				label: "Voice",
				title: "Voice mode's voice, speed and pause",
				order: 70,
				Sheet: VoiceSheetSlot,
				Shown: VoiceShown,
			},
		});
		self.contribute(Slots, {
			"composer:voice": VoiceChip,
		});
	});
});
