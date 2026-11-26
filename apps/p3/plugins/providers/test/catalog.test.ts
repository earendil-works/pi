// The pi.dev catalog's pure steps (`catalog.ts`): the request asks for the provider's chat models (no `?types`) as the
// given client, revalidating only a stored body; an answer stores a fresh catalog (a map by id, entries without a text
// id left out, under the provider's id), the stored body again (304), no models (404, 501) or nothing (any other
// status, and a 304 with nothing stored); the next request is due at once, four hours after pi.dev answered, or a
// quarter of an hour after a failure; the overlay lays a newer catalog's models over the shipped ones by id and leaves
// the shipped list itself when there is nothing newer.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Api, Model } from "@earendil-works/p3/v1";
import { CHECK_EVERY_MS, catalogAnswer, catalogDue, catalogRequest, overlay, RETRY_AFTER_MS } from "../catalog.ts";
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

/** A stored entry with `models`, checked at `checkedAt`. */
function entry(models: Model<Api>[], extra: Partial<CatalogEntry> = {}): CatalogEntry {
	return { models, lastModified: 2_000, checkedAt: 10_000, ...extra };
}

describe("the request", () => {
	it("asks for the provider's chat models as the given client, without a validator when nothing is stored", () => {
		const { url, headers } = catalogRequest("open router", undefined, NETWORK);
		assert.equal(url.href, "https://pi.example/api/models/providers/open%20router");
		assert.equal(url.search, "");
		assert.deepEqual(headers, { accept: "application/json", "user-agent": NETWORK.userAgent });
	});

	it("revalidates by the stored ETag only when a stored body backs it", () => {
		const backed = catalogRequest("p", entry([model("a")], { etag: '"e1"' }), NETWORK);
		assert.equal(backed.headers["if-none-match"], '"e1"');
		const empty = catalogRequest("p", entry([], { etag: '"e1"' }), NETWORK);
		assert.equal(empty.headers["if-none-match"], undefined);
	});
});

describe("an answer", () => {
	it("stores a fresh catalog: the map's models under the provider's id, its Last-Modified and ETag", () => {
		const body = { a: model("a"), b: { ...model("b"), provider: "other" }, broken: { name: "no id" }, text: "x" };
		const answer = catalogAnswer(
			"p",
			undefined,
			{ status: 200, lastModified: "Thu, 26 Nov 2026 10:00:00 GMT", etag: '"e2"', body },
			50,
		);
		assert.equal(answer.kind, "fresh");
		assert.ok(answer.kind === "fresh");
		assert.deepEqual(
			answer.entry.models.map((found) => [(found as Model<Api>).id, (found as Model<Api>).provider]),
			[
				["a", "p"],
				["b", "p"],
			],
		);
		assert.equal(answer.entry.lastModified, Date.parse("Thu, 26 Nov 2026 10:00:00 GMT"));
		assert.equal(answer.entry.etag, '"e2"');
		assert.equal(answer.entry.checkedAt, 50);
	});

	it("reads a missing or bad Last-Modified as 0, and a body that is no map as no models", () => {
		const answer = catalogAnswer(
			"p",
			undefined,
			{
				status: 200,
				lastModified: "soon",
				etag: null,
				body: [model("a")],
			},
			8,
		);
		assert.deepEqual(answer, { kind: "fresh", entry: { models: [], lastModified: 0, checkedAt: 8 } });
	});

	it("keeps the stored body on a 304, checked now; fails a 304 with nothing stored", () => {
		const stored = entry([model("a")], { etag: '"e1"' });
		assert.deepEqual(catalogAnswer("p", stored, { status: 304, lastModified: null, etag: null }, 99), {
			kind: "unchanged",
			entry: { ...stored, checkedAt: 99 },
		});
		assert.deepEqual(catalogAnswer("p", undefined, { status: 304, lastModified: null, etag: null }, 99), {
			kind: "failed",
			status: 304,
		});
	});

	it("stores no models for a provider pi.dev keeps no catalog of (404, 501); fails anything else", () => {
		for (const status of [404, 501]) {
			const answer = catalogAnswer("p", entry([model("a")]), { status, lastModified: null, etag: null }, 7);
			assert.deepEqual(answer, { kind: "missing", entry: { models: [], lastModified: 0, checkedAt: 7 } });
		}
		for (const status of [500, 502, 429, 403]) {
			assert.deepEqual(catalogAnswer("p", undefined, { status, lastModified: null, etag: null }, 7), {
				kind: "failed",
				status,
			});
		}
	});
});

describe("the next request", () => {
	it("is due at once without an entry, four hours after pi.dev answered, a quarter of an hour after a failure", () => {
		assert.equal(catalogDue(undefined, undefined), 0);
		assert.equal(catalogDue(entry([]), undefined), 10_000 + CHECK_EVERY_MS);
		assert.equal(catalogDue(entry([]), 20_000), 20_000 + RETRY_AFTER_MS);
		assert.equal(catalogDue(undefined, 20_000), 20_000 + RETRY_AFTER_MS);
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
});
