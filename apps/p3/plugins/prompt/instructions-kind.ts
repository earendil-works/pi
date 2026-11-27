// The instructions kind (`prompt.instructions`): a text the agent starts from, and the language it is written in.
// Made by people (an agent never writes its own instructions, decision 10); the plugin seeds one in Pi with its
// default text. Every instructions thing that reaches a session adds its own prompt section, the closest last. Its
// one tick, Use, is a flag tick for the agents (decision 97). The text and the language are settings, changed with
// Configure where the thing is linked (decision 91). No guests.

import { obj, oneOf, type Static, str } from "@earendil-works/p3/v1";
import { defineThing } from "../things/kind.ts";
import { messages } from "./messages.ts";

/** An instructions text: at most 20,000 characters. */
export const InstructionsText = str({ max: 20_000 });

/** The languages instructions are written in. */
export const Language = oneOf("en", "de", "fr");

/** A language instructions are written in (see `Language`). */
export type Language = Static<typeof Language>;

/** An instructions thing's settings: its text and its language. */
export const InstructionsSettings = obj({ text: InstructionsText, language: Language });

/** An instructions thing's settings (see `InstructionsSettings`). */
export type InstructionsSettings = Static<typeof InstructionsSettings>;

/** Instructions: the text and the language, plain (they are what the agent reads); Use gives the prompt section. */
export const InstructionsKind = defineThing("prompt.instructions", {
	version: 1,
	makers: "people",
	state: { text: InstructionsText, language: Language },
	ticks: {
		// `text` and `language` are given by no tick: for everyone let in. Use is the agent's flag.
		use: { label: messages.message("instructionsTickUse"), for: "agents" },
	},
	defaultGrants: { agents: ["use"] },
	settings: ["text", "language"],
});

/** Instructions held in a workspace: `InstructionsKind`'s contract. */
export const Instructions = InstructionsKind.contract;
