import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadExtensions } from "../src/core/extensions/loader.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("subagent example extension", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-ext-test-"));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("registers iterate and pane-session tools without replacing the base subagent tool", async () => {
		const extPath = path.resolve(__dirname, "../examples/extensions/subagent");
		const result = await loadExtensions([extPath], tempDir);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(1);

		const extension = result.extensions[0];
		expect(extension.tools.has("subagent")).toBe(true);
		expect(extension.tools.has("subagent_resume")).toBe(true);
		expect(extension.tools.has("set_tab_title")).toBe(true);
		expect(extension.commands.has("iterate")).toBe(true);
	});
});
