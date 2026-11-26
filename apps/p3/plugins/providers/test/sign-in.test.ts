// Signing in (`sign-in.ts`) on a whole server host: starts that come at once run one provider flow at a time, the last
// one shown; a server that stops while a question is open stops cleanly; a sign-in that takes too long ends expired
// (Astra's reproductions, round 1, and the deadline).

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import {
	BACKGROUND_CONTEXT as context,
	defineFacet,
	LoginProviders,
	type P3Principal,
	type PluginFacet,
	until,
} from "@earendil-works/p3/v1";
import { fauxProvider } from "@earendil-works/p3/v1/server";
import { FAUX_PROVIDER } from "../../../test/plugins/faux-login/contract.ts";
import { within } from "../../../test/until.ts";
import { SignIn } from "../contract.ts";
import { providersWorld } from "./hosts.ts";

/** The owner, who may sign in. */
const ANN: P3Principal = { kind: "person", id: "ann", name: "Ann" };

/** The owners' `callerKey`s. */
const OWNERS = new Set(["person:ann"]);

describe("starts at once", () => {
	it("run one provider flow at a time, and the last one is shown", async () => {
		const firstEnded = Promise.withResolvers<void>();
		const finishing = Promise.withResolvers<void>();
		const counts = { active: 0, most: 0, calls: 0 };
		const gated: PluginFacet<P3Principal> = {
			name: "gated",
			facet: defineFacet((_host, self) =>
				self.contribute(LoginProviders, [
					{
						...fauxProvider({ provider: "gated", api: "gated", models: [{ id: "m" }] }).provider,
						auth: {
							apiKey: {
								name: "gated",
								resolve: async () => undefined,
								login: async (interaction) => {
									const call = ++counts.calls;
									counts.most = Math.max(counts.most, ++counts.active);
									try {
										await interaction.prompt({ type: "secret", message: "key" });
									} finally {
										// The first flow takes a while to end: the starts after it wait for it.
										if (call === 1) {
											firstEnded.resolve();
											await finishing.promise;
										}
										counts.active--;
									}
									return { type: "api_key", key: "k" };
								},
							},
						},
					},
				]),
			),
		};
		const w = await providersWorld(context, OWNERS, [gated]);
		try {
			await w.host.root(
				async (ctx) => {
					const flow = await ctx.get(SignIn, {});
					const start = () => flow.start({ provider: "gated", method: "api_key" }, ctx);
					await start();
					await until(
						flow.attempt,
						(now) => now?.status === "working" && now.prompt !== null,
						within("asked", ctx),
					);
					const second = start();
					await firstEnded.promise;
					const third = start();
					await new Promise((resolve) => setImmediate(resolve));
					finishing.resolve();
					const [, last] = await Promise.all([second, third]);
					await until(
						flow.attempt,
						(now) => now?.attempt === last && now.status === "working" && now.prompt !== null,
						within("the last", ctx),
					);
					assert.equal(counts.most, 1);
				},
				context,
				{ principal: ANN },
			);
		} finally {
			await w.close(context);
		}
	});
});

describe("a server stopping", () => {
	it("while a question is open stops cleanly", async () => {
		const w = await providersWorld(context, OWNERS);
		const unhandled: unknown[] = [];
		const record = (error: unknown) => unhandled.push(error);
		process.on("uncaughtException", record);
		process.on("unhandledRejection", record);
		try {
			await w.host.root(
				async (ctx) => {
					const flow = await ctx.get(SignIn, {});
					await flow.start({ provider: FAUX_PROVIDER, method: "api_key" }, ctx);
					await until(
						flow.attempt,
						(now) => now?.status === "working" && now.prompt !== null,
						within("asked", ctx),
					);
				},
				context,
				{ principal: ANN },
			);
			await w.close(context);
			await new Promise((resolve) => setTimeout(resolve, 50));
			assert.deepEqual(unhandled, []);
			assert.deepEqual(w.errors, []);
		} finally {
			process.off("uncaughtException", record);
			process.off("unhandledRejection", record);
		}
	});
});

describe("a sign-in taking too long", () => {
	it("ends expired after ten minutes", async () => {
		const w = await providersWorld(context, OWNERS);
		try {
			await w.host.root(
				async (ctx) => {
					const flow = await ctx.get(SignIn, {});
					mock.timers.enable({ apis: ["setTimeout"] });
					try {
						await flow.start({ provider: FAUX_PROVIDER, method: "api_key" }, ctx);
						mock.timers.tick(10 * 60_000);
					} finally {
						mock.timers.reset();
					}
					const ended = await until(flow.attempt, (now) => now?.status === "ended", within("the end", ctx));
					assert.ok(ended?.status === "ended");
					assert.equal(ended.message.key, "expired");
				},
				context,
				{ principal: ANN },
			);
		} finally {
			await w.close(context);
		}
	});
});
