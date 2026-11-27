import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportFromFile } from "../src/core/export-html/index.ts";
import { CURRENT_SESSION_VERSION, type SessionHeader } from "../src/core/session-manager.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const templateDir = new URL("../src/core/export-html/", import.meta.url);
const readTemplateFile = (path: string) => readFileSync(new URL(path, templateDir), "utf-8");

// #12608
describe("HTML export embedded scripts", () => {
	let tempDir: string;
	let html: string;

	beforeAll(async () => {
		initTheme("dark");
		tempDir = mkdtempSync(join(tmpdir(), "pi-export-scripts-"));
		const header = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "embedded-scripts-test",
			timestamp: new Date(0).toISOString(),
			cwd: tempDir,
		} satisfies SessionHeader;
		const sessionPath = join(tempDir, "session.jsonl");
		writeFileSync(sessionPath, `${JSON.stringify(header)}\n`);
		html = readFileSync(await exportFromFile(sessionPath, join(tempDir, "out.html")), "utf8");
	});

	afterAll(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("keeps the dollar sign in the header cost", () => {
		expect(html).toContain("$${totalCost.toFixed(3)}");
	});

	it.each(["template.js", "vendor/marked.min.js", "vendor/marked-cjk-friendly.min.js", "vendor/highlight.min.js"])(
		"embeds %s unchanged",
		(path) => {
			expect(html).toContain(readTemplateFile(path));
		},
	);
});
