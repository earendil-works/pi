// Voice mode of one conversation, served by each session worker (worker.ts). One voice per conversation, the
// owner's: the owner switches voice mode (the agent's prompt then asks for short spoken answers) and chooses the
// engine, voice and speed everyone hears. A read/write guest switches only its own microphone (its transcripts are its
// messages) and sees the owner's choice; it never changes what the owner set.

import { bool, nul, num, obj, opt, str, union } from "@earendil-works/pi-schema";
import { local, method, param, remote, serverHost, sessionHost } from "@p2/app/v1";
import { LanguageSchema, VoicesSchema } from "./protocol.ts";

const Id = str({ pattern: "^[A-Za-z0-9_-]{1,64}$" });

/**
 * The conversation's voice: an engine of the speech service, one of its voices, and the speed; and the language it
 * speaks, when the engine offers several (absent: the engine's default).
 */
export const VoiceChoiceSchema = obj({
	engine: Id,
	voice: Id,
	speed: num({ minimum: 0.5, maximum: 2 }),
	language: opt(LanguageSchema),
});

export const VoiceMode = remote("p2.voice-mode", {
	/**
	 * 3: the voice carries a language. A state schema change needs a new contract version: objects of the old one keep
	 * sending the old shape (wire frames follow the schema), so the reload must replace them.
	 */
	version: 3,
	params: { session: param.str(), conversation: param.int() },
	hostAddress: sessionHost,
	variants: {
		owner: {
			state: {
				/** The conversation's voice mode (the prompt section). */
				enabled: bool(),
				/** The chosen voice; null until the owner chose one (the service's default then). */
				voice: union([VoiceChoiceSchema, nul()]),
			},
			methods: {
				set: method(obj({ enabled: bool() })),
				choose: method(VoiceChoiceSchema),
			},
		},
		/** A read/write guest. */
		participant: {
			state: {
				/** This guest's own microphone switch. */
				enabled: bool(),
				/** The owner's choice, read only. */
				voice: union([VoiceChoiceSchema, nul()]),
			},
			methods: { set: method(obj({ enabled: bool() })) },
		},
	},
});

const service = {
	/** The speech service's engines and default; null while voice.json names none (or it is invalid). */
	voices: union([VoicesSchema, nul()]),
	/** Why voice.json names a service but its voices are unknown (the service unreachable); null otherwise. */
	failure: union([str(), nul()]),
};

/**
 * The server's speech service (server, in memory): `voice.json` watched while anyone holds this, its service's voices
 * fetched again whenever the file changes. Never the URL or token. `refresh` asks the service again.
 */
export const VoiceServiceStore = local("p2.voice-service-store", {
	/** 2: engines list their languages (see VoiceMode's version). */
	version: 2,
	params: {},
	members: { ...service, refresh: method() },
});

/** Whether voice mode is available, for those who may talk: the owner and read/write guests. */
export const VoiceService = remote("p2.voice-service", {
	/** 2: engines list their languages (see VoiceMode's version). */
	version: 2,
	params: {},
	hostAddress: serverHost,
	variants: { talker: { state: service } },
});
