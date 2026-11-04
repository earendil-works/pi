import { arr, bool, num, obj, opt, type Static, str, union } from "@earendil-works/pi-schema";
import { literal } from "@p2/app/v1";
// Voice mode's wire shapes, shared by the server routes and the browser.

/** The longest text one speech request synthesizes: the browser sends a sentence or two at a time. */
export const MAX_SPEAK_TEXT = 2000;

const Id = str({ pattern: "^[A-Za-z0-9_-]{1,64}$" });

/** A text-to-speech engine of the speech service (`GET /voices` there); voice IDs are per engine. */
/** A language: the service's lowercase ISO 639-1 code ("en", "de"); a BCP 47 tag is accepted too ("pt-BR"). */
export const LanguageSchema = str({ pattern: "^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$" });

export const TtsEngineSchema = obj({
	id: Id,
	name: str(),
	/** It sends audio as it is synthesized (rather than a sentence at a time). */
	streaming: bool(),
	sampleRate: num(),
	voices: arr(obj({ id: Id, name: str() })),
	/** The languages it speaks, by their own names ("Deutsch"); absent from a service without languages. */
	languages: opt(arr(obj({ id: LanguageSchema, name: str() }))),
	defaultLanguage: opt(LanguageSchema),
});
export type TtsEngine = Static<typeof TtsEngineSchema>;

/** The speech service's `GET /voices`. */
export const VoicesSchema = obj(
	{
		engines: arr(TtsEngineSchema),
		default: obj({ engine: Id, voice: Id, language: opt(LanguageSchema) }, { open: true }),
	},
	{ open: true },
);
export type Voices = Static<typeof VoicesSchema>;

/**
 * `WS /voice/room?session=…&conversation=…` (bridged to the service's `/room`): what a browser may send as text.
 * Everyone: `reset` (its own microphone's VAD) and `vad` (its own pause before an utterance ends). The owner also the
 * room's voice (`config`), what Pi says (`speak`, with a stable ID: repeats from other tabs are the service's
 * duplicates) and `cancel`. Microphone audio goes up as binary 16 kHz PCM16.
 */
export const MIN_PAUSE = 0.5;
export const MAX_PAUSE = 2;
export const DEFAULT_PAUSE = 0.8;
export const RoomPersonalSchema = union([
	obj({ type: literal("reset") }, { open: true }),
	/** Seconds of silence that end this person's utterance (the "Pause before sending" setting). */
	obj({ type: literal("vad"), silence: num({ minimum: MIN_PAUSE, maximum: MAX_PAUSE }) }, { open: true }),
]);
export const RoomCommandSchema = union([
	RoomPersonalSchema,
	obj(
		{
			type: literal("config"),
			engine: opt(Id),
			voice: opt(Id),
			speed: opt(num({ minimum: 0.5, maximum: 2 })),
			language: opt(LanguageSchema),
		},
		{ open: true },
	),
	obj({ type: literal("speak"), id: Id, text: str({ minLength: 1, maxLength: MAX_SPEAK_TEXT }) }, { open: true }),
	obj({ type: literal("cancel"), id: opt(Id) }, { open: true }),
]);
export type RoomCommand = Static<typeof RoomCommandSchema>;

export type RoomMember = { id: string; name: string; role: "owner" | "guest"; connections: number };

/** What the room sends as text (the service's `rooms.py`; p2's bridge adds nothing). */
export type RoomEvent =
	| {
			type: "welcome";
			room: string;
			you: RoomMember & { connectionId: string };
			members: RoomMember[];
			/** `speed` is null until the owner set one (the engine's default). */
			tts: { engine: string; voice: string; speed: number | null; language?: string };
			current: { id: string; engine: string; voice: string; sampleRate: number } | null;
			micSampleRate: number;
	  }
	| { type: "member_joined" | "member_updated" | "member_left"; member: RoomMember }
	| { type: "config"; engine: string; voice: string; speed: number | null; language?: string }
	| { type: "speak_ack"; id: string; duplicate: boolean }
	/** This connection's pause was set (from its next utterance on). */
	| { type: "vad"; silence: number }
	| { type: "tts_start"; id: string; engine: string; voice: string; sampleRate: number; language?: string }
	| { type: "tts_done"; id: string; cancelled: boolean }
	| { type: "tts_error"; id: string; code: string; message: string }
	| { type: "talking"; participant: string; on: boolean }
	| { type: "speech_start" }
	| { type: "speech_end" }
	| { type: "final"; text: string; ms: number }
	/** The utterance in progress so far, decoded (never after its final; absent from older services). */
	| { type: "interim"; text: string; ms: number }
	| { type: "error"; code: string; message: string; id?: string };

/** Binary frames of the room: agent speech (ID = utterance, rate from `tts_start`), or a person's microphone. */
export const AGENT_AUDIO = 1;
export const HUMAN_AUDIO = 2;
/** The sample rate of relayed microphones. */
export const HUMAN_RATE = 16000;

/**
 * A binary room frame: kind (byte 0), ID length n (byte 1), the ID (ASCII), a zero byte if 2 + n is odd, then PCM16LE
 * mono. The PCM is copied out (a buffer of its own, at offset 0).
 */
export function parseRoomFrame(frame: Uint8Array): { kind: number; id: string; pcm: Uint8Array } | undefined {
	const kind = frame[0];
	const length = frame[1];
	if (kind === undefined || length === undefined) return undefined;
	const offset = 2 + length + ((2 + length) & 1);
	if (frame.byteLength < offset) return undefined;
	let id = "";
	for (let index = 2; index < 2 + length; index++) id += String.fromCharCode(frame[index] ?? 0);
	return { kind, id, pcm: frame.slice(offset) };
}

/** The service's room name for a conversation (its pattern: `^p2-[A-Za-z0-9_-]{3,160}$`). */
export function roomName(session: string, conversation: number): string | undefined {
	const name = `p2-${session}-${conversation}`;
	return /^p2-[A-Za-z0-9_-]{3,160}$/.test(name) ? name : undefined;
}

/** `POST /voice/sample`: the owner hears a voice in its own browser (the settings sheet), outside the room. */
export const SampleSchema = obj(
	{
		engine: opt(Id),
		voice: opt(Id),
		speed: num({ minimum: 0.5, maximum: 2 }),
		language: opt(LanguageSchema),
	},
	{ open: true },
);
/** What a sample says. */
export const SAMPLE_TEXT = "Hi. This is how I sound when I read my answers to you.";

/** `POST /voice/log`: the browser's voice diagnostics (a batch), written to the server's log. */
export const MAX_LOG_EVENTS = 100;
export const MAX_LOG_MESSAGE = 500;
export const LogSchema = obj(
	{
		/** Which page sent it (a few random characters), to tell tabs and reloads apart. */
		client: str({ pattern: "^[A-Za-z0-9_-]{1,16}$" }),
		events: arr(
			obj(
				{
					/** The browser's `Date.now()` when it happened. */
					t: num({ minimum: 0, maximum: 8.64e15 }),
					message: str({ maxLength: MAX_LOG_MESSAGE }),
				},
				{ open: true },
			),
			{ maxItems: MAX_LOG_EVENTS },
		),
	},
	{ open: true },
);
export type LogBatch = Static<typeof LogSchema>;
