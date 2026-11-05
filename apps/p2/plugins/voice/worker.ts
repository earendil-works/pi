// Voice mode (worker): the owner's switch and voice, kept in a Durable document, and the prompt section voice mode
// turns on. A read/write guest's microphone switch is not written there: the document is the owner's, and a guest
// turning its microphone off must not turn voice mode off for anyone else. It counts while the guest's object lives
// (objects are per grant; leaving, a revoked grant or the linger time ends it): the prompt section is on while the
// owner's switch or any guest's is, since that guest talks by voice too.

import { type ConversationId, defineDoc, defineExtension, section } from "@earendil-works/pi-durable";
import { bool, nul, obj, type Static, union } from "@earendil-works/pi-schema";
import {
	type Context,
	type Ctx,
	canSend,
	contribute,
	defineFacet,
	defineTypedState,
	deriveTyped,
	forbidden,
	invalid,
	isOwner,
	principalKey,
	signalOf,
} from "@p2/app/v1";
import { durableContext } from "@p2/app/v1/node";
import { agentConversation, CommitSignal, Extensions, harnessOf } from "@p2/app/v1/worker";
import { VoiceChoiceSchema, VoiceMode } from "./contract.ts";

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

/** What the cells show: the document's voice, and the switch (the document's for the owner, a guest's own). */
const Shown = defineTypedState("p2.voice-mode", {
	schema: obj({ voice: union([VoiceChoiceSchema, nul()]), enabled: bool() }),
	version: 2,
	initial: () => ({ voice: null, enabled: false }),
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
			/** Where the agent's voice mode is (the main agent's on conversation 1); set when the object opens. */
			let holder = id;
			const read = async (ctx: Context) =>
				(await harness().durable.snapshot(VoiceModeDoc, holder, ctx)) ?? {
					enabled: false,
					voice: null,
				};
			const owner = isOwner(principal);
			const shown = self.state(Shown);
			const show = (doc: { enabled: boolean; voice: VoiceChoice | null }, ctx: Context) =>
				shown.change((draft) => {
					draft.voice = doc.voice;
					if (owner) draft.enabled = doc.enabled;
				}, ctx);
			const commits = self.open(
				async (ctx) => {
					const durable = harness().durable;
					if (!(await durable.conversation(id, ctx))) throw new Error(`Unknown conversation ${conversation}`);
					holder = await agentConversation(durable, id, ctx);
					await show(await read(ctx), ctx);
					return new CommitSignal(durable, (publication) =>
						publication.changes.some(
							(change) =>
								change.type === "document" &&
								change.record.kind === VoiceModeDoc.definition.kind &&
								change.conversationId === holder,
						),
					);
				},
				(signal) => signal.close(),
			);
			// The document is the truth; the cells show it. Subscribed before reading, so no commit is missed.
			self.onLive(async (ctx) => {
				const signal = signalOf(ctx);
				while (!signal.aborted) {
					const seen = commits.value.version;
					await show(await read(ctx), ctx);
					await commits.value.next(seen, signal).catch(() => {});
				}
			});
			const commit = async (ctx: Ctx, change: (doc: { enabled: boolean; voice: VoiceChoice | null }) => void) => {
				const durable = await harness().durable.conversation(id, durableContext(ctx));
				if (!durable) throw invalid("args", `Unknown conversation ${conversation}`);
				await durable.commit(async (tx) => change(await tx.doc(VoiceModeDoc, holder)), durableContext(ctx));
				return null;
			};
			const enabled = self.derive([shown], ([value]) => value.enabled);
			const voice = deriveTyped(self, [shown], ([value]) => value.voice);
			if (!owner) {
				// A read/write guest: its own microphone switch, counted while this object lives.
				const key = principalKey(principal);
				self.open(
					async () => key,
					() => setGuestVoice(String(id), key, false),
				);
				return {
					variant: "participant",
					members: {
						enabled,
						voice,
						set: async ({ enabled: on }, ctx) => {
							if (on && !(await harness().durable.conversation(id, durableContext(ctx))))
								throw invalid("args", `Unknown conversation ${conversation}`);
							setGuestVoice(String(id), key, on);
							await shown.change((draft) => {
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
					enabled,
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
