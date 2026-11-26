// The providers plugin reloaded while it is used: an agent's login held across the reload rebinds on the same hold and
// still answers its request auth (the credential is in the store); a person's running sign-in ends with the old
// object, and a new one runs on the new; nothing is reported.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	BACKGROUND_CONTEXT as context,
	defineFacet,
	LoginProviders,
	type P3Principal,
	type Reference,
	until,
} from "@earendil-works/p3/v1";
import { fauxProvider } from "@earendil-works/p3/v1/server";
import { FAUX_PROVIDER, keyOf, type Step } from "../../../test/plugins/faux-login/contract.ts";
import { within } from "../../../test/until.ts";
import { ThingsStore } from "../../things/contract.server.ts";
import type { Source } from "../../things/contract.ts";
import type { World } from "../../things/test/world.ts";
import { Login, SignIn } from "../contract.ts";
import { makeLogin } from "../logins.ts";
import { PROVIDERS, providersWorld } from "./hosts.ts";

/** Who sets things up. */
const BY: Source = { kind: "plugin", plugin: "test" };

/** A faux script. */
const SCRIPT: Step[] = [{ when: "", reply: [{ kind: "text", text: "hi" }] }];

/** How many sign-ins of the waiting provider ended (their flow's signal aborted). */
const waiting = { ended: 0 };

/** A provider (`waiting`) whose API-key sign-in asks a question and counts the flows that ended before an answer. */
const waitingStub = defineFacet((_host, self) => {
	const base = fauxProvider({ provider: "waiting", api: "waiting", models: [{ id: "m" }] }).provider;
	self.contribute(LoginProviders, [
		{
			...base,
			auth: {
				apiKey: {
					name: "Waiting",
					login: async (interaction) => {
						interaction.signal.addEventListener("abort", () => waiting.ended++, { once: true });
						return { type: "api_key", key: await interaction.prompt({ type: "secret", message: "key" }) };
					},
					resolve: async () => undefined,
				},
			},
		},
	]);
});

let w: World;
let things: Reference<typeof ThingsStore>;
let workspace: string;

beforeEach(async () => {
	waiting.ended = 0;
	w = await providersWorld(context, new Set(["person:ann"]), [{ name: "waiting", facet: waitingStub }]);
	things = await w.host.get(ThingsStore, {}, context);
	const pi = (await things.workspaces.children.page({ parent: "" }, 1, context)).items[0]!.workspace;
	workspace = await things.createWorkspace({ kind: "things.workspace", name: "s1", parent: pi, by: BY }, context);
	await things.putParty({ workspace, party: { kind: "agent", session: "s1" }, source: BY }, context);
});

afterEach(() => w.close(context));

describe("a reload of the providers plugin while it is used", () => {
	it("keeps an agent's held login answering; ends a running sign-in; a new one runs; nothing reported", async () => {
		const agent: P3Principal = { kind: "worker", session: "s1" };
		const ann: P3Principal = { kind: "person", id: "ann", name: "Ann" };
		const credential = { type: "api_key", key: keyOf(SCRIPT) };
		const thing = await w.host.root(
			(ctx) => makeLogin({ name: "Faux", workspace, by: BY, provider: FAUX_PROVIDER, credential }, ctx),
			context,
		);
		await w.host.root(
			async (ctx) => {
				const flow = await ctx.get(SignIn, {});
				await flow.start({ provider: "waiting", method: "api_key" }, ctx);
				await until(flow.attempt, (now) => now?.status === "working" && now.prompt !== null, within("asked", ctx));
				await w.host.root(
					async (agentCtx) => {
						const login = await agentCtx.get(Login, { workspace, thing });
						assert.equal((await login.authorize!({}, agentCtx)).auth.apiKey, credential.key);
						await w.reload(PROVIDERS, context);
						await until(
							login.state,
							(state) => state.kind === "live",
							within("the login after the reload", agentCtx),
						);
						assert.equal((await login.authorize!({}, agentCtx)).auth.apiKey, credential.key);
					},
					context,
					{ principal: agent },
				);
				await until(flow.attempt, (now) => now === null, within("the old sign-in gone", ctx));
				assert.equal(waiting.ended, 1, "the old object's flow ended with it");
				const next = await flow.start({ provider: FAUX_PROVIDER, method: "api_key" }, ctx);
				const asked = await until(
					flow.attempt,
					(now) => now?.attempt === next && now.status === "working" && now.prompt !== null,
					within("the new sign-in", ctx),
				);
				assert.ok(asked?.status === "working" && asked.prompt !== null);
				await flow.answer({ prompt: asked.prompt.id, value: credential.key }, ctx);
				await until(flow.attempt, (now) => now?.status === "done", within("its end", ctx));
			},
			context,
			{ principal: ann },
		);
		assert.deepEqual(w.errors, []);
	});
});
