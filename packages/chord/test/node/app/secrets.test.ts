// Tests of the kit's secrets (slice 13 §2): random tokens, hashes compared in constant time, and secret files written
// with mode 0600 in one step (a create never overwrites, a replace swaps whole files, no temporary file left).

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	hashToken,
	matchesHash,
	newToken,
	readSecret,
	secretFile,
	writeSecret,
} from "../../../src/node/app/secrets.ts";
import { tempDir } from "./support.ts";

describe("tokens and hashes", () => {
	it("makes distinct base64url tokens of the asked size and matches only their own hash", () => {
		const token = newToken();
		expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(newToken(12)).toMatch(/^[A-Za-z0-9_-]{16}$/);
		expect(new Set(Array.from({ length: 100 }, () => newToken())).size).toBe(100);
		const hash = hashToken(token);
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
		expect(matchesHash(token, hash)).toBe(true);
		expect(matchesHash(`${token}x`, hash)).toBe(false);
		expect(matchesHash(token, "short")).toBe(false);
	});
});

describe("secret files", () => {
	it("creates a file with mode 0600, never overwrites it on create, replaces it whole, leaves no temporary file", async () => {
		const dir = await tempDir();
		const path = join(dir, "secret");
		expect(await readSecret(path)).toBeUndefined();
		expect(await writeSecret(path, "one", "create")).toBe("written");
		expect((await stat(path)).mode & 0o777).toBe(0o600);
		expect(await writeSecret(path, "two", "create")).toBe("exists");
		expect(await readSecret(path)).toBe("one");
		expect(await writeSecret(path, "three", "replace")).toBe("written");
		expect(await readFile(path, "utf8")).toBe("three\n");
		expect((await stat(path)).mode & 0o777).toBe(0o600);
		expect(await readdir(dir)).toEqual(["secret"]);
	});

	it("keeps a secret file's first value: a fresh token at first, then that one", async () => {
		const dir = await tempDir();
		const path = join(dir, "cookie-secret");
		const first = await secretFile(path);
		expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(await secretFile(path)).toBe(first);
		expect((await stat(path)).mode & 0o777).toBe(0o600);
	});

	it("keeps the mode 0600 under a permissive umask", async () => {
		const dir = await tempDir();
		const previous = process.umask(0);
		try {
			await writeSecret(join(dir, "s"), "x", "create");
		} finally {
			process.umask(previous);
		}
		expect((await stat(join(dir, "s"))).mode & 0o777).toBe(0o600);
	});
});
