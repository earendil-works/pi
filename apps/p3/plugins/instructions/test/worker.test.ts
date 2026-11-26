// The instructions plugin on a session's worker (`testPlugin`): its harness part gives one prompt section per thing
// the agent may use (the flag `use`), in the order held (the closest last), each the base text of its language and the
// thing's text, read at each prompt (a change made with Configure reaches the next step); a thing without Use, or
// with no text, gives no section.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context, type P3Principal } from "@earendil-works/p3/v1";
import { type TestedPlugin, testPlugin } from "@earendil-works/p3/v1/testing";
import type { PromptSection } from "@earendil-works/p3/v1/worker";
import { type HeldThing, ThingHarnessParts } from "../../things/contract.worker.ts";
import { de } from "../base/de.ts";
import { en } from "../base/en.ts";
import { InstructionsKind, type Language } from "../contract.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

/** The session, whose `call` the part never uses. */
const SESSION = { session: "s", workspace: "w", call: () => Promise.reject(new Error("no call")) };

/** A value the case changes, as a reference's state member reads (`value`, the current one). */
type Value<T> = { value: T };

/** A held instructions thing: its text and language as values the case changes, and whether Use is granted. */
function held(thing: string, text: Value<string>, language: Value<Language>, use = true): HeldThing {
	// A stand-in for the holding's reference: the members the part reads, nothing of a reference's lifecycle.
	const ref = { text, language, granted: new Set(use ? ["use"] : []) } as unknown as HeldThing["ref"];
	return { thing, workspace: "w", ref };
}

/** A value of `T` the case changes. */
function value<T>(initial: T): Value<T> {
	return { value: initial };
}

/** Renders `sections` as the prompt would show them (a section that renders nothing is left out). */
async function rendered(sections: readonly PromptSection[]): Promise<[string, string | undefined][]> {
	// The sections read neither the prompt's input nor its context.
	return Promise.all(
		sections.map(async (s) => [s.key, await s.render({} as never, context)] as [string, string | undefined]),
	);
}

describe("the agent's instructions", () => {
	let t: TestedPlugin<P3Principal>;

	beforeEach(async () => {
		t = await testPlugin(ROOT, { kind: "worker", session: "s" }, context);
	});

	afterEach(() => t.close(context));

	/** What the part gives `things`, as values the case sets. */
	async function sections(things: HeldThing[]): Promise<readonly PromptSection[]> {
		const [entry] = t.contributions(ThingHarnessParts);
		assert.equal(entry?.value.kind.name, InstructionsKind.name);
		return entry.value.part(things, SESSION).prompt ?? [];
	}

	it("gives one section per thing with Use, in the order held, each its language's base text and its text", async () => {
		const pi = held("pi", value("Work with code."), value<Language>("en"));
		const family = held("family", value("Sei freundlich."), value<Language>("de"));
		const hidden = held("other", value("Not for the agent."), value<Language>("en"), false);
		assert.deepEqual(await rendered(await sections([pi, hidden, family])), [
			["instructions-pi", `${en}\n\nWork with code.`],
			["instructions-family", `${de}\n\nSei freundlich.`],
		]);
	});

	it("reads the text and the language at each prompt, and gives nothing for an empty text", async () => {
		const text = value("Old.");
		const language = value<Language>("en");
		const [section] = await sections([held("pi", text, language)]);
		assert.ok(section !== undefined);
		text.value = "New.";
		language.value = "de";
		assert.deepEqual(await rendered([section]), [["instructions-pi", `${de}\n\nNew.`]]);
		text.value = "";
		assert.deepEqual(await rendered([section]), [["instructions-pi", undefined]]);
	});
});
