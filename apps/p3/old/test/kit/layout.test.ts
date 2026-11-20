// Tests of the data directory's layout: its directories and their modes, and a worker's directory by its address.

import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, it } from "node:test";
import { hostKind, str } from "@earendil-works/p3/v1";
import { createLayout, defaultDataDir, ifExists, layoutOf, workerDirectory } from "../../src/kit/layout.ts";
import { tempDir } from "./support.ts";

const Doc = hostKind("doc", { id: str() });

describe("the data directory", () => {
	it("makes the layout's directories with mode 0700, the data directory too", async () => {
		const dataDir = join(await tempDir(), "data");
		const layout = await createLayout(dataDir);
		assert.deepEqual((await readdir(dataDir)).sort(), ["cache", "logs", "server", "workers"]);
		for (const dir of [".", "server", "workers", "cache", "cache/worker", "cache/node", "logs"]) {
			assert.equal((await stat(join(dataDir, dir))).mode & 0o777, 0o700, dir);
		}
		assert.deepEqual(layout, {
			dataDir,
			config: join(dataDir, "pi.json"),
			serverStore: join(dataDir, "server", "store.sqlite"),
			cookieSecret: join(dataDir, "server", "cookie-secret"),
			workerBase: join(dataDir, "cache", "worker"),
			compileCache: join(dataDir, "cache", "node"),
			ownerToken: join(dataDir, "owner-token"),
			log: join(dataDir, "logs", "server.log"),
		});
		assert.deepEqual(layoutOf(dataDir), layout);
		assert.equal(defaultDataDir(), join(homedir(), ".pi", "p3"));
	});
});

describe("ifExists", () => {
	it("answers undefined for a missing file, and passes every other failure on", async () => {
		const dir = await tempDir();
		assert.equal(await ifExists(readFile(join(dir, "none"), "utf8")), undefined);
		assert.deepEqual(await ifExists(readdir(dir)), []);
		await assert.rejects(ifExists(readFile(dir, "utf8")), { code: "EISDIR" });
	});
});

describe("worker directories", () => {
	it("encodes an address key as one directory name under its kind", () => {
		const dir = workerDirectory("/data", Doc({ id: "../../etc/x" }));
		assert.equal(dirname(dir), "/data/workers/doc");
		assert.equal(basename(dir), "doc%7C%2E%2E%2F%2E%2E%2Fetc%2Fx");
		assert.equal(basename(workerDirectory("/data", Doc({ id: "." }))), "doc%7C%2E");
	});

	it("keeps keys differing only in case apart, lowercased as a case-insensitive file system sees them", () => {
		const names = ["a", "A", "%41", "%2541"].map((id) => basename(workerDirectory("/data", Doc({ id }))));
		assert.equal(new Set(names.map((name) => name.toLowerCase())).size, 4);
	});

	it("names a long key by its hash", () => {
		const name = basename(workerDirectory("/data", Doc({ id: "x".repeat(200) })));
		assert.match(name, /^sha256-[0-9a-f]{64}$/);
	});
});
