// The terminals' harness part, as the worker facet contributes it to `ThingHarnessParts`, given the Terminals a
// session's agent holds (real references, held as the session's worker on a server with the things and environments
// plugins and a stand-in machine whose programs are fakes, `kindServer`): no tool without Use; with it, one tool
// `terminal` whose tagged action lists the terminals (JSON), opens one at the conversation's location, types a line
// (Enter after it) or keys, reads the output as plain text (at once, or once the output went quiet) and closes; Use
// withheld after the part was built refuses the next call (forbidden), a conversation on no machine refuses to open
// (invalid). Holding Terminals costs no query run per holder: the list is the terminal host's, in memory.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	type Ctx,
	BACKGROUND_CONTEXT as context,
	defineFacet,
	type P3Principal,
	type PluginFacet,
	until,
} from "@earendil-works/p3/v1";
import { type ServerRuntime, ServerRuntime as ServerRuntimeRegistry } from "@earendil-works/p3/v1/server";
import { within } from "../../../test/until.ts";
import { MACHINE_KIND } from "../../environments/contract.ts";
import environmentsServer from "../../environments/server.ts";
import { type FakeMachine, fakeMachine, fakeType } from "../../environments/test/fake-machine.ts";
import { seeded } from "../../environments/test/seeded.ts";
import { OneThing } from "../../things/contract.server.ts";
import type { HarnessExtension, HarnessLocation, HeldThing } from "../../things/contract.worker.ts";
import { type KindServer, kindServer, refused, runTool, toolNames } from "../../things/test/kind-server.ts";
import { QUIET, type Terminals, TerminalsKind } from "../kind.ts";
import terminalsServer from "../server.ts";

/** The terminals plugin's root. */
const ROOT = fileURLToPath(new URL("../", import.meta.url));

/** The session's agent as a party. */
const AGENT = { kind: "agent", session: "s1" } as const;

let k: KindServer<typeof Terminals>;
let device: FakeMachine;
let dataDir: string;
let terminals: string;
let machine: string;
let s1: string;

beforeEach(async () => {
	device = fakeMachine();
	dataDir = await mkdtemp(join(tmpdir(), "p3-terminals-part-"));
	// This device's type, its plugin name sorting first: programs are fakes.
	await started([{ name: "@earendil-works/p3-a-fake", facet: fakeType(() => device.host) }]);
});

/** Starts the terminals plugin beside the environments plugin and `types` (machine types), with s1's workspace. */
async function started(types: readonly PluginFacet<P3Principal>[]): Promise<void> {
	const runtime = { dataDir, workRoot: join(dataDir, "work"), machine: { user: "test", hostname: "test" } };
	const beside = [
		{
			name: "p3.server",
			facet: defineFacet((host) => host.serve(ServerRuntimeRegistry, { compose: () => runtime as ServerRuntime })),
		},
		...types,
		{ name: "@earendil-works/p3-environments", facet: environmentsServer },
	];
	const plugin = { name: "@earendil-works/p3-terminals", root: ROOT, server: terminalsServer };
	k = await kindServer(plugin, TerminalsKind, context, beside);
	terminals = await seeded(await k.host.get(OneThing, { kind: TerminalsKind.name }, context), context);
	machine = await seeded(await k.host.get(OneThing, { kind: MACHINE_KIND }, context), context);
	s1 = await k.workspace("s1");
}

afterEach(async () => {
	await k.close();
	await rm(dataDir, { recursive: true, force: true });
});

/**
 * Runs `fn` with s1's agent holding Pi's Terminals, its conversations working at `location` (`/work` by default; `null`:
 * on no machine).
 */
const giving = <T>(
	fn: (extension: HarnessExtension, ctx: Ctx<P3Principal>, held: readonly HeldThing<typeof Terminals>[]) => Promise<T>,
	location: HarnessLocation | null = { machine, folder: "/work" },
) => k.giving({ session: "s1", workspace: s1, ...(location === null ? {} : { location }) }, [terminals], fn);

/** Runs the tool's `action` in `extension`; its output text. */
const terminal = (extension: HarnessExtension, action: object, ctx: Ctx<P3Principal>) =>
	runTool(extension, "terminal", { action }, ctx);

describe("the terminals' harness part", () => {
	it("gives no tool without Use", async () => {
		await k.tick(k.pi, terminals, AGENT, "use", false);
		// A part that gives nothing gives no extension.
		await assert.rejects(
			giving(async () => null),
			/gave no extension/,
		);
	});

	it("gives one tool whose tagged action lists, opens at the location, types, reads plain text and closes", async () => {
		await giving(async (extension, ctx, [held]) => {
			assert.deepEqual(toolNames(extension), ["terminal"]);
			assert.deepEqual(JSON.parse(await terminal(extension, { kind: "list" }, ctx)), []);
			const opened = JSON.parse(await terminal(extension, { kind: "open" }, ctx));
			assert.equal(opened.folder, "/work");
			const [program] = device.started;
			assert.deepEqual([program?.options.cwd, program?.size], ["/work", [120, 40]]);
			await until(held!.ref.terminals!, (list) => list.length === 1, within("the list", ctx));
			assert.deepEqual(JSON.parse(await terminal(extension, { kind: "list" }, ctx)), [
				{ id: opened.terminal, folder: "/work", exitCode: null },
			]);
			await terminal(extension, { kind: "type", terminal: opened.terminal, input: "ls" }, ctx);
			await terminal(extension, { kind: "keys", terminal: opened.terminal, input: "q" }, ctx);
			assert.deepEqual(program?.typed, ["ls\r", "q"]);
			program?.say("\u001b[1m$ \u001b[0mls\r\nREADME.md\r\n");
			assert.equal(await terminal(extension, { kind: "read", terminal: opened.terminal }, ctx), "$ ls\nREADME.md\n");
			// A read that waits answers once the output paused for `QUIET`: all of what came meanwhile.
			const reading = terminal(extension, { kind: "read", terminal: opened.terminal, wait_ms: 10_000 }, ctx);
			program?.say("build ");
			setTimeout(() => program?.say("done\r\n"), QUIET / 2);
			assert.equal(await reading, "$ ls\nREADME.md\nbuild done\n");
			assert.equal(await terminal(extension, { kind: "close", terminal: opened.terminal }, ctx), "{}");
			assert.equal(program?.closed, true);
		});
	});

	it("refuses to open where the conversation works on no machine, and once Use is withheld", async () => {
		await giving(async (extension, ctx) => {
			await refused(terminal(extension, { kind: "open" }, ctx), "invalid");
		}, null);
		await giving(async (extension, ctx, [held]) => {
			await k.tick(k.pi, terminals, AGENT, "use", false);
			// The holding's reference loses its members in the flush in which Use is withheld.
			await until(held!.ref.state, () => held!.ref.open === undefined, within("Use withheld", ctx));
			await refused(terminal(extension, { kind: "list" }, ctx), "forbidden");
		});
	});
});

describe("the cost of holding Terminals", () => {
	it("is no query run per holder after the first: the list is the terminal host's", async () => {
		const persons = [await k.person("Ann"), await k.person("Ben"), await k.person("Cy")];
		for (const person of persons) await k.tick(k.pi, terminals, { kind: "person", person: person.id }, "watch", true);
		const first = await k.holders(persons.slice(0, 1), k.pi, terminals);
		try {
			const before = k.count("chord.query.runs");
			const more = await k.holders(persons.slice(1), k.pi, terminals);
			await more.release();
			assert.equal(k.count("chord.query.runs") - before, 0);
		} finally {
			await first.release();
		}
	});
});
