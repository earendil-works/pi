// Tests of the kit's secrets: tokens and their hashes, and secret files written with mode 0600 in one step.

import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { hashToken, matchesHash, newToken, readSecret, secretFile, writeSecret } from "../../src/kit/secrets.ts";
import { tempDir } from "./support.ts";

/** The permission bits of the file at `path`. */
async function modeOf(path: string): Promise<number> {
	return (await stat(path)).mode & 0o777;
}

describe("tokens and hashes", () => {
	it("makes distinct base64url tokens of the asked size and matches only their own hash", () => {
		const token = newToken();
		assert.match(token, /^[A-Za-z0-9_-]{43}$/);
		assert.match(newToken(12), /^[A-Za-z0-9_-]{16}$/);
		assert.equal(new Set(Array.from({ length: 100 }, () => newToken())).size, 100);
		const hash = hashToken(token);
		assert.match(hash, /^[0-9a-f]{64}$/);
		assert.deepEqual(
			[matchesHash(token, hash), matchesHash(`${token}x`, hash), matchesHash(token, "short")],
			[true, false, false],
		);
	});
});

describe("secret files", () => {
	it("creates a file with mode 0600, never overwrites it on create, replaces it whole, leaves no temporary file", async () => {
		const dir = await tempDir();
		const path = join(dir, "secret");
		assert.equal(await readSecret(path), undefined);
		assert.equal(await writeSecret(path, "one", "create"), "written");
		assert.equal(await modeOf(path), 0o600);
		assert.equal(await writeSecret(path, "two", "create"), "exists");
		assert.equal(await readSecret(path), "one");
		assert.equal(await writeSecret(path, "three", "replace"), "written");
		assert.equal(await readFile(path, "utf8"), "three\n");
		assert.equal(await modeOf(path), 0o600);
		assert.deepEqual(await readdir(dir), ["secret"]);
	});

	it("keeps a secret file's first value: a fresh token at first, then that one", async () => {
		const path = join(await tempDir(), "cookie-secret");
		const first = await secretFile(path);
		assert.match(first, /^[A-Za-z0-9_-]{43}$/);
		assert.equal(await secretFile(path), first);
		assert.equal(await modeOf(path), 0o600);
	});

	it("keeps the mode 0600 under a permissive umask", async () => {
		const dir = await tempDir();
		const previous = process.umask(0);
		try {
			await writeSecret(join(dir, "s"), "x", "create");
		} finally {
			process.umask(previous);
		}
		assert.equal(await modeOf(join(dir, "s")), 0o600);
	});
});
