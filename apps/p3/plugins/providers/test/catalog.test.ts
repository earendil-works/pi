// The pi.dev catalog's pure steps (`catalog.ts`): the request asks for the provider's chat models (no `?types`) as the
// given client, revalidating only a stored body; an answer is a new body (a map of checked chat models by id under the
// provider's id; no models for a provider pi.dev keeps no catalog of), unchanged (a 304 to a conditional request), or a
// failure (any other status, an unsolicited 304, a body too large, not JSON, not a map, or with too many models); the
// next request waits until four hours after an answer or a quarter of an hour after a failure, never longer whatever
// the clock did; the overlay lays a newer catalog's models over the shipped ones by id, leaves the shipped list itself
// when there is nothing newer, takes only metadata from the catalog (never a model's endpoint, headers, API, routing
// and retention policy, or a type other than chat) (Astra and Opus, rounds 1 and 2 of the catalog).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Api, Model } from "@earendil-works/p3/v1";
import {
	type CatalogRequest,
	CHECK_EVERY_MS,
	catalogAnswer,
	catalogRequest,
	catalogWait,
	MAX_BODY_BYTES,
	MAX_MODELS,
	overlay,
	RETRY_AFTER_MS,
} from "../catalog.ts";
import type { CatalogEntry } from "../contract.server.ts";

const NETWORK = { baseUrl: "https://pi.example", userAgent: "pi/1.2.3 (linux; node/26; x64)" };

/** A chat model `id` of provider `p`, named `name`. */
function model(id: string, name = id): Model<Api> {
	return {
		id,
		name,
		api: "openai-completions",
		provider: "p",
		baseUrl: "https://p.example/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

/** A stored entry with `models`. */
function entry(models: Model<Api>[], extra: Partial<CatalogEntry> = {}): CatalogEntry {
	return { models, lastModified: 2_000, ...extra };
}

/** A request with no stored body, and one revalidating one. */
const PLAIN: CatalogRequest = catalogRequest("p", undefined, NETWORK);
const CONDITIONAL: CatalogRequest = catalogRequest("p", entry([model("a")], { etag: '"e1"' }), NETWORK);

/** A 200 with `body` as its JSON text. */
const ok = (body: unknown, lastModified: string | null = null) =>
	({ status: 200, lastModified, etag: '"e2"', text: JSON.stringify(body) }) as const;

describe("the request", () => {
	it("asks for the provider's chat models as the given client, without a validator when nothing is stored", () => {
		const { url, headers, conditional } = catalogRequest("open router", undefined, NETWORK);
		assert.equal(url.href, "https://pi.example/api/models/providers/open%20router");
		assert.equal(url.search, "");
		assert.deepEqual(headers, { accept: "application/json", "user-agent": NETWORK.userAgent });
		assert.equal(conditional, false);
	});

	it("revalidates by the stored ETag only when a stored body backs it", () => {
		assert.equal(CONDITIONAL.headers["if-none-match"], '"e1"');
		assert.equal(CONDITIONAL.conditional, true);
		const empty = catalogRequest("p", entry([], { etag: '"e1"' }), NETWORK);
		assert.equal(empty.headers["if-none-match"], undefined);
		assert.equal(empty.conditional, false);
	});

	it("throws for an address that is no URL (the loop counts it a failed request)", () => {
		assert.throws(() => catalogRequest("p", undefined, { ...NETWORK, baseUrl: "not a url" }));
	});
});

describe("an answer", () => {
	it("is a new body: the checked models of the map under the provider's id, its Last-Modified and ETag", () => {
		const body = { a: model("a"), b: { ...model("b"), provider: "other" }, broken: { name: "no id" }, text: "x" };
		const answer = catalogAnswer("p", PLAIN, ok(body, "Thu, 26 Nov 2026 10:00:00 GMT"));
		assert.ok(answer.kind === "body");
		assert.deepEqual(
			answer.entry.models.map((found) => [(found as Model<Api>).id, (found as Model<Api>).provider]),
			[
				["a", "p"],
				["b", "p"],
			],
		);
		assert.equal(answer.entry.lastModified, Date.parse("Thu, 26 Nov 2026 10:00:00 GMT"));
		assert.equal(answer.entry.etag, '"e2"');
	});

	it("leaves out an entry that is no chat model: an id alone, a bad input, a count not whole (Astra)", () => {
		const body = {
			alone: { id: "alone" },
			input: { ...model("input"), input: ["audio"] },
			window: { ...model("window"), contextWindow: 1.5 },
			cost: { ...model("cost"), cost: { input: "free" } },
			good: model("good"),
		};
		const answer = catalogAnswer("p", PLAIN, ok(body));
		assert.ok(answer.kind === "body");
		assert.deepEqual(
			answer.entry.models.map((found) => (found as Model<Api>).id),
			["good"],
		);
	});

	it("leaves out a model of another type: an image model under a chat model's id (Astra, round 2)", () => {
		const answer = catalogAnswer(
			"p",
			PLAIN,
			ok({ a: { ...model("a"), type: "image" }, b: { ...model("b"), type: "chat" } }),
		);
		assert.ok(answer.kind === "body");
		assert.deepEqual(
			answer.entry.models.map((found) => (found as Model<Api>).id),
			["b"],
		);
	});

	it("reads a missing or bad Last-Modified as 0", () => {
		const answer = catalogAnswer("p", PLAIN, { status: 200, lastModified: "soon", etag: null, text: "{}" });
		assert.deepEqual(answer, { kind: "body", entry: { models: [], lastModified: 0 } });
	});

	it("is a failure for a body that is not JSON, not a map, too large, or with too many models (Astra)", () => {
		const bodies = [
			"{",
			JSON.stringify([model("a")]),
			JSON.stringify("text"),
			JSON.stringify(null),
			// Valid JSON, only too large (Opus, round 2).
			JSON.stringify({ m: { ...model("m"), padding: "x".repeat(MAX_BODY_BYTES) } }),
			JSON.stringify(
				Object.fromEntries(Array.from({ length: MAX_MODELS + 1 }, (_, n) => [`m${n}`, model(`m${n}`)])),
			),
		];
		for (const text of bodies) {
			assert.deepEqual(catalogAnswer("p", PLAIN, { status: 200, lastModified: null, etag: null, text }), {
				kind: "failed",
			});
		}
		assert.deepEqual(catalogAnswer("p", PLAIN, { status: 200, lastModified: null, etag: null }), { kind: "failed" });
	});

	it("is unchanged for a 304 to a conditional request; a failure for a 304 nothing asked for (Astra)", () => {
		const unchanged = { status: 304, lastModified: null, etag: null };
		assert.deepEqual(catalogAnswer("p", CONDITIONAL, unchanged), { kind: "unchanged" });
		assert.deepEqual(catalogAnswer("p", PLAIN, unchanged), { kind: "failed" });
	});

	it("is no models for a provider pi.dev keeps no catalog of (404, 501); a failure for anything else", () => {
		for (const status of [404, 501]) {
			assert.deepEqual(catalogAnswer("p", CONDITIONAL, { status, lastModified: null, etag: null }), {
				kind: "body",
				entry: { models: [], lastModified: 0 },
			});
		}
		for (const status of [500, 502, 429, 403]) {
			assert.deepEqual(catalogAnswer("p", PLAIN, { status, lastModified: null, etag: null }), { kind: "failed" });
		}
	});
});

describe("the next request", () => {
	it("goes out at once without a catalog, four hours after an answer, a quarter of an hour after a failure", () => {
		assert.equal(catalogWait(null, 50_000), 0);
		assert.equal(catalogWait({ checkedAt: 10_000, failedAt: 0 }, 10_000), CHECK_EVERY_MS);
		assert.equal(catalogWait({ checkedAt: 10_000, failedAt: 20_000 }, 20_000), RETRY_AFTER_MS);
		assert.equal(catalogWait({ checkedAt: 30_000, failedAt: 20_000 }, 30_000), CHECK_EVERY_MS, "answered since");
		assert.equal(catalogWait({ checkedAt: 10_000, failedAt: 0 }, 10_000 + CHECK_EVERY_MS + 1), 0, "overdue");
	});

	it("waits no longer than its interval when the clock was set back (Astra)", () => {
		const day = 24 * 3_600_000;
		assert.equal(catalogWait({ checkedAt: 10 * day, failedAt: 0 }, 9 * day), CHECK_EVERY_MS);
		assert.equal(catalogWait({ checkedAt: 0, failedAt: 10 * day }, 9 * day), RETRY_AFTER_MS);
	});
});

describe("the overlay", () => {
	const shipped = [model("a", "A"), model("b", "B")];

	it("is the shipped list itself without an entry, with no models, or with a catalog not newer", () => {
		assert.equal(overlay(shipped, undefined, 1_000), shipped);
		assert.equal(overlay(shipped, entry([]), 1_000), shipped);
		assert.equal(overlay(shipped, entry([model("c")], { lastModified: 1_000 }), 1_000), shipped);
	});

	it("lays a newer catalog's models over the shipped ones by id, new ones after them", () => {
		const laid = overlay(shipped, entry([model("b", "B2"), model("c", "C")]), 1_000);
		assert.deepEqual(
			laid.map(({ id, name }) => [id, name]),
			[
				["a", "A"],
				["b", "B2"],
				["c", "C"],
			],
		);
	});

	it("lays any catalog over the shipped models when their date is unknown", () => {
		assert.deepEqual(
			overlay(shipped, entry([model("c")], { lastModified: 0 }), undefined).map(({ id }) => id),
			["a", "b", "c"],
		);
	});

	it("keeps the shipped routing and retention policy (`compat`) whatever the catalog says (Astra, round 2)", () => {
		const retained = { ...model("a"), compat: { openRouterRouting: { zdr: true } } } as Model<Api>;
		const relaxed = { ...model("a", "A2"), compat: { openRouterRouting: { zdr: false } } };
		const brandNew = { ...model("new"), compat: { openRouterRouting: { zdr: false } } };
		const laid = overlay([retained], entry([relaxed, brandNew] as Model<Api>[]), 1_000);
		assert.deepEqual(
			laid.map(({ id, name, compat }) => ({ id, name, compat })),
			[
				{ id: "a", name: "A2", compat: { openRouterRouting: { zdr: true } } },
				{ id: "new", name: "new", compat: { openRouterRouting: { zdr: true } } },
			],
		);
	});

	it("keeps the shipped endpoint, headers and API whatever the catalog says (Astra, Opus)", () => {
		const withHeaders = [{ ...model("a"), headers: { "x-shipped": "1" } }];
		const foreign = { baseUrl: "https://elsewhere.invalid/v1", headers: { "x-catalog": "1" } };
		const laid = overlay(
			withHeaders,
			entry([
				{ ...model("a", "A2"), ...foreign, api: "anthropic-messages" },
				{ ...model("new", "New"), ...foreign },
				{ ...model("other", "Other"), api: "anthropic-messages" },
			]),
			1_000,
		);
		assert.deepEqual(
			laid.map(({ id, name, api, baseUrl, headers }) => ({ id, name, api, baseUrl, headers })),
			[
				{
					id: "a",
					name: "A2",
					api: "openai-completions",
					baseUrl: "https://p.example/v1",
					headers: { "x-shipped": "1" },
				},
				{
					id: "new",
					name: "New",
					api: "openai-completions",
					baseUrl: "https://p.example/v1",
					headers: { "x-shipped": "1" },
				},
			],
			"a new id of an API no shipped model has is left out",
		);
	});
});
