// Voice mode (worker): the owner's switch and voice, kept in a Durable document, and the prompt section voice mode
// turns on. A read/write guest's microphone switch is not written there: the document is the owner's, and a guest
// turning its microphone off must not turn voice mode off for anyone else. It counts while the guest's object lives
// (objects are per grant; leaving, a revoked grant or the linger time ends it): the prompt section is on while the
// owner's switch or any guest's is, since that guest talks by voice too.

import { type ConversationId, defineDoc, defineExtension, section } from "@earendil-works/pi-durable";
import { bool, obj, type Static } from "@earendil-works/pi-schema";
import {
	type Ctx,
	canSend,
	contribute,
	defineFacet,
	defineState,
	deriveTyped,
	forbidden,
	invalid,
	isOwner,
	principalKey,
} from "@p2/app/v1";
import { durableContext } from "@p2/app/v1/node";
import { agentConversation, Extensions, harnessOf } from "@p2/app/v1/worker";
import { type VoiceChoiceSchema, VoiceMode } from "./contract.ts";

export type VoiceChoice = Static<typeof VoiceChoiceSchema>;

/**
 * The owner's switch and voice, stored per agent (`agentConversation`: the main agent's on conversation 1, whichever
 * `/tree` branch it works in; a new subagent starts without voice).
 */
export const VoiceModeDoc = defineDoc<{ enabled: boolean; voice: VoiceChoice | null }>({
	kind: "voice.mode",
	version: 2,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ enabled: false, voice: null }),
	checkpointWhen: () => true,
	// Version 1 had the switch only.
	migrate: (value) => ({ enabled: value.enabled === true, voice: null }),
});

export const VOICE_PROMPT = [
	"The user is talking to you by voice: their messages are transcribed speech (expect recognition errors; read them",
	"charitably), and your text replies are read aloud sentence by sentence. Reply in short, plain spoken sentences: no",
	"Markdown, headings, lists, tables, code blocks, URLs or long file paths; say what matters and offer details on",
	"request.",
	"When you are about to use tools, first say in one short sentence what you are about to do: the user cannot see your",
	"screen, and silence while you work is confusing. A direct answer needs no announcement.",
	"Stay responsive: you are the voice, not the worker. Hand anything that takes more than a few seconds (coding,",
	"commands, research, multi-step work) to a doer subagent with the subagent tool: spawn one named doer with a",
	"complete brief, or send the next task to the existing doer. Then say in one sentence what you handed off, and end",
	"your turn. Do quick lookups yourself. When the doer reports, tell the user the outcome briefly. When the user asks",
	"how it is going, check with subagent status or answer. Steer the doer with subagent send; when the user wants it",
	"stopped or it is going wrong, stop it with subagent stop.",
].join(" ");

/** The guests whose voice mode is on, per conversation of this worker (by principal key). Not durable on purpose. */
const guestVoices = new Map<string, Set<string>>();

function setGuestVoice(conversation: string, guest: string, on: boolean): void {
	const guests = guestVoices.get(conversation) ?? new Set<string>();
	if (on) guests.add(guest);
	else guests.delete(guest);
	if (guests.size > 0) guestVoices.set(conversation, guests);
	else guestVoices.delete(conversation);
}

/** A language's English name ("German" for "de"), for the prompt; the tag itself where the runtime has none. */
export function languageName(language: string): string {
	try {
		return new Intl.DisplayNames(["en"], { type: "language" }).of(language) ?? language;
	} catch {
		return language;
	}
}

/** The voice section: the spoken style, and the language to answer in when the owner chose one other than English. */
export function voicePrompt(language: string | undefined): string {
	if (!language || language.toLowerCase().split("-")[0] === "en") return VOICE_PROMPT;
	const name = languageName(language);
	return `${VOICE_PROMPT} Speak ${name}: reply in ${name}, since your replies are read aloud in ${name}.`;
}

export const voiceExtension = defineExtension({
	name: "p2-voice",
	sections: [
		section("voice", async (input, context) => {
			const holder = await agentConversation(input.read, input.conversationId, context);
			const doc = await input.read.snapshot(VoiceModeDoc, holder, context);
			return guestVoices.has(String(input.conversationId)) || doc?.enabled
				? voicePrompt(doc?.voice?.language)
				: undefined;
		}),
	],
});

/** A read/write guest's own microphone switch (the owner's is the document's). */
const GuestSwitch = defineState("p2.voice-mode.guest", {
	schema: obj({ enabled: bool() }),
	version: 1,
	initial: () => ({ enabled: false }),
});

export default defineFacet((host) => {
	contribute(host, "p2.voice-extension", (self) => {
		self.contribute(Extensions, { [voiceExtension.name]: voiceExtension });
	});

	host.serve(
		VoiceMode,
		({ session, conversation }, principal, self) => {
			if (!canSend(principal, session)) throw forbidden("participants only");
			const id = conversation as ConversationId;
			const harness = harnessOf(self);
			/** Where the agent's voice mode is (the main agent's on conversation 1); found when the document is followed. */
			let holder = id;
			// The document is the truth, followed: a commit below reaches it before the method returns.
			const doc = self.follow(async (observer, ctx) => {
				const durable = harness().durable;
				if (!(await durable.conversation(id, durableContext(ctx))))
					throw new Error(`Unknown conversation ${conversation}`);
				holder = await agentConversation(durable, id, durableContext(ctx));
				const observed = await durable.observeDoc(VoiceModeDoc, holder, observer, ctx);
				if (observed !== undefined) return observed;
				// Nobody switched it yet: an absent address cannot be followed, so it is created as it reads (off, no voice).
				await durable.commit(async (tx) => {
					await tx.doc(VoiceModeDoc, holder);
				}, durableContext(ctx));
				return durable.observeDoc(VoiceModeDoc, holder, observer, ctx);
			});
			const owner = isOwner(principal);
			const commit = async (ctx: Ctx, change: (doc: { enabled: boolean; voice: VoiceChoice | null }) => void) => {
				const durable = await harness().durable.conversation(id, durableContext(ctx));
				if (!durable) throw invalid("args", `Unknown conversation ${conversation}`);
				await durable.commit(async (tx) => change(await tx.doc(VoiceModeDoc, holder)), durableContext(ctx));
				return null;
			};
			const voice = deriveTyped(self, [doc], ([value]) => value.voice);
			if (!owner) {
				// A read/write guest: its own microphone switch, counted while this object lives.
				const key = principalKey(principal);
				const guestSwitch = self.state(GuestSwitch);
				self.open(
					async () => key,
					() => setGuestVoice(String(id), key, false),
				);
				return {
					variant: "participant",
					members: {
						enabled: self.derive([guestSwitch], ([value]) => value.enabled),
						voice,
						set: async ({ enabled: on }, ctx) => {
							if (on && !(await harness().durable.conversation(id, durableContext(ctx))))
								throw invalid("args", `Unknown conversation ${conversation}`);
							setGuestVoice(String(id), key, on);
							await guestSwitch.change((draft) => {
								draft.enabled = on;
							}, ctx);
							return null;
						},
					},
				};
			}
			return {
				variant: "owner",
				members: {
					enabled: self.derive([doc], ([value]) => value.enabled),
					voice,
					set: ({ enabled: on }, ctx) =>
						commit(ctx, (doc) => {
							doc.enabled = on;
						}),
					choose: (choice, ctx) =>
						commit(ctx, (doc) => {
							doc.voice = choice;
						}),
				},
			};
		},
		{ linger: 30_000 },
	);
});
