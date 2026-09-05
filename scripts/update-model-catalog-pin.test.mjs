import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, mock, test } from "node:test";
import { updateModelCatalogPin } from "./update-model-catalog-pin.mjs";

const body = '{"test-provider":{}}\n';
const revision = `sha256-${createHash("sha256").update(body).digest("hex")}`;
let root;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-catalog-pin-"));
	mkdirSync(join(root, "packages/coding-agent"), { recursive: true });
	mkdirSync(join(root, "nix"));
	writeFileSync(join(root, "packages/coding-agent/package.json"), JSON.stringify({ version: "0.85.1" }));
	writeFileSync(join(root, "nix/model-catalog.json"), "original pin\n");
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
		assert.equal(readFileSync(join(root, "nix/model-catalog.json"), "utf8"), "original pin\n");
	});
}
