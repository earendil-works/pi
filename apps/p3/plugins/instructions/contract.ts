// The instructions plugin's contract: instructions as a kind of thing (`prompt.instructions`): a text the agent starts
// from and the language it is written in. Made by people (an agent never writes its own instructions, decision 10);
// the plugin seeds one in Pi. Every instructions thing that reaches a session adds its section (`stacking: "all"`), in
// the order down the tree, the closest last. Its one tick, Use, is a flag tick for the agents (decision 97); the text
// and the language are settings, changed with Configure where the thing is linked (decision 91).

import { obj, oneOf, type Static, str } from "@earendil-works/p3/v1";
import { defineThing } from "../things/kind.ts";
import { messages } from "./messages.ts";

/** An instructions text: at most 20,000 characters. */
export const InstructionsText = str({ max: 20_000 });

/** The languages instructions are written in. */
export const Language = oneOf("en", "de", "fr");

/** A language instructions are written in (see `Language`). */
export type Language = Static<typeof Language>;

/** The settings of an instructions thing: its text and its language. */
export const InstructionsSettings = obj({ text: InstructionsText, language: Language });

/** The settings of an instructions thing (see `InstructionsSettings`). */
export type InstructionsSettings = Static<typeof InstructionsSettings>;

/** Instructions: the text and the language, plain; the flag `use` gives the agent its prompt section. */
export const InstructionsKind = defineThing("prompt.instructions", {
	version: 1,
	makers: "people",
	stacking: "all",
	state: { text: InstructionsText, language: Language },
	ticks: { use: { label: messages.message("tickUse"), for: "agents" } },
	defaultGrants: { agents: ["use"] },
	settings: InstructionsSettings,
});

/** Instructions held in a workspace: `InstructionsKind`'s contract. */
export const Instructions = InstructionsKind.contract;
