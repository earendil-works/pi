import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, mock, test } from "node:test";
import { updateModelCatalogPin } from "./update-model-catalog-pin.mjs";

const body = '{"test-provider":{}}\n';
const revision = `sha256-${createHash("sha256").update(body).digest("hex")}`;
const originalPin = `${JSON.stringify({ revision: `sha256-${"a".repeat(64)}` })}\n`;
let root;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-catalog-pin-"));
	mkdirSync(join(root, "packages/coding-agent"), { recursive: true });
	mkdirSync(join(root, "nix"));
	writeFileSync(join(root, "packages/coding-agent/package.json"), JSON.stringify({ version: "0.85.1" }));
	writeFileSync(join(root, "nix/model-catalog.json"), originalPin);
});
afterEach(() => {
	mock.restoreAll();
	rmSync(root, { recursive: true, force: true });
});

test("discovers a compatible revision and verifies its immutable URL before pinning", async () => {
	const requests = [];
	mock.method(globalThis, "fetch", async (url) => {
		requests.push(url);
		return new Response(body, { headers: { "x-pi-model-catalog-revision": revision } });
	});
	assert.equal(await updateModelCatalogPin(root), revision);
	assert.deepEqual(requests, [
		"https://pi.dev/api/models?pi-version=0.85.1",
		`https://pi.dev/api/models/revisions/${revision}`,
	]);
	assert.deepEqual(JSON.parse(readFileSync(join(root, "nix/model-catalog.json"), "utf8")), { revision });
});

for (const failure of ["discovery-http", "revision", "discovery-hash", "pinned-http", "pinned-hash"]) {
	test(`keeps the old pin on ${failure} failure`, async () => {
		mock.method(globalThis, "fetch", async (url) => {
			const pinned = url.includes("/revisions/");
			if (failure === (pinned ? "pinned-http" : "discovery-http")) return new Response(null, { status: 503 });
			return new Response(failure === (pinned ? "pinned-hash" : "discovery-hash") ? "wrong" : body, {
				headers: { "x-pi-model-catalog-revision": failure === "revision" ? "latest" : revision },
			});
		});
		await assert.rejects(updateModelCatalogPin(root));
		assert.equal(readFileSync(join(root, "nix/model-catalog.json"), "utf8"), originalPin);
	});
}

test("pins the verified release revision, never the live catalog, and can be rerun", async () => {
	const requests = [];
	mock.method(globalThis, "fetch", async (url) => {
		requests.push(url);
		if (url === "https://pi.dev/api/installer/releases/0.85.1") {
			return Response.json({ schemaVersion: 1, version: "0.85.1", modelCatalogRevision: revision });
		}
		assert.equal(url, `https://pi.dev/api/models/revisions/${revision}`);
		return new Response(body);
	});
	for (let attempt = 0; attempt < 2; attempt++) {
		assert.equal(await updateModelCatalogPin(root, "0.85.1"), revision);
		assert.deepEqual(JSON.parse(readFileSync(join(root, "nix/model-catalog.json"), "utf8")), {
			revision, baselineRelease: "0.85.1",
		});
	}
	assert.equal(requests.length, 4);
});

for (const failure of ["unpublished", "wrong-version", "wrong-schema", "missing-revision", "hash"]) {
	test(`preserves the pin when release metadata fails: ${failure}`, async () => {
		mock.method(globalThis, "fetch", async (url) => {
			if (url.includes("/models/revisions/")) return new Response("wrong");
			if (failure === "unpublished") return new Response(null, { status: 404 });
			return Response.json({
				schemaVersion: failure === "wrong-schema" ? 2 : 1,
				version: failure === "wrong-version" ? "0.85.0" : "0.85.1",
				modelCatalogRevision: failure === "missing-revision" ? undefined : revision,
			});
		});
		await assert.rejects(updateModelCatalogPin(root, "0.85.1"));
		assert.equal(readFileSync(join(root, "nix/model-catalog.json"), "utf8"), originalPin);
	});
}

test("rejects a baseline downgrade before making network requests", async () => {
	const pin = JSON.stringify({ revision, baselineRelease: "0.85.1" });
	writeFileSync(join(root, "nix/model-catalog.json"), pin);
	const fetchMock = mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected fetch"); });
	await assert.rejects(updateModelCatalogPin(root, "0.85.0"), /downgrade/);
	assert.equal(fetchMock.mock.callCount(), 0);
	assert.equal(readFileSync(join(root, "nix/model-catalog.json"), "utf8"), pin);
});

test("manual updates retain the release baseline downgrade guard", async () => {
	writeFileSync(join(root, "nix/model-catalog.json"), JSON.stringify({ revision, baselineRelease: "0.85.1" }));
	mock.method(globalThis, "fetch", async () => new Response(body, {
		headers: { "x-pi-model-catalog-revision": revision },
	}));
	await updateModelCatalogPin(root);
	assert.equal(JSON.parse(readFileSync(join(root, "nix/model-catalog.json"), "utf8")).baselineRelease, "0.85.1");
});

for (const version of ["latest", "0.85.1-beta.1", "0.86.0"]) {
	test(`rejects invalid or newer-than-checkout release ${version}`, async () => {
		const fetchMock = mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected fetch"); });
		await assert.rejects(updateModelCatalogPin(root, version));
		assert.equal(fetchMock.mock.callCount(), 0);
	});
}
