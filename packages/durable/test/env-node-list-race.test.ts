import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import type * as FsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getOrThrow } from "../src/env/index.ts";
import { NodeExecutionEnv } from "../src/env/node.ts";

const race = vi.hoisted(() => ({
	path: undefined as string | undefined,
	beforeLstat: undefined as (() => Promise<void>) | undefined,
}));

// Run a one-shot callback right before the lstat of `race.path`, as another process would between readdir and lstat.
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof FsPromises>();
	return {
		...actual,
		lstat: (async (path: string, ...rest: unknown[]) => {
			const callback = race.beforeLstat;
			if (callback !== undefined && path === race.path) {
				race.beforeLstat = undefined;
				await callback();
			}
			return Reflect.apply(actual.lstat, undefined, [path, ...rest]);
		}) as typeof actual.lstat,
	};
});

const tempDirs: string[] = [];

afterEach(() => {
	race.path = undefined;
	race.beforeLstat = undefined;
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("NodeExecutionEnv.listDir under concurrent changes", () => {
	it("leaves out an entry removed between enumeration and lstat", async () => {
		const dir = join(tmpdir(), `pi-durable-list-race-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		tempDirs.push(dir);
		writeFileSync(join(dir, "doc-1.jsonl"), "kept\n");
		writeFileSync(join(dir, "doc-2.jsonl.reclaim"), "replacement\n");
		// A writer replaces a sidecar: the reclaim file is renamed over its target after the reader enumerated it.
		race.path = join(dir, "doc-2.jsonl.reclaim");
		race.beforeLstat = async () => {
			const { rename } = await vi.importActual<typeof FsPromises>("node:fs/promises");
			await rename(join(dir, "doc-2.jsonl.reclaim"), join(dir, "doc-2.jsonl"));
		};

		const env = new NodeExecutionEnv({ cwd: dir });
		const entries = getOrThrow(await env.listDir(".", BACKGROUND_CONTEXT));

		expect(race.beforeLstat).toBeUndefined();
		expect(entries.map((entry) => entry.name)).toEqual(["doc-1.jsonl"]);
	});
});
