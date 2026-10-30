// Tests of installing a plugin's dependencies (slice 7c §5): the npm arguments, run in the plugin's real directory,
// the command overridable; a failure and an abort reject.

import { readFile, realpath, symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context, withCancel } from "../../../src/context/index.ts";
import { discoverPlugins, installDependencies } from "../../../src/next-node/plugins/index.ts";
import { rejection } from "../../next/support.ts";
import { KINDS, tempRoot, writeFiles, writePlugin } from "./support.ts";

/** A fake npm (a Node script) that records its arguments and directory, and exits with `code` after `delayMs`. */
async function fakeNpm(dir: string, code: number, delayMs = 0): Promise<readonly string[]> {
	const script = join(dir, "fake-npm.mjs");
	await writeFiles(dir, {
		"fake-npm.mjs": [
			'import { writeFileSync } from "node:fs";',
			`writeFileSync(${JSON.stringify(join(dir, "record.json"))}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));`,
			`setTimeout(() => { if (${code} !== 0) console.error("npm said no"); process.exit(${code}); }, ${delayMs});`,
		].join("\n"),
	});
	return [process.execPath, script];
}

describe("installDependencies", () => {
	it("runs npm install without dev dependencies, peers, scripts, audit or funding, in the plugin's real directory", async () => {
		const tools = await tempRoot();
		const elsewhere = await tempRoot();
		const root = await tempRoot();
		const dir = await writePlugin(
			elsewhere,
			"deps",
			"@test/deps",
			{ "worker.ts": "" },
			{ dependencies: { a: "1.0.0" } },
		);
		await symlink(dir, join(root, "deps"));
		const { plugins } = await discoverPlugins([root], { kinds: KINDS }, context);
		await installDependencies(plugins[0]!, context, { npmCommand: await fakeNpm(tools, 0) });
		expect(JSON.parse(await readFile(join(tools, "record.json"), "utf8"))).toEqual({
			args: ["install", "--omit=dev", "--legacy-peer-deps", "--ignore-scripts", "--no-audit", "--no-fund"],
			cwd: await realpath(dir),
		});
	});

	it("rejects with the command's output when it fails, and when the context aborts", async () => {
		const tools = await tempRoot();
		const root = await tempRoot();
		await writePlugin(root, "deps", "@test/deps", {});
		const { plugins } = await discoverPlugins([root], { kinds: KINDS }, context);
		const plugin = plugins[0]!;
		expect(
			await rejection(installDependencies(plugin, context, { npmCommand: await fakeNpm(tools, 1) })),
		).toMatchObject({
			message: expect.stringMatching(/^plugin "@test\/deps": .* install failed \(exit 1\): npm said no$/),
		});
		const { context: aborted, cancel } = withCancel(context);
		const running = installDependencies(plugin, aborted, { npmCommand: await fakeNpm(tools, 0, 5_000) });
		setTimeout(() => cancel(new Error("stop")), 50);
		expect(await rejection(running)).toMatchObject({ name: "AbortError" });
	});
});
