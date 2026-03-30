import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { discoverAndLoadExtensions } from "../src/core/extensions/loader.js";
import { ExtensionRunner } from "../src/core/extensions/runner.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";

describe("Input Event", () => {
	let tempDir: string;
	let extensionsDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-input-test-"));
		extensionsDir = path.join(tempDir, "extensions");
		fs.mkdirSync(extensionsDir);
		// Clean globalThis test vars
		delete (globalThis as any).testVar;
	});

	afterEach(() => fs.rmSync(tempDir, { recursive: true, force: true }));

	async function createRunner(...extensions: string[]) {
		// Clear and recreate extensions dir for clean state
		fs.rmSync(extensionsDir, { recursive: true, force: true });
		fs.mkdirSync(extensionsDir);
		for (let i = 0; i < extensions.length; i++) fs.writeFileSync(path.join(extensionsDir, `e${i}.ts`), extensions[i]);
		const result = await discoverAndLoadExtensions([], tempDir, tempDir);
		const sm = SessionManager.inMemory();
		const mr = ModelRegistry.create(AuthStorage.create(path.join(tempDir, "auth.json")));
		return new ExtensionRunner(result.extensions, result.runtime, tempDir, sm, mr);
	}

	it("returns continue when no handlers, undefined return, or explicit continue", async () => {
		// No handlers
		expect((await (await createRunner()).emitInput("x", undefined, "interactive")).action).toBe("continue");
		// Returns undefined
		let r = await createRunner(`export default p => p.on("input", async () => {});`);
		expect((await r.emitInput("x", undefined, "interactive")).action).toBe("continue");
		// Returns explicit continue
		r = await createRunner(`export default p => p.on("input", async () => ({ action: "continue" }));`);
		expect((await r.emitInput("x", undefined, "interactive")).action).toBe("continue");
	});

	it("transforms text and preserves images when omitted", async () => {
		const r = await createRunner(
			`export default p => p.on("input", async e => ({ action: "transform", text: "T:" + e.text }));`,
		);
		const imgs = [{ type: "image" as const, data: "orig", mimeType: "image/png" }];
		const result = await r.emitInput("hi", imgs, "interactive");
		expect(result).toEqual({ action: "transform", text: "T:hi", images: imgs });
	});

	it("transforms and replaces images when provided", async () => {
		const r = await createRunner(
			`export default p => p.on("input", async () => ({ action: "transform", text: "X", images: [{ type: "image", data: "new", mimeType: "image/jpeg" }] }));`,
		);
		const result = await r.emitInput("hi", [{ type: "image", data: "orig", mimeType: "image/png" }], "interactive");
		expect(result).toEqual({
			action: "transform",
			text: "X",
			images: [{ type: "image", data: "new", mimeType: "image/jpeg" }],
		});
	});

	it("chains transforms across multiple handlers", async () => {
		const r = await createRunner(
			`export default p => p.on("input", async e => ({ action: "transform", text: e.text + "[1]" }));`,
			`export default p => p.on("input", async e => ({ action: "transform", text: e.text + "[2]" }));`,
		);
		const result = await r.emitInput("X", undefined, "interactive");
		expect(result).toEqual({ action: "transform", text: "X[1][2]", images: undefined });
	});

	it("short-circuits on handled and skips subsequent handlers", async () => {
		(globalThis as any).testVar = false;
		const r = await createRunner(
			`export default p => p.on("input", async () => ({ action: "handled" }));`,
			`export default p => p.on("input", async () => { globalThis.testVar = true; });`,
		);
		expect(await r.emitInput("X", undefined, "interactive")).toEqual({ action: "handled" });
		expect((globalThis as any).testVar).toBe(false);
	});

	it("passes source correctly for all source types", async () => {
		const r = await createRunner(
			`export default p => p.on("input", async e => { globalThis.testVar = e.source; return { action: "continue" }; });`,
		);
		for (const source of ["interactive", "rpc", "extension"] as const) {
			await r.emitInput("x", undefined, source);
			expect((globalThis as any).testVar).toBe(source);
		}
	});

	it("catches handler errors and continues", async () => {
		const r = await createRunner(`export default p => p.on("input", async () => { throw new Error("boom"); });`);
		const errs: string[] = [];
		r.onError((e) => errs.push(e.error));
		const result = await r.emitInput("x", undefined, "interactive");
		expect(result.action).toBe("continue");
		expect(errs).toContain("boom");
	});

	it("hasHandlers returns correct value", async () => {
		let r = await createRunner();
		expect(r.hasHandlers("input")).toBe(false);
		r = await createRunner(`export default p => p.on("input", async () => {});`);
		expect(r.hasHandlers("input")).toBe(true);
	});
});
