import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./check-runtime-deps.mjs", import.meta.url));

async function check(t, manifest, source, extraFiles = {}) {
	const root = await mkdtemp(join(tmpdir(), "pi-runtime-deps-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const files = {
		"packages/example/package.json": JSON.stringify({ name: "example", version: "1.0.0", ...manifest }),
		"packages/example/src/index.ts": source,
		...extraFiles,
	};
	for (const [path, contents] of Object.entries(files)) {
		const fullPath = join(root, path);
		await mkdir(join(fullPath, ".."), { recursive: true });
		await writeFile(fullPath, contents);
	}
	return spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
}

// #9132: workspace resolution and installing every release package masked a missing runtime dependency.
test("rejects undeclared imports even when the workspace package exists", async (t) => {
	const result = await check(t, {}, 'export { createUnixServer } from "@earendil-works/pi-server/unix";', {
		"packages/server/package.json": JSON.stringify({ name: "@earendil-works/pi-server", version: "1.0.0" }),
	});
	assert.equal(result.status, 1);
	assert.match(result.stderr, /src[\\/]index\.ts:1: @earendil-works\/pi-server\/unix is not declared/);
});

test("accepts runtime declarations, builtins, self imports, relative imports, and erased types", async (t) => {
	const result = await check(t, {
		dependencies: { "@scope/runtime": "1.0.0" },
		optionalDependencies: { optional: "1.0.0" },
		peerDependencies: { peer: "1.0.0" },
	}, `
import "node:fs";
import "fs/promises";
import "./local.ts";
import "example/subpath";
import { value, type T } from "@scope/runtime/subpath";
import optional from "optional";
export * from "peer";
import type { Type } from "type-only";
import { type OtherType } from "inline-type-only";
export type { Type } from "export-type-only";
export { type OtherType } from "export-inline-type-only";
`);
	assert.equal(result.status, 0, result.stderr);
});

test("rejects dev-only dependencies, side-effect imports, mixed exports, and literal runtime loads", async (t) => {
	const result = await check(t, { devDependencies: { dev: "1.0.0" } }, `
import "dev";
import {} from "empty-import";
export {} from "empty-export";
export { type T, value } from "mixed-export";
const lazy = () => import("lazy/subpath");
const required = require("required");
const resolved = require.resolve("resolved/subpath");
`);
	assert.equal(result.status, 1);
	for (const name of ["dev", "empty-import", "empty-export", "mixed-export", "lazy/subpath", "required", "resolved/subpath"]) {
		assert.ok(result.stderr.includes(`${name} is not declared`), result.stderr);
	}
});

test("allows imported JSON assets outside the TypeScript include pattern", async (t) => {
	const result = await check(t, {}, 'import data from "./data.json";', {
		"packages/example/tsconfig.build.json": JSON.stringify({ include: ["src/**/*.ts"], compilerOptions: { resolveJsonModule: true } }),
		"packages/example/src/data.json": "{}",
	});
	assert.equal(result.status, 0, result.stderr);
});

test("permits dev-only dependencies in sources excluded from the published build", async (t) => {
	const result = await check(t, { devDependencies: { server: "1.0.0" } }, "", {
		"packages/example/tsconfig.build.json": JSON.stringify({ include: ["src/**/*.ts"], exclude: ["src/experimental"] }),
		"packages/example/src/experimental/server.ts": 'import "server";',
	});
	assert.equal(result.status, 0, result.stderr);
});

// #9132: an experimental flag cannot prevent module resolution through a public entrypoint.
for (const statement of ['export * from "./experimental/server";', 'import type { Options } from "./experimental/server";']) {
	test(`rejects excluded code reachable through ${statement}`, async (t) => {
		const result = await check(t, { devDependencies: { server: "1.0.0" } }, statement, {
			"packages/example/tsconfig.build.json": JSON.stringify({ include: ["src/**/*.ts"], exclude: ["src/experimental"] }),
			"packages/example/src/experimental/server.ts": 'import "server"; export interface Options {}',
		});
		assert.equal(result.status, 1);
		assert.match(result.stderr, /is excluded from example's build but imported by it/);
		assert.match(result.stderr, /server is not declared/);
	});
}

test("ignores tests, declarations, and private packages", async (t) => {
	const result = await check(t, {}, "", {
		"packages/example/test/test.ts": 'import "test-only";',
		"packages/example/src/index.d.ts": 'import "declaration-only";',
		"packages/private/package.json": JSON.stringify({ name: "private", private: true }),
		"packages/private/src/index.ts": 'import "private-only";',
	});
	assert.equal(result.status, 0, result.stderr);
});
