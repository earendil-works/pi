// Terminals end to end (`testServer`: the real server, sessions' workers as processes, the tests' faux login): a
// running worker offers the agent the `terminal` tool only while a machine type installed opens terminals, and follows
// a type installed and removed while it runs, as a worker started later does; a reload of the harness leaves only the new
// harness following (Astra, round 7).

import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context, SessionObject, Transcript, until, withGranted } from "@earendil-works/p3/v1";
import { OneThing } from "@earendil-works/p3/v1/server";
import { type TestServer, testServer } from "@earendil-works/p3/v1/testing";
import { FauxRequests } from "../../../test/plugins/faux-login/contract.ts";
import { newSession, piOf, scriptFaux } from "../../../test/support.ts";
import { within } from "../../../test/until.ts";
import { Terminals, TerminalsKind } from "../kind.ts";

/** The tests' faux login. */
const FAUX = fileURLToPath(new URL("../../../test/plugins/faux-login/", import.meta.url));

/** A user plugin contributing a machine type that opens terminals (its machines are never connected here). */
const OPENING_TYPE = `import { defineFacet, obj } from "@earendil-works/p3/v1";
import { MachineTypes } from "@earendil-works/p3/v1/server";
export default defineFacet((_host, self) =>
	self.contribute(MachineTypes, {
		type: "opening",
		label: { namespace: "test", key: "opening", params: [] },
		settings: obj({}),
		terminals: true,
		connect: async () => {
			throw new Error("not connected in this test");
		},
	}),
);
`;

/** A new session whose agent answers `done`: sends `text` and answers whether that request offered `terminal`. */
async function agent(t: TestServer): Promise<(text: string) => Promise<boolean>> {
	return (await agentIn(t)).ask;
}

/** A new session whose agent answers `done`, its id, and `ask` (see `agent`). */
async function agentIn(t: TestServer): Promise<{ session: string; ask: (text: string) => Promise<boolean> }> {
	const owner = await t.client(context);
	const session = await newSession(owner, "terminals", context);
	await scriptFaux(t.host, session, [{ when: "", reply: [{ kind: "text", text: "done" }] }], context);
	const transcript = withGranted(await owner.get(Transcript, { session }, context), "send")!;
	const requests = (await owner.get(FauxRequests, { session }, context)).requests;
	const row = (await owner.get(SessionObject, { workspace: session, thing: session }, context)).row;
	const ask = async (text: string) => {
		await transcript.send({ text, requestId: text }, context);
		const seen = await until(requests, (all) => all.some(({ last }) => last === text), within(text, context, 10_000));
		await until(row, ({ state }) => state === "settled", within("settled", context, 10_000));
		return seen.find(({ last }) => last === text)!.tools.includes("terminal");
	};
	return { session, ask };
}

it("offers a running worker's agent the terminal tool only while a machine type installed opens terminals", async () => {
	// Idle long enough that the first worker keeps running through both changes.
	const t = await testServer({ plugins: [FAUX], idleMs: 120_000 }, context);
	try {
		const owner = await t.client(context);
		const pi = await piOf(owner, context);
		const thing = await t.host.root(
			async (ctx) => until((await ctx.get(OneThing, { kind: TerminalsKind.name })).thing, (id) => id !== "", ctx),
			context,
		);
		const list = (await owner.get(Terminals, { workspace: pi, thing }, context)).terminals!;
		const applied = async () => {
			await until(t.plugins, (plugins) => plugins.set || plugins.dirty.length > 0, within("the change", context));
			await t.apply(context);
		};
		const running = await agent(t);
		assert.equal(await running("@before"), false, "this device's type opens no terminals");
		const file = join(t.userRoot, "opening.server.ts");
		await writeFile(file, OPENING_TYPE);
		await applied();
		await until(list, ({ opens }) => opens, within("opens", context));
		assert.equal(await running("@installed"), true, "the running worker offers it once a type opens terminals");
		await rm(file);
		await applied();
		await until(list, ({ opens }) => !opens, within("no longer opens", context));
		assert.equal(await running("@removed"), false, "and takes it away once none does");
		assert.deepEqual(t.errors, []);
	} finally {
		await t.close(context);
	}
});

// Astra, round 7: a reloaded harness's parts kept following; the old harness gave its kind again too.
it("leaves only the reloaded harness following whether a type opens terminals", async () => {
	const root = await mkdtemp(join(tmpdir(), "p3-terminals-follow-"));
	const built = join(root, "built-in");
	const log = join(root, "followers");
	await cp(fileURLToPath(new URL("../../", import.meta.url)), built, { recursive: true });
	// The built-in copy's terminals part notes each follower's start, refresh and stop in `log`.
	const part = join(built, "terminals", "worker.ts");
	const noted = [
		[
			"const stopped = new AbortController();",
			`const id = crypto.randomUUID(); note("start", id); const stopped = new AbortController();`,
		],
		[
			'if (call.kind === "value" && call.value.opens !== opens) refresh();',
			'if (call.kind === "value" && call.value.opens !== opens) { note("refresh", id); refresh(); }',
		],
		["return () => stopped.abort();", `return () => { note("stop", id); stopped.abort(); };`],
	] as const;
	let source = await readFile(part, "utf8");
	for (const [from, to] of noted) {
		assert.ok(source.includes(from), `the part still has ${from}`);
		source = source.replace(from, to);
	}
	const note = `const note = (what: string, id: string) => appendFileSync(${JSON.stringify(log)}, \`\${what} \${id}\\n\`);`;
	await writeFile(part, `import { appendFileSync } from "node:fs";\n${note}\n${source}`);
	const t = await testServer({ builtIn: built, plugins: [FAUX], idleMs: 120_000 }, context);
	/** The followers started and not stopped, and the refreshes, from the log. */
	const followers = async () => {
		const lines = (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
		const live = new Set<string>();
		let refreshes = 0;
		for (const line of lines) {
			const [what, id] = line.split(" ");
			if (what === "start") live.add(id!);
			if (what === "stop") live.delete(id!);
			if (what === "refresh") refreshes++;
		}
		return { live: live.size, refreshes };
	};
	const applied = async () => {
		await until(t.plugins, (plugins) => plugins.set || plugins.dirty.length > 0, within("the change", context));
		return (await t.apply(context)).steps;
	};
	try {
		const { session, ask } = await agentIn(t);
		assert.equal(await ask("@before"), false);
		assert.deepEqual(await followers(), { live: 1, refreshes: 0 });
		const harness = join(built, "harness", "worker.ts");
		await writeFile(harness, `${await readFile(harness, "utf8")}\nexport const RELOADED = 1;\n`);
		const steps = await applied();
		const workers = steps.find((step) => step.name === "workers");
		assert.ok(workers?.hosts.some((host) => host.kind === "reloaded" && host.host === session));
		assert.equal(await ask("@reloaded"), false);
		assert.deepEqual(await followers(), { live: 1, refreshes: 0 }, "the old harness's follower stopped");
		await writeFile(join(t.userRoot, "opening.server.ts"), OPENING_TYPE);
		await applied();
		assert.equal(await ask("@installed"), true);
		assert.deepEqual(await followers(), { live: 1, refreshes: 1 }, "one refresh, the new harness's");
	} finally {
		await t.close(context);
		await rm(root, { recursive: true, force: true });
	}
});
