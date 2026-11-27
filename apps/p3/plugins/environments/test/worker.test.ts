// The machine kind's harness part, as the worker facet contributes it to `ThingHarnessParts`, given the machines a
// session's agent holds (real references, held as the session's worker on a server with the things plugin,
// `kindServer`): a location on a held machine of this device's type with Work here gets a Node environment in its
// folder, and the prompt line names that machine (not the first one held) and the folder; a machine held without Work
// here, not held, of another type, or whose type is gone gets none, and the prompt says no machine is available; a
// machine hidden in the agent's workspace is not held there at all. Holding a machine costs no query run per holder
// after the first (its info is one object per machine).

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	type Ctx,
	BACKGROUND_CONTEXT as context,
	defineFacet,
	obj,
	type P3Principal,
	str,
	until,
} from "@earendil-works/p3/v1";
import { type ServerRuntime, ServerRuntime as ServerRuntimeRegistry } from "@earendil-works/p3/v1/server";
import { within } from "../../../test/until.ts";
import { OneThing } from "../../things/contract.server.ts";
import type { HarnessContribution, HarnessExtension, HarnessLocation } from "../../things/contract.worker.ts";
import { BY, type KindServer, kindServer, refused } from "../../things/test/kind-server.ts";
import { MACHINE_KIND } from "../contract.ts";
import { type Machine, MachineKind } from "../kind.ts";
import environmentsServer from "../server.ts";
import { MachinesStore } from "../store.ts";
import { fakeMachine, fakeType } from "./fake-machine.ts";
import { seeded } from "./seeded.ts";

/** The environments plugin's root. */
const ROOT = fileURLToPath(new URL("../", import.meta.url));

/** The session's agent as a party. */
const AGENT = { kind: "agent", session: "s1" } as const;

/** Where the tests' conversations work, on machine `machine`. */
const at = (machine: string): HarnessLocation => ({ machine, folder: "/tmp" });

let k: KindServer<typeof Machine>;
let dataDir: string;
let device: string;
let s1: string;

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "p3-machine-part-"));
	const runtime = { dataDir, workRoot: join(dataDir, "work"), machine: { user: "test", hostname: "test" } };
	const beside = [
		{
			name: "p3.server",
			facet: defineFacet((host) => host.serve(ServerRuntimeRegistry, { compose: () => runtime as ServerRuntime })),
		},
		// A machine type of the test's, `remote`, whose machines are stand-ins.
		{
			name: "@earendil-works/p3-a-remote-type",
			facet: fakeType(() => fakeMachine().host, "remote", obj({ host: str() })),
		},
	];
	const plugin = { name: "@earendil-works/p3-environments", root: ROOT, server: environmentsServer };
	k = await kindServer(plugin, MachineKind, context, beside);
	device = await seeded(await k.host.get(OneThing, { kind: MACHINE_KIND }, context), context);
	s1 = await k.workspace("s1");
});

afterEach(async () => {
	await k.close();
	await rm(dataDir, { recursive: true, force: true });
});

/** Makes machine `name` in Pi from `input`, as a plugin does; its id. */
const made = (name: string, input: unknown) =>
	k.things.create({ kind: MACHINE_KIND, name, workspace: k.pi, by: BY, input }, context);

/** Runs `fn` with s1's agent holding `machines`, its conversations working at `location`. */
const giving = <T>(
	machines: readonly string[],
	location: HarnessLocation,
	fn: (contribution: HarnessContribution, ctx: Ctx<P3Principal>) => Promise<T>,
) =>
	k.giving({ session: "s1", workspace: s1, location }, machines, (_e, ctx, _h, contribution) => fn(contribution, ctx));

/** The prompt line of `extension` for environment `env`. */
async function line(extension: HarnessExtension | undefined, env: { cwd: string } | undefined, ctx: Ctx<P3Principal>) {
	const [section] = extension?.sections ?? [];
	// The section reads only `conversationId` and `env` of its input.
	return section?.render({ conversationId: 1, env } as never, ctx);
}

describe("the machine's harness part", () => {
	it("gives a Node environment in the folder of a location on this device's machine with Work here", async () => {
		await giving([device], at(device), async ({ env, extension }, ctx) => {
			const given = await env?.(at(device), ctx);
			assert.equal(given?.cwd, "/tmp");
			assert.equal(await line(extension, given, ctx), `Tools run on ${hostname()}, in /tmp.`);
		});
	});

	it("names the machine the conversation works on, not the first one held (Opus, round 2)", async () => {
		const laptop = await made("laptop", { type: "local", settings: {} });
		await giving([device, laptop], at(laptop), async ({ env, extension }, ctx) => {
			assert.equal(await line(extension, await env?.(at(laptop), ctx), ctx), "Tools run on laptop, in /tmp.");
		});
	});

	it("gives none on a machine held without Work here, or not held", async () => {
		await k.tick(k.pi, device, AGENT, "work", false);
		await giving([device], at(device), async ({ env, extension }, ctx) => {
			assert.equal(await env?.(at(device), ctx), undefined);
			assert.equal(await line(extension, undefined, ctx), "No machine is available here: commands cannot run.");
		});
		await giving([], at(device), async ({ env }, ctx) => assert.equal(await env?.(at(device), ctx), undefined));
	});

	// Astra, round 5: a machine of another type, or one whose type was gone, ran its commands on the worker's device.
	it("gives none on a machine of another type, or on one whose type is gone", async () => {
		const box = await made("box", { type: "remote", settings: { host: "box.lan" } });
		await giving([box], at(box), async ({ env }, ctx) => assert.equal(await env?.(at(box), ctx), undefined));
		await (await k.host.get(MachinesStore, {}, context)).put({ machine: box, type: "gone", settings: {} }, context);
		const where = { session: "s1", workspace: s1, location: at(box) };
		await k.giving(where, [box], async (_extension, ctx, [held], { env }) => {
			await until(held!.ref.info, (info) => info.status === "unavailable", within("its info", ctx));
			assert.equal(await env?.(at(box), ctx), undefined);
		});
	});

	it("is not held in a workspace that hides the machine (guide 8.3)", async () => {
		await k.things.setSwitch({ workspace: s1, item: { kind: "thing", thing: device }, shown: false }, context);
		await refused(
			k.holding({ kind: "worker", session: "s1" }, s1, device, async () => null),
			"forbidden",
		);
	});
});

describe("the cost of holding a machine", () => {
	it("is no query run per holder after the first: its info is one object per machine", async () => {
		const persons = [await k.person("Ann"), await k.person("Ben"), await k.person("Cy")];
		const first = await k.holders(persons.slice(0, 1), k.pi, device);
		try {
			const before = k.count("chord.query.runs");
			const more = await k.holders(persons.slice(1), k.pi, device);
			await more.release();
			assert.equal(k.count("chord.query.runs") - before, 0);
		} finally {
			await first.release();
		}
	});
});
