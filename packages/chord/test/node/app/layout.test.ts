// Tests of the data directory's layout (slice 13 §4): the directories made (the data directory 0700), the default
// data directory, and worker directories: one directory name per address key, distinct even on a case-insensitive
// file system, never leaving `workers/<kind>/`.

import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { hostKind, str } from "../../../src/contracts/index.ts";
import { createLayout, defaultDataDir, workerDirectory } from "../../../src/node/app/layout.ts";
import { tempDir } from "./support.ts";

const Doc = hostKind("doc", { id: str() });

describe("the data directory", () => {
	it("makes the layout's directories, the data directory with mode 0700", async () => {
		const dataDir = join(await tempDir(), "data");
		const layout = await createLayout(dataDir);
		expect((await readdir(dataDir)).sort()).toEqual(["cache", "logs", "plugins", "server", "workers"]);
		expect([layout.workerBases, layout.compileCache]).toEqual([
			join(dataDir, "cache", "workers"),
			join(dataDir, "cache", "node"),
		]);
		for (const dir of ["cache", "cache/workers", "cache/node"])
			expect((await stat(join(dataDir, dir))).mode & 0o777).toBe(0o700);
		expect((await stat(dataDir)).mode & 0o777).toBe(0o700);
		expect([layout.serverStore, layout.ownerToken, layout.cookieSecret]).toEqual([
			join(dataDir, "server", "store.sqlite"),
			join(dataDir, "owner-token"),
			join(dataDir, "server", "cookie-secret"),
		]);
		expect(defaultDataDir("acme")).toBe(join(homedir(), ".acme"));
	});
});

describe("worker directories", () => {
	it("encodes an address key as one directory name under its kind", () => {
		const dir = workerDirectory("/data", Doc({ id: "../../etc/x" }));
		expect(dirname(dir)).toBe("/data/workers/doc");
		expect(basename(dir)).toBe("doc%7C%2E%2E%2F%2E%2E%2Fetc%2Fx");
		expect(basename(workerDirectory("/data", Doc({ id: "." })))).toBe("doc%7C%2E");
	});

	it("keeps keys differing only in case apart, lowercased as a case-insensitive file system sees them", () => {
		const names = ["a", "A", "%41", "%2541"].map((id) => basename(workerDirectory("/data", Doc({ id }))));
		expect(new Set(names.map((name) => name.toLowerCase())).size).toBe(4);
	});

	it("names a long key by its hash", () => {
		const name = basename(workerDirectory("/data", Doc({ id: "x".repeat(200) })));
		expect(name).toMatch(/^sha256-[0-9a-f]{64}$/);
	});
});
