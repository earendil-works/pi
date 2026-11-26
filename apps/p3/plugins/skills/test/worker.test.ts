// The skills plugin on a session's worker (`testPlugin`): its harness part lists the skills of every set the agent
// may use (Use gives `read`), a name in two sets the closer set's (held last), read at each prompt; `skill_read` reads
// the text from the set that owns the name, through its held reference, and names its files; a set without Use lists
// nothing, and none at all gives no extension.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context, type P3Principal } from "@earendil-works/p3/v1";
import { type TestedPlugin, testPlugin } from "@earendil-works/p3/v1/testing";
import type { Extension } from "@earendil-works/p3/v1/worker";
import { type HeldThing, ThingHarnessParts } from "../../things/contract.worker.ts";
import { type Skill, SkillsKind } from "../contract.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

/** The session, whose `call` the part never uses. */
const SESSION = {
	session: "s",
	workspace: "w",
	call: () => Promise.reject(new Error("no call")),
	location: async () => undefined,
};

/** A held set `thing` with `skills` (a list the case may change), `read` granted unless `use` is false. */
function set(thing: string, skills: { value: Skill[] }, use = true): HeldThing {
	const read = async ({ name }: { name: string }) => ({ text: `${thing}'s ${name}`, files: ["run.sh"] });
	const ref = { skills, granted: new Set(use ? ["read"] : []), ...(use ? { read } : {}) };
	// A stand-in for the holding's reference: the members the part reads, nothing of a reference's lifecycle.
	return { thing, workspace: "w", ref: ref as unknown as HeldThing["ref"] };
}

/** A skill. */
const skill = (name: string, description: string): Skill => ({ name, description });

describe("the agent's skills", () => {
	let t: TestedPlugin<P3Principal>;

	beforeEach(async () => {
		t = await testPlugin(ROOT, { kind: "worker", session: "s" }, context);
	});

	afterEach(() => t.close(context));

	/** What the part gives `sets`. */
	function given(...sets: HeldThing[]): Extension | undefined {
		const [entry] = t.contributions(ThingHarnessParts);
		assert.equal(entry?.value.kind.name, SkillsKind.name);
		return entry.value.part(sets, SESSION).extension;
	}

	/** The section's text of `extension`. */
	async function section(extension: Extension | undefined): Promise<string | undefined> {
		// The section reads neither the prompt's input nor its context.
		return extension?.sections?.[0]?.render({} as never, context);
	}

	/** Runs `skill_read` of `extension` for `name`; its output's text. */
	async function read(extension: Extension | undefined, name: string): Promise<string> {
		const tool = extension?.tools?.find((each) => each.name === "skill_read");
		assert.ok(tool !== undefined);
		// `skill_read` uses neither Durable's execution API nor arguments beyond its schema's.
		const result = await tool.execute({ name } as never, {} as never, context);
		return (result.output ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");
	}

	it("lists the skills of two sets, a name in both the closer set's, and reads it from there", async () => {
		const pi = set("pi", { value: [skill("release", "Cut a release"), skill("review", "Review a change")] });
		const team = set("team", { value: [skill("review", "Review as Team does")] });
		const extension = given(pi, team);
		assert.equal(
			await section(extension),
			"Skills you can read with skill_read when a task matches one:\n- review: Review as Team does\n- release: Cut a release",
		);
		assert.equal(
			await read(extension, "review"),
			"team's review\n\nIts files (on the Pi, not on your machine): run.sh",
		);
		assert.equal(
			await read(extension, "release"),
			"pi's release\n\nIts files (on the Pi, not on your machine): run.sh",
		);
		await assert.rejects(read(extension, "nothing"), /no skill "nothing"/);
	});

	it("reads the lists at each prompt; a set without Use lists nothing; none usable gives no extension", async () => {
		const skills = { value: [skill("release", "Cut a release")] };
		const extension = given(set("pi", skills), set("hidden", { value: [skill("secret", "")] }, false));
		skills.value = [...skills.value, skill("triage", "Sort the issues")];
		assert.equal(
			await section(extension),
			"Skills you can read with skill_read when a task matches one:\n- release: Cut a release\n- triage: Sort the issues",
		);
		assert.equal(given(set("hidden", { value: [skill("secret", "")] }, false)), undefined);
	});
});
