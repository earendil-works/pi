// Tests of the authenticators: asked in contributor order, the first principal wins, a throwing one reported and
// skipped, none: anonymous.

import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context, withAbortSignal } from "../../../src/context/index.ts";
import type { RegistryTable } from "../../../src/next/registries/index.ts";
import { type Authenticator, authenticate, composeAuthenticators } from "../../../src/next-node/http/authenticate.ts";
import type { HttpRequest } from "../../../src/next-node/http/index.ts";

const request = { headers: new Headers() } as HttpRequest;

describe("authenticators", () => {
	it("are asked in contributor order; the first principal wins; a throwing one is reported and skipped", async () => {
		const asked: string[] = [];
		const answer = (name: string, principal: { kind: string }) => {
			asked.push(name);
			return principal;
		};
		const table: RegistryTable<Authenticator> = [
			{ plugin: "@app/a", version: 1, value: () => void asked.push("a") },
			{
				plugin: "@app/b",
				version: 1,
				value: () => {
					asked.push("b");
					throw new Error("broken");
				},
			},
			{ plugin: "@app/c", version: 1, value: async () => answer("c", { kind: "owner" }) },
			{ plugin: "@app/d", version: 1, value: () => answer("d", { kind: "guest" }) },
		];
		const failed: [string, unknown][] = [];
		const principal = await authenticate(
			composeAuthenticators(table),
			request,
			(plugin, error) => failed.push([plugin, error]),
			context,
		);
		expect([principal, asked, failed]).toEqual([
			{ kind: "owner" },
			["a", "b", "c"],
			[["@app/b", new Error("broken")]],
		]);
	});

	// Sol's second recheck C: a fresh authenticator started after the request was cancelled.
	it("start no authenticator once the context is aborted", async () => {
		let calls = 0;
		const table: RegistryTable<Authenticator> = [{ plugin: "@app/a", version: 1, value: () => void calls++ }];
		const aborted = withAbortSignal(AbortSignal.abort(), context);
		expect(await authenticate(composeAuthenticators(table), request, () => {}, aborted)).toBeUndefined();
		expect(calls).toBe(0);
	});

	it("give no principal when none knows the request", async () => {
		expect(await authenticate([], request, () => {}, context)).toBeUndefined();
	});
});
