// The prompt plugin on a session's worker (`testPlugin`): its two harness parts, taken from the facet. Instructions:
// one prompt section per thing with Use, in the order held, each the base text of its language and the thing's text,
// read at each prompt; a thing without Use, or with no text, gives no section. Skills: the list of every set the agent
// may read, a name in two sets the closer set's (held last), read at each prompt; `skills_read` answers the text and
// files as JSON from the set that owns the name, refuses an unknown name and a withheld Use; no usable set: nothing.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context, isChordError, type P3Principal } from "@earendil-works/p3/v1";
import { type TestedPlugin, testPlugin } from "@earendil-works/p3/v1/testing";
import type { PromptSection } from "@earendil-works/p3/v1/worker";
import {
	type HarnessContribution,
	type HarnessExtension,
	type HeldThing,
	ThingHarnessParts,
} from "../../things/contract.worker.ts";
import { InstructionsKind, type Language } from "../instructions-kind.ts";
import { type Skill, SkillsKind } from "../skills-kind.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

/** The session, whose `call` and `location` the parts never use. */
const SESSION = {
	session: "s",
	workspace: "w",
	call: () => Promise.reject(new Error("no call")),
	location: async () => undefined,
};

/** A value the case changes, as a reference's state member reads (`value`, the current one). */
type Value<T> = { value: T };

/** A held instructions thing: its text and language as values the case changes, and whether Use is granted. */
function instructions(thing: string, text: Value<string>, language: Value<Language>, use = true): HeldThing {
	// A stand-in for the holding's reference until `kindServer.giving` is on main: the members the part reads.
	const ref = { text, language, granted: new Set(use ? ["use"] : []) } as unknown as HeldThing["ref"];
	return { thing, workspace: "w", ref };
}

/** A held set `thing` with `skills` (a list the case may change), `read` granted unless `use` is false. */
function set(thing: string, skills: Value<Skill[]>, use = true): HeldThing {
	const read = async ({ name }: { name: string }) => ({ text: `${thing}'s ${name}`, files: ["run.sh"] });
	const ref = { skills, granted: new Set(use ? ["read"] : []), ...(use ? { read } : {}) };
	// A stand-in for the holding's reference until `kindServer.giving` is on main: the members the part reads.
	return { thing, workspace: "w", ref: ref as unknown as HeldThing["ref"] };
}

/** A skill. */
const skill = (name: string, description: string): Skill => ({ name, description });

/** Renders `sections` as the prompt would show them (a section that renders nothing is left out). */
async function rendered(sections: readonly PromptSection[]): Promise<[string, string | undefined][]> {
	// The sections read neither the prompt's input nor its context.
	return Promise.all(
		sections.map(async (s) => [s.key, await s.render({} as never, context)] as [string, string | undefined]),
	);
}

let t: TestedPlugin<P3Principal>;

beforeEach(async () => {
	t = await testPlugin(ROOT, { kind: "worker", session: "s" }, context);
});

afterEach(() => t.close(context));

/** What the facet's part of kind `kind` gives `things`. */
function given(kind: string, things: HeldThing[]): HarnessContribution {
	const entry = t.contributions(ThingHarnessParts).find(({ value }) => value.kind.name === kind);
	assert.ok(entry !== undefined, kind);
	return entry.value.part(things, SESSION);
}

describe("the agent's instructions", () => {
	it("give one section per thing with Use, in the order held, each its language's base text and its text", async () => {
		const pi = instructions("pi", { value: "Work with code." }, { value: "en" });
		const family = instructions("family", { value: "Sei freundlich." }, { value: "de" });
		const hidden = instructions("other", { value: "Not for the agent." }, { value: "en" }, false);
		const shown = await rendered(given(InstructionsKind.name, [pi, hidden, family]).extension?.sections ?? []);
		assert.deepEqual(
			shown.map(([key]) => key),
			["instructions-pi", "instructions-family"],
		);
		assert.match(shown[0]?.[1] ?? "", /Follow them:\n\nWork with code\.$/);
		assert.match(shown[1]?.[1] ?? "", /Halte dich daran:\n\nSei freundlich\.$/);
	});

	it("read the text and the language at each prompt, and give nothing for an empty text", async () => {
		const text = { value: "Old." };
		const language: Value<Language> = { value: "en" };
		const [section] = given(InstructionsKind.name, [instructions("pi", text, language)]).extension?.sections ?? [];
		assert.ok(section !== undefined);
		text.value = "New.";
		language.value = "de";
		assert.match((await rendered([section]))[0]?.[1] ?? "", /Halte dich daran:\n\nNew\.$/);
		text.value = "";
		assert.deepEqual(await rendered([section]), [["instructions-pi", undefined]]);
	});
});

describe("the agent's skills", () => {
	/** The extension the skills part gives `sets`. */
	const skills = (...sets: HeldThing[]): HarnessExtension | undefined => given(SkillsKind.name, sets).extension;

	/** The section's text of `extension`. */
	async function section(extension: HarnessExtension | undefined): Promise<string | undefined> {
		// The section reads neither the prompt's input nor its context.
		return extension?.sections?.[0]?.render({} as never, context);
	}

	/** Runs `skills_read` of `extension` for `name`; its answer, parsed. */
	async function read(extension: HarnessExtension | undefined, name: string): Promise<unknown> {
		const tool = extension?.tools?.find((each) => each.name === "skills_read");
		assert.ok(tool !== undefined);
		// `skills_read` uses neither Durable's execution API nor arguments beyond its schema's.
		const result = await tool.execute({ name } as never, {} as never, context);
		return JSON.parse((result.output ?? []).map((part) => (part.type === "text" ? part.text : "")).join(""));
	}

	it("lists the skills of two sets, a name in both the closer set's, and reads it from there", async () => {
		const pi = set("pi", { value: [skill("release", "Cut a release"), skill("review", "Review a change")] });
		const team = set("team", { value: [skill("review", "Review as Team does")] });
		const extension = skills(pi, team);
		assert.equal(
			await section(extension),
			"Skills you can read with skills_read when a task matches one:\n- review: Review as Team does\n- release: Cut a release",
		);
		assert.deepEqual(await read(extension, "review"), { text: "team's review", files: ["run.sh"] });
		assert.deepEqual(await read(extension, "release"), { text: "pi's release", files: ["run.sh"] });
		await assert.rejects(read(extension, "nothing"), (error) => isChordError(error) && error.code === "invalid");
	});

	it("reads the lists at each prompt; a set without Use lists nothing; none usable gives no extension", async () => {
		const list = { value: [skill("release", "Cut a release")] };
		const extension = skills(set("pi", list), set("hidden", { value: [skill("secret", "")] }, false));
		list.value = [...list.value, skill("triage", "Sort the issues")];
		assert.equal(
			await section(extension),
			"Skills you can read with skills_read when a task matches one:\n- release: Cut a release\n- triage: Sort the issues",
		);
		assert.equal(skills(set("hidden", { value: [skill("secret", "")] }, false)), undefined);
	});

	it("refuses a skill whose set's Use was withheld after the tool was offered", async () => {
		const pi = set("pi", { value: [skill("release", "Cut a release")] });
		const extension = skills(pi);
		// Withheld since: the held reference's `read` is gone.
		delete (pi.ref as { read?: unknown }).read;
		await assert.rejects(read(extension, "release"), (error) => isChordError(error) && error.code === "forbidden");
	});

	it("reuses an unchanged 100-skill section, reading no skill again (Astra, round 1)", async () => {
		let descriptions = 0;
		const many = Array.from({ length: 100 }, (_, i) => ({
			name: `skill${i}`,
			get description() {
				descriptions++;
				return "example";
			},
		}));
		const extension = skills(set("pi", { value: many }));
		const text = await section(extension);
		descriptions = 0;
		assert.equal(await section(extension), text);
		assert.equal(descriptions, 0);
	});
});
