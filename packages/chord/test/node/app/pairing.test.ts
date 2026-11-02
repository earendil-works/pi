// Tests of device pairing (slice 13 §2): a client asks for a code, the owner approves it in a signed-in browser, the
// client's poll gets a device token once; codes are unambiguous, owner-only to approve, single use, and expire.

import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { Sessions } from "../../../src/node/app/index.ts";
import { Pairings } from "../../../src/node/app/pairing.ts";
import { send } from "../http/support.ts";
import { testApp } from "./support.ts";

/** A JSON post to `path`. */
function post(port: number, path: string, body: unknown, headers: Readonly<Record<string, string>> = {}) {
	return send(port, "POST", path, {
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
}

/** The JSON body of an answer. */
function json(answer: { readonly body: Buffer }): unknown {
	return JSON.parse(answer.body.toString());
}

/** An anonymous client at `address`, as a pairing's starter. */
function anonymous(address: string) {
	return { kind: "anonymous", address } as const;
}

afterEach(() => {
	vi.useRealTimers();
});

describe("pairing over HTTP", () => {
	it("pairs a client: code, owner approval, one poll with the token, then nothing", async () => {
		const { app, port } = await testApp();
		const owner = {
			authorization: `Bearer ${await app.host.root(async (ctx) => {
				const sessions = await ctx.get(Sessions, {});
				return (await sessions.issue({ principal: { kind: "owner" }, label: "owner", kind: "device" }, ctx)).token;
			}, context)}`,
		};
		const begun = (await post(port, "/_chord/pair", { label: "laptop" })) as { status: number; body: Buffer };
		const { code, poll } = json(begun) as { code: string; poll: string };
		expect(code).toMatch(/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
		expect(json(await post(port, "/_chord/pair/poll", { poll }))).toEqual({ status: "waiting" });
		// Anonymous and non-owner principals cannot see or approve it.
		expect((await send(port, "GET", `/_chord/pair/${code}`)).status).toBe(401);
		const user = await app.host.root(
			async (ctx) =>
				(await ctx.get(Sessions, {})).issue(
					{ principal: { kind: "user", id: "u", name: "u" }, label: "u", kind: "device" },
					ctx,
				),
			context,
		);
		expect(
			(await send(port, "POST", `/_chord/pair/${code}`, { headers: { authorization: `Bearer ${user.token}` } }))
				.status,
		).toBe(403);
		const page = await send(port, "GET", `/_chord/pair/${code.toLowerCase()}`, { headers: owner });
		expect(page.body.toString()).toContain("laptop");
		expect((await send(port, "POST", `/_chord/pair/${code}`, { headers: owner })).status).toBe(200);
		// Approved once: the code is no longer waiting.
		expect((await send(port, "POST", `/_chord/pair/${code}`, { headers: owner })).status).toBe(404);
		const approved = json(await post(port, "/_chord/pair/poll", { poll })) as { status: string; token: string };
		expect(approved.status).toBe("approved");
		expect((await post(port, "/_chord/pair/poll", { poll })).status).toBe(404);
		const listed = await app.host.root(async (ctx) => (await ctx.get(Sessions, {})).list.value, context);
		const id = approved.token.slice(0, approved.token.indexOf("."));
		expect(listed.find((session) => session.id === id)).toMatchObject({
			label: "laptop",
			kind: "device",
			principal: { kind: "owner" },
		});
		await app.close(context);
	});

	it("refuses an unknown poll secret", async () => {
		const { app, port } = await testApp();
		expect((await post(port, "/_chord/pair/poll", { poll: "nope" })).status).toBe(404);
		expect((await post(port, "/_chord/pair/poll", {})).status).toBe(404);
		await app.close(context);
	});
});

describe("limits", () => {
	it("refuses pairings past the limit per client address and in all with 429", async () => {
		const { app, port } = await testApp({ limits: { pendingPairings: 5, pairingsPerAddress: 3 } });
		const statuses = [];
		for (let index = 0; index < 4; index++) statuses.push((await post(port, "/_chord/pair", {})).status);
		expect(statuses).toEqual([200, 200, 200, 429]);
		await app.close(context);
		const pairings = new Pairings({ maxPending: 5, perAddress: 3 });
		const begun = ["a", "a", "b", "b", "c", "c", "d"].map(
			(address) => pairings.begin("x", anonymous(address)) !== undefined,
		);
		expect(begun).toEqual([true, true, true, true, true, false, false]);
	});

	it("frees a client address's place once its pairing ends", () => {
		const pairings = new Pairings({ perAddress: 1 });
		const first = pairings.begin("x", anonymous("a"))!;
		expect(pairings.begin("x", anonymous("a"))).toBeUndefined();
		const pairing = pairings.waiting(first.code)!;
		pairing.token = "t";
		expect(pairings.poll(first.poll)).toEqual({ kind: "approved", token: "t" });
		expect(pairings.begin("x", anonymous("a"))).toBeDefined();
	});

	it("lets the signed-in owner pair past the caps, without counting it (recheck N2)", async () => {
		const { app, port } = await testApp({ limits: { pendingPairings: 1, pairingsPerAddress: 1 } });
		const { token } = await app.host.root(
			async (ctx) =>
				(await ctx.get(Sessions, {})).issue({ principal: { kind: "owner" }, label: "o", kind: "device" }, ctx),
			context,
		);
		const owner = { authorization: `Bearer ${token}` };
		expect((await post(port, "/_chord/pair", {})).status).toBe(200);
		expect((await post(port, "/_chord/pair", {})).status).toBe(429);
		const statuses = [];
		for (let index = 0; index < 3; index++) statuses.push((await post(port, "/_chord/pair", {}, owner)).status);
		expect(statuses).toEqual([200, 200, 200]);
		await app.close(context);
		const pairings = new Pairings({ maxPending: 1 });
		expect([pairings.begin("x", { kind: "owner" }), pairings.begin("x", anonymous("a"))].every(Boolean)).toBe(true);
	});
});

describe("pairing codes", () => {
	it("expire after 10 minutes, for the owner and the poll alike", () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const pairings = new Pairings();
		const { code, poll } = pairings.begin("device", anonymous("1.2.3.4"))!;
		vi.advanceTimersByTime(10 * 60_000 - 1);
		expect(pairings.waiting(code)).toBeDefined();
		vi.advanceTimersByTime(1);
		expect(pairings.waiting(code)).toBeUndefined();
		expect(pairings.poll(poll)).toBeUndefined();
	});

	it("are distinct", () => {
		const pairings = new Pairings({ maxPending: 200 });
		const codes = new Set(
			Array.from({ length: 200 }, (_, index) => pairings.begin("d", anonymous(String(index)))!.code),
		);
		expect(codes.size).toBe(200);
	});
});
