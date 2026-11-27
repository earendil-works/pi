// The prompt plugin's harness parts, as the worker facet contributes them to `ThingHarnessParts`, given the things an
// agent holds (real references, held as the session's worker on a server with the things plugin, `kindServer`). The
// facet's two parts are the two kinds'. Instructions: one prompt section per thing with Use, in the order held, each
// the base text of its language and the thing's text, read at each prompt (a Configure reaches the next one); a
// thing with Use withheld, or with no text, gives no section. Skills: the list of every set the agent may read, a
// name in two sets the closer set's (held last), read at each prompt; `skills_read` answers the text and files as
// JSON from the set that owns the name, refuses an unknown name and a set whose Use was withheld after the tool was
// offered; a set with Use withheld lists nothing; an unchanged section reads no skill again.

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { type Contract, BACKGROUND_CONTEXT as context, isChordError, until } from "@earendil-works/p3/v1";
import { within } from "../../../test/until.ts";
import { ThingHooks } from "../../things/contract.server.ts";
import {
	type HarnessExtension,
	type HarnessSession,
	type HeldThing,
	ThingHarnessParts,
} from "../../things/contract.worker.ts";
import { runTool } from "../../things/test/kind-server.ts";
import { type Instructions, InstructionsKind } from "../instructions-kind.ts";
import { type Skills, SkillsKind } from "../skills-kind.ts";
import { type PromptServer, promptKind } from "./prompt-server.ts";

/** How long a wait for what a folder watch sees may take (a loaded machine delays its events). */
const WATCHED = 10_000;

/** The session's agent as a party. */
const AGENT_PARTY = { kind: "agent", session: "s1" } as const;

/** The first line of the skills section. */
const HEADING = "Skills you can read with skills_read when a task matches one:";

/** The rendered text of `extension`'s sections, by key (a section that renders nothing: `undefined`). */
async function rendered(extension: HarnessExtension): Promise<[string, string | undefined][]> {
	// The sections read neither the prompt's input nor its context.
	return Promise.all(
		(extension.sections ?? []).map(
			async (section) => [section.key, await section.render({} as never, context)] as [string, string | undefined],
		),
	);
}

/** Configures thing `thing` of kind `kind` on `n` with `settings`, as `Workspace.configure` does. */
async function configure<C extends Contract>(
	n: PromptServer<C>,
	kind: string,
	thing: string,
	settings: Record<string, unknown>,
): Promise<void> {
	const hook = (await n.host.registry(ThingHooks, context)).value.get(kind)?.value.configure;
	assert.ok(hook !== undefined);
	await n.host.root((ctx) => hook(thing, settings, ctx), context);
}

describe("the facet's parts", () => {
	it("are the two kinds'", async () => {
		const n = await promptKind(InstructionsKind, context);
		try {
			assert.deepEqual(
				(await n.worker("s1"))
					.contributions(ThingHarnessParts)
					.map(({ value }) => value.kind.name)
					.toSorted(),
				[InstructionsKind.name, SkillsKind.name],
			);
		} finally {
			await n.close();
		}
	});
});

describe("the agent's instructions", () => {
	let n: PromptServer<typeof Instructions>;
	let s1: string;

	beforeEach(async () => {
		n = await promptKind(InstructionsKind, context);
		s1 = await n.workspace("s1");
	});

	afterEach(() => n.close());

	/** Makes instructions in s1 with `settings`; their id. */
	async function made(settings: Record<string, unknown>): Promise<string> {
		const thing = await n.thingIn(s1);
		await configure(n, InstructionsKind.name, thing, settings);
		return thing;
	}

	/** Runs `fn` with what s1's agent gets holding `things` there. */
	const giving = <T>(
		things: readonly string[],
		fn: (extension: HarnessExtension, held: readonly HeldThing<typeof Instructions>[]) => Promise<T>,
	) => n.giving({ session: "s1", workspace: s1 }, things, (extension, _ctx, held) => fn(extension, held));

	it("give one section per thing with Use, in the order held, each its language's base text and its text", async () => {
		const pi = await made({ text: "Work with code.", language: "en" });
		const family = await made({ text: "Sei freundlich.", language: "de" });
		const hidden = await made({ text: "Not for the agent.", language: "en" });
		await n.tick(s1, hidden, AGENT_PARTY, "use", false);
		await giving([pi, hidden, family], async (extension) => {
			const shown = await rendered(extension);
			assert.deepEqual(
				shown.map(([key]) => key),
				[`instructions-${pi}`, `instructions-${family}`],
			);
			assert.match(shown[0]?.[1] ?? "", /Follow them:\n\nWork with code\.$/);
			assert.match(shown[1]?.[1] ?? "", /Halte dich daran:\n\nSei freundlich\.$/);
		});
	});

	it("read the text and the language at each prompt, and give nothing for an empty text", async () => {
		const thing = await made({ text: "Old.", language: "en" });
		await giving([thing], async (extension, [held]) => {
			await configure(n, InstructionsKind.name, thing, { text: "New.", language: "de" });
			await until(held!.ref.text, (text) => text === "New.", within("the new text", context));
			await until(held!.ref.language, (language) => language === "de", within("the new language", context));
			assert.match((await rendered(extension))[0]?.[1] ?? "", /Halte dich daran:\n\nNew\.$/);
			await configure(n, InstructionsKind.name, thing, { text: "" });
			await until(held!.ref.text, (text) => text === "", within("no text", context));
			assert.deepEqual(await rendered(extension), [[`instructions-${thing}`, undefined]]);
		});
	});
});

describe("the agent's skills", () => {
	let n: PromptServer<typeof Skills>;
	let s1: string;

	beforeEach(async () => {
		n = await promptKind(SkillsKind, context);
		s1 = await n.workspace("s1");
	});

	afterEach(() => n.close());

	/** Writes skill `name` into `folder` under the root, with `description`. */
	async function writeSkill(folder: string, name: string, description: string): Promise<void> {
		await mkdir(join(n.root, folder, name), { recursive: true });
		await writeFile(
			join(n.root, folder, name, "SKILL.md"),
			`---\ndescription: ${description}\n---\n${folder}'s ${name}\n`,
		);
	}

	/** Makes a set in s1 over folder `folder`; its id. */
	async function setOver(folder: string): Promise<string> {
		const thing = await n.thingIn(s1, folder);
		await configure(n, SkillsKind.name, thing, { folder });
		return thing;
	}

	/**
	 * Runs `fn` with what s1's agent gets holding the sets `things` there, once each held set lists its `counts` skills
	 * (a set's first read of its folder comes after the hold).
	 */
	const giving = <T>(
		things: readonly string[],
		counts: readonly number[],
		fn: (extension: HarnessExtension, held: readonly HeldThing<typeof Skills>[]) => Promise<T>,
	) =>
		n.giving({ session: "s1", workspace: s1 }, things, async (extension, ctx, held) => {
			for (const [at, { ref }] of held.entries()) {
				await until(ref.skills, (list) => list.length === counts[at], within("a set's skills", ctx, WATCHED));
			}
			return fn(extension, held);
		});

	/** The skills section's text of `extension`. */
	const section = async (extension: HarnessExtension) => (await rendered(extension))[0]?.[1];

	/** `skills_read` of `extension` for `name`, its answer parsed. */
	const read = async (extension: HarnessExtension, name: string) =>
		JSON.parse(await runTool(extension, "skills_read", { name }, context)) as unknown;

	it("lists the skills of two sets, a name in both the closer set's, and reads it from there", async () => {
		await writeSkill("pi", "release", "Cut a release");
		await writeSkill("pi", "review", "Review a change");
		await writeSkill("team", "review", "Review as Team does");
		const [pi, team] = [await setOver("pi"), await setOver("team")];
		await giving([pi, team], [2, 1], async (extension) => {
			assert.equal(await section(extension), `${HEADING}\n- review: Review as Team does\n- release: Cut a release`);
			assert.deepEqual(await read(extension, "review"), {
				text: "---\ndescription: Review as Team does\n---\nteam's review\n",
				files: [],
			});
			assert.match(((await read(extension, "release")) as { text: string }).text, /pi's release/);
			await assert.rejects(read(extension, "nothing"), (error) => isChordError(error) && error.code === "invalid");
		});
	});

	it("reads the lists at each prompt; a set with Use withheld lists nothing", async () => {
		await writeSkill("pi", "release", "Cut a release");
		await writeSkill("hidden", "secret", "Not for the agent");
		const [pi, hidden] = [await setOver("pi"), await setOver("hidden")];
		await n.tick(s1, hidden, AGENT_PARTY, "use", false);
		await giving([pi, hidden], [1, 1], async (extension, [held]) => {
			await writeSkill("pi", "triage", "Sort the issues");
			await until(held!.ref.skills, (list) => list.length === 2, within("the new skill", context, WATCHED));
			assert.equal(await section(extension), `${HEADING}\n- release: Cut a release\n- triage: Sort the issues`);
		});
		await assert.rejects(
			giving([hidden], [1], async () => {}),
			/gave no extension/,
		);
	});

	it("refuses a skill whose set's Use was withheld after the tool was offered", async () => {
		await writeSkill("pi", "release", "Cut a release");
		const pi = await setOver("pi");
		await giving([pi], [1], async (extension, [held]) => {
			await n.tick(s1, pi, AGENT_PARTY, "use", false);
			await until(held!.ref.state, () => held!.ref.read === undefined, within("Use withheld", context));
			// The reference rebuilt without `read` lists its set's skills again: the tool finds the name, not the member.
			await until(held!.ref.skills, (list) => list.length === 1, within("listed again", context, WATCHED));
			await assert.rejects(read(extension, "release"), (error) => isChordError(error) && error.code === "forbidden");
		});
	});

	it("reuses an unchanged section, reading no skill again (Astra, round 1)", async () => {
		for (let i = 0; i < 100; i++) await writeSkill("pi", `skill${i}`, "example");
		const pi = await setOver("pi");
		await giving([pi], [100], async (_extension, [held]) => {
			// The part again, on the agent's real reference, its list one whose descriptions count their reads.
			let descriptions = 0;
			const counted = held!.ref.skills.value.map(({ name, description }) => ({
				name,
				get description() {
					descriptions++;
					return description;
				},
			}));
			const skills = { value: counted };
			const ref = new Proxy(held!.ref, {
				get: (target, key) => (key === "skills" ? skills : Reflect.get(target, key)),
			});
			const entry = (await n.worker("s1"))
				.contributions(ThingHarnessParts)
				.find(({ value }) => value.kind.name === SkillsKind.name);
			// The registry's part takes any kind's held things (these are its kind's); the skills part never reads its
			// session.
			const things = [{ ...held!, ref }] as unknown as readonly HeldThing[];
			const extension = entry!.value.part(things, {} as HarnessSession).extension!;
			const text = await section(extension);
			assert.equal(descriptions, 100);
			assert.equal(await section(extension), text);
			assert.equal(descriptions, 100, "the second render reads no skill");
		});
	});
});
