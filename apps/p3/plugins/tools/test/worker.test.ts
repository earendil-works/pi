// The coding tools' harness part, as the worker facet contributes it to `ThingHarnessParts`, given the coding tools
// an agent holds (real references, held as the session's worker on a server with the things plugin, `kindServer`): it
// is the facet's one part; it gives Durable's coding tools whose tick the agent has, only the tools (the harness names
// the extension), and nothing once every tick is withheld. Which coding tools thing an agent holds (the nearest) is the
// admission's (`server.test.ts`); a tick withheld while a call runs is the harness's test (the call finishes).

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context, until } from "@earendil-works/p3/v1";
import { within } from "../../../test/until.ts";
import { OneThing } from "../../things/contract.server.ts";
import { type HarnessExtension, ThingHarnessParts } from "../../things/contract.worker.ts";
import { type KindServer, kindServer, toolNames } from "../../things/test/kind-server.ts";
import { type CodingTools, CodingToolsKind } from "../kind.ts";
import toolsServer from "../server.ts";

/** The tools plugin's root. */
const ROOT = fileURLToPath(new URL("../", import.meta.url));

/** The session's agent as a party. */
const AGENT_PARTY = { kind: "agent", session: "s1" } as const;

let n: KindServer<typeof CodingTools>;
let s1: string;
let tools: string;

beforeEach(async () => {
	n = await kindServer(
		{ name: "@earendil-works/p3-tools", root: ROOT, server: toolsServer },
		CodingToolsKind,
		context,
	);
	s1 = await n.workspace("s1");
	const one = await n.host.get(OneThing, { kind: CodingToolsKind.name }, context);
	tools = await until(one.thing, (thing) => thing !== "", within("the coding tools", context));
	one.release();
});

afterEach(() => n.close());

/** The names of the tools s1's agent gets holding `things` there, in that order. */
const given = (...things: string[]) =>
	n.giving({ session: "s1", workspace: s1 }, things, async (extension: HarnessExtension) => toolNames(extension));

describe("the coding tools' harness part", () => {
	it("is the worker facet's one part, for the coding tools", async () => {
		assert.deepEqual(
			(await n.worker("s1")).contributions(ThingHarnessParts).map(({ value }) => value.kind.name),
			[CodingToolsKind.name],
		);
	});

	it("gives each coding tool while its tick is granted, and only the tools", async () => {
		await n.giving({ session: "s1", workspace: s1 }, [tools], async (extension) => {
			assert.deepEqual(Object.keys(extension), ["tools"]);
			assert.deepEqual(toolNames(extension), ["bash", "edit", "read", "write"]);
		});
		await n.tick(n.pi, tools, AGENT_PARTY, "bash", false);
		assert.deepEqual(await given(tools), ["edit", "read", "write"]);
		for (const tick of ["write", "edit"]) await n.tick(n.pi, tools, AGENT_PARTY, tick, false);
		assert.deepEqual(await given(tools), ["read"]);
	});

	it("gives nothing once every tick is withheld", async () => {
		for (const tick of ["read", "write", "edit", "bash"]) await n.tick(n.pi, tools, AGENT_PARTY, tick, false);
		await assert.rejects(given(tools), /gave no extension/);
	});
});
