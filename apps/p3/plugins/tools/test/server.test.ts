// The tools plugin on the server (`kindServer`: its server facet beside the things plugin's): the coding tools are
// one thing in Pi, made by the plugin; the session's agent gets the four ticks by default, a person put in and the
// owner none (the ticks are the agents'); a tick withheld leaves the rest on the same hold, live; a workspace hiding
// them denies them there and only there; a nearer coding tools thing is the one the agent gets (`stacking:
// "nearest"`); the agent's hold stays across a reload of the plugin; a released hold is collected.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context, type P3Principal, until } from "@earendil-works/p3/v1";
import { collected, within } from "../../../test/until.ts";
import { OneThing } from "../../things/contract.server.ts";
import { ThingKinds } from "../../things/kind.ts";
import { BY, type KindServer, kindServer, refused } from "../../things/test/kind-server.ts";
import { type CodingTools, CodingToolsKind } from "../kind.ts";
import toolsServer from "../server.ts";

/** The tools plugin's root. */
const ROOT = fileURLToPath(new URL("../", import.meta.url));

/** The session's agent of workspace `s1`. */
const AGENT: P3Principal = { kind: "worker", session: "s1" };

/** The same agent as a party. */
const AGENT_PARTY = { kind: "agent", session: "s1" } as const;

/** Every tick of the coding tools, sorted. */
const ALL = ["bash", "edit", "read", "write"];

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

describe("the kind", () => {
	it("is registered by the tools plugin, which makes the one thing in Pi", async () => {
		const entry = (await n.host.registry(ThingKinds, context)).value.get(CodingToolsKind.name);
		assert.deepEqual([entry?.plugin, entry?.value.makers], ["@earendil-works/p3-tools", "plugin"]);
		// `OneThing` finds the thing its plugin made.
		assert.notEqual(tools, "");
	});
});

describe("who may use the coding tools", () => {
	it("gives the session's agent every tick; a person put in and the owner get none", async () => {
		assert.deepEqual(await n.granted(AGENT, s1, tools), ALL);
		await refused(n.granted(await n.person("Ann"), n.pi, tools));
		const id = await n.things.createPerson({ name: "Olga", madeBy: BY }, context);
		await n.things.setOwner({ person: id, owner: true }, context);
		assert.deepEqual(await n.granted({ kind: "person", id, name: "Olga" }, n.pi, tools), []);
	});

	it("follows a tick withheld from the agent live, on the same hold", async () => {
		await n.holding(AGENT, s1, tools, async (held, ctx) => {
			await n.tick(n.pi, tools, AGENT_PARTY, "bash", false);
			await until(held.state, () => !held.granted.has("bash"), within("Bash withheld", ctx));
			assert.deepEqual([...held.granted].sort(), ["edit", "read", "write"]);
		});
	});

	it("are denied in a workspace that hides them, live, and still given where they are shown", async () => {
		const s2 = await n.workspace("s2");
		await n.holding(AGENT, s1, tools, async (held, ctx) => {
			await n.things.setSwitch({ workspace: s1, item: { kind: "thing", thing: tools }, shown: false }, context);
			await until(
				held.state,
				(state) => state.kind === "failed" && state.cause.kind === "denied",
				within("hidden in s1", ctx),
			);
		});
		assert.deepEqual(await n.granted({ kind: "worker", session: "s2" }, s2, tools), ALL);
	});

	it("give the agent the nearest coding tools thing: one linked in its workspace hides Pi's there", async () => {
		const near = await n.thingIn(s1);
		await n.tick(s1, near, AGENT_PARTY, "bash", false);
		assert.deepEqual(await n.granted(AGENT, s1, near), ["edit", "read", "write"]);
		await refused(n.granted(AGENT, s1, tools));
	});
});

describe("a held coding tools thing", () => {
	it("keeps the agent's hold and its ticks across a reload of the plugin", async () => {
		await n.holding(AGENT, s1, tools, async (held, ctx) => {
			await n.reload();
			await n.tick(n.pi, tools, AGENT_PARTY, "read", false);
			await until(held.state, () => !held.granted.has("read"), within("Read withheld after the reload", ctx));
			assert.equal(held.state.value.kind, "live");
		});
	});

	it("is collected once released", async () => {
		const refs: WeakRef<object>[] = [];
		await n.holding(AGENT, s1, tools, async (held) => {
			refs.push(new WeakRef(held));
		});
		assert.ok(await collected(refs));
	});
});
