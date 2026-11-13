// Tests of a surface's build (`surface-build.ts`; owner decision "A" on startup cost): one build shared by every
// waiter, the scripts object's empty set before it, a rollout step's wait bounded by its context while the build goes
// on, and a failed build answering 503 and failing its step.

import { execFileSync } from "node:child_process";
import { closeSync, constants, openSync, writeSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context, withAbortSignal } from "../../../src/context/index.ts";
import { hostKind } from "../../../src/contracts/index.ts";
import { createHost } from "../../../src/host/index.ts";
import { WebScripts } from "../../../src/index.ts";
import { createPlugins } from "../../../src/node/plugins/index.ts";
import { scriptsFacet } from "../../../src/node/surfaces/current.ts";
import { WEB_PREFIX } from "../../../src/node/surfaces/index.ts";
import { SurfaceBuild } from "../../../src/node/surfaces/surface-build.ts";
import { tempDir } from "../app/support.ts";

type Principal = { readonly kind: "server" };

/** A loaded server with the web surface's build of `entry` (its scripts object served), and a cleanup. */
async function surface(entry: string) {
	const root = join(await tempDir(), "plugins");
	await mkdir(root);
	const server = createHost<Principal>({
		address: hostKind("server")(),
		principal: { kind: "server" },
		onError: () => {},
	});
	const plugins = createPlugins(
		{ roots: [root], kinds: { web: { platform: "browser", hostPackages: [] } }, onError: () => {} },
		context,
	);
	const building = new SurfaceBuild<Principal>(
		"web",
		"browser",
		WEB_PREFIX,
		{ kind: "web", entry, resolution: { conditions: [] }, plugins },
		server,
	);
	await server.load([{ name: "chord.web", facet: scriptsFacet<Principal>("web", building) }], context);
	const close = async () => {
		await server.close(context);
		plugins.close();
	};
	return { server, plugins, building, close };
}

/** An entry in a new directory importing `./held.ts`, a pipe: its build waits until the pipe is written. */
async function heldEntry(): Promise<{ entry: string; release(): void }> {
	const dir = await tempDir();
	execFileSync("mkfifo", [join(dir, "held.ts")]);
	await writeFile(join(dir, "main.ts"), 'import "./held.ts";\nglobalThis.started = true;\n');
	return {
		entry: join(dir, "main.ts"),
		release: () => {
			// Written once the build reads it (an open for writing succeeds only while a reader waits).
			const write = (): void => {
				try {
					const fd = openSync(join(dir, "held.ts"), constants.O_WRONLY | constants.O_NONBLOCK);
					writeSync(fd, "export {};");
					closeSync(fd);
				} catch {
					setTimeout(write, 10);
				}
			};
			write();
		},
	};
}

/** Whether `promise` is still pending after 300 ms. */
async function pending(promise: Promise<unknown>): Promise<boolean> {
	const later = Symbol("pending");
	const settled = await Promise.race([
		promise.then(
			() => undefined,
			() => undefined,
		),
		new Promise((resolve) => setTimeout(() => resolve(later), 300)),
	]);
	return settled === later;
}

describe("one shared build", () => {
	it("builds once for every waiter; the scripts object shows an empty set before, the first set after", async () => {
		const dir = await tempDir();
		await writeFile(join(dir, "main.ts"), "globalThis.started = true;\n");
		const { server, building, close } = await surface(join(dir, "main.ts"));
		try {
			const scripts = await server.get(WebScripts, {}, context);
			expect(scripts.set.value).toEqual({ base: "", combined: "", plugins: [] });
			expect(building.built).toBeUndefined();
			const [first, second] = await Promise.all([building.build(), building.build()]);
			expect(second).toEqual(first);
			const base = first.kind === "built" ? first.base : "";
			expect(base).toMatch(/^[0-9a-f]{16}$/);
			expect(building.built).toEqual(first);
			expect(scripts.set.value.base).toBe(base);
			expect((await building.file(`${WEB_PREFIX}base.${base}.js`)).kind).not.toBe("error");
			scripts.release();
		} finally {
			await close();
		}
	});
});

describe("a rollout step during the build", () => {
	it.skipIf(process.platform !== "linux")(
		"stops waiting at its context's abort, before the build ends; the build goes on for everyone else",
		async () => {
			const held = await heldEntry();
			const { plugins, building, close } = await surface(held.entry);
			try {
				const controller = new AbortController();
				const built = await plugins.build([], context);
				const step = building.step("web").reload(built, withAbortSignal(controller.signal, context));
				expect(await pending(step)).toBe(true);
				controller.abort(new Error("cancel Apply"));
				await expect(step).rejects.toThrow("cancel Apply");
				expect(building.built).toBeUndefined();
				held.release();
				expect((await building.build()).kind).toBe("built");
			} finally {
				await close();
			}
		},
		30_000,
	);
});

describe("a failed build", () => {
	it("answers 503 for the surface's files and fails its step's host", async () => {
		const dir = await tempDir();
		await writeFile(join(dir, "main.ts"), "export const broken = ;\n");
		const { plugins, building, close } = await surface(join(dir, "main.ts"));
		try {
			expect(await building.file(`${WEB_PREFIX}base.0.js`)).toEqual({ kind: "error", status: 503 });
			const outcome = await building.build();
			expect(outcome.kind === "failed" ? String(outcome.error) : outcome).toMatch(/Unexpected ";"/);
			const { hosts } = await building.step("web").reload(await plugins.build([], context), context);
			expect(hosts).toMatchObject([{ host: "web", error: { message: expect.stringMatching(/Unexpected ";"/) } }]);
		} finally {
			await close();
		}
	});
});
