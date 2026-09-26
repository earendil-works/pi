import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { advanceLatestRelease, compareReleaseVersions, createVerifiedRelease, verifyPublishedModelCatalog } from "./publish-release-announcement.mjs";

test("records the exact catalog only after npm metadata and tarballs are available", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-release-catalog-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const modelCatalog = join(root, "models.json");
	const body = '{"provider":{}}\n';
	writeFileSync(modelCatalog, body);
	const packages = [{ name: "@test/pi", version: "0.85.2" }];
	const requests = [];
	let finishTarball;
	t.mock.method(globalThis, "fetch", async (url, options) => {
		requests.push([url, options.method ?? "GET"]);
		if (options.method === "HEAD") {
			return new Promise((resolve) => { finishTarball = resolve; });
		}
		return Response.json({ version: "0.85.2", dist: { tarball: "https://registry.npmjs.org/pi.tgz", integrity: "sha512-test" } });
	});
	let completed = false;
	const pending = createVerifiedRelease({ version: "0.85.2", sourceCommit: "commit", modelCatalog }, packages)
		.then((release) => { completed = true; return release; });
	await new Promise(setImmediate);
	assert.equal(completed, false);
	assert.equal(typeof finishTarball, "function");
	finishTarball(new Response(null, { status: 200 }));
	const release = await pending;
	assert.equal(release.modelCatalogRevision, `sha256-${createHash("sha256").update(body).digest("hex")}`);
	assert.equal(release.version, "0.85.2");
	assert.equal(release.sourceCommit, "commit");
	assert.deepEqual(requests, [
		["https://registry.npmjs.org/%40test%2Fpi/0.85.2", "GET"],
		["https://registry.npmjs.org/pi.tgz", "HEAD"],
	]);
});

test("rejects mismatched workspace versions before preparing a verified record", async () => {
	await assert.rejects(
		createVerifiedRelease({ version: "0.85.2" }, [{ name: "@test/pi", version: "0.85.1" }]),
		/expected 0.85.2/,
	);
});

for (const scenario of ["match", "different-models", "integrity", "unavailable"]) {
	test(`verifies the model snapshot against published npm bytes: ${scenario}`, async (t) => {
		const root = mkdtempSync(join(tmpdir(), "pi-release-tarball-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const dataDir = join(root, "package/dist/providers/data");
		mkdirSync(dataDir, { recursive: true });
		const models = { "model-a": { id: "model-a", api: "test", provider: "test-provider" } };
		writeFileSync(join(dataDir, "test-provider.json"), JSON.stringify({ test: models }));
		writeFileSync(join(dataDir, ".manifest.json"), "{}");
		const archive = join(root, "pi-ai.tgz");
		execFileSync("tar", ["-czf", archive, "-C", root, "package"]);
		const bytes = readFileSync(archive);
		const modelCatalog = join(root, "models.json");
		writeFileSync(modelCatalog, JSON.stringify({ "test-provider": scenario === "different-models" ? {} : models }));
		t.mock.method(globalThis, "fetch", async () => scenario === "unavailable"
			? new Response(null, { status: 404 }) : new Response(bytes));
		const packages = [{
			name: "@earendil-works/pi-ai", tarball: "https://registry.npmjs.org/pi-ai.tgz",
			integrity: scenario === "integrity" ? "sha512-wrong" : `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
		}];
		if (scenario === "match") await verifyPublishedModelCatalog(packages, modelCatalog);
		else await assert.rejects(verifyPublishedModelCatalog(packages, modelCatalog), /differs|integrity|unavailable/);
	});
}

test("compares stable release versions numerically", () => {
	assert.ok(compareReleaseVersions("0.85.0", "0.84.9") > 0);
	assert.ok(compareReleaseVersions("0.84.10", "0.84.9") > 0);
	assert.equal(compareReleaseVersions("0.84.0", "0.84.0"), 0);
	assert.throws(() => compareReleaseVersions("0.85.0-beta.1", "0.84.0"));
});

test("does not regress an existing newer release marker", async () => {
	let writeCount = 0;
	const result = await advanceLatestRelease(
		"0.84.0",
		async () => ({ etag: '"newer"', version: "0.85.0" }),
		async () => {
			writeCount++;
			return true;
		},
	);

	assert.deepEqual(result, { advanced: false, version: "0.85.0" });
	assert.equal(writeCount, 0);
});

test("retries a lost conditional update and preserves a racing newer marker", async () => {
	let readCount = 0;
	let writeCount = 0;
	const result = await advanceLatestRelease(
		"0.84.0",
		async () => {
			readCount++;
			return readCount === 1
				? { etag: '"previous"', version: "0.83.0" }
				: { etag: '"newer"', version: "0.85.0" };
		},
		async (condition) => {
			writeCount++;
			assert.deepEqual(condition, { etag: '"previous"' });
			return false;
		},
	);

	assert.deepEqual(result, { advanced: false, version: "0.85.0" });
	assert.equal(writeCount, 1);
});

test("creates a missing marker with an if-none-match condition", async () => {
	let condition;
	const result = await advanceLatestRelease(
		"0.84.0",
		async () => undefined,
		async (value) => {
			condition = value;
			return true;
		},
	);

	assert.deepEqual(result, { advanced: true, version: "0.84.0" });
	assert.deepEqual(condition, { missing: true });
});
