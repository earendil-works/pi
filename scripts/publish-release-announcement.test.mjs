import assert from "node:assert/strict";
import test from "node:test";
import { advanceLatestRelease, compareReleaseVersions } from "./publish-release-announcement.mjs";

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
