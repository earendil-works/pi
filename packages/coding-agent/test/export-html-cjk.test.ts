import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportFromFile } from "../src/core/export-html/index.ts";
import { CURRENT_SESSION_VERSION, type SessionHeader } from "../src/core/session-manager.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function loadMarkdownParser(html: string): (text: string) => string {
	const sessionData = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/)?.[1];
	const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
	const viewer = scripts.pop();
	if (!sessionData || !viewer) throw new Error("Missing exported session data or viewer script");
	const context = createContext({
		atob,
		TextDecoder,
		URLSearchParams,
		document: { getElementById: () => ({ textContent: sessionData }), querySelector: () => null },
		window: { location: { search: "" } },
	});
	for (const script of scripts) {
		runInContext(script, context);
	}
	return runInContext(
		viewer.replace("function safeMarkedParse(", "return safeMarkedParse; function safeMarkedParse("),
		context,
	);
}

// #10154
describe("HTML export CJK emphasis", () => {
	let tempDir: string;
	let parse: (text: string) => string;

	beforeAll(async () => {
		initTheme("dark");
		tempDir = mkdtempSync(join(tmpdir(), "pi-export-cjk-"));
		const header = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "cjk-test",
			timestamp: new Date(0).toISOString(),
			cwd: tempDir,
		} satisfies SessionHeader;
		const sessionPath = join(tempDir, "session.jsonl");
		writeFileSync(sessionPath, `${JSON.stringify(header)}\n`);
		parse = loadMarkdownParser(readFileSync(await exportFromFile(sessionPath, join(tempDir, "out.html")), "utf8"));
	});

	afterAll(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("renders emphasis delimited next to CJK punctuation", () => {
		expect(parse("**这是测试。**后面")).toBe("<p><strong>这是测试。</strong>后面</p>\n");
		expect(parse("**一句话说清：**一台机器")).toBe("<p><strong>一句话说清：</strong>一台机器</p>\n");
		expect(parse("**要点到此为止。**20 小时")).toBe("<p><strong>要点到此为止。</strong>20 小时</p>\n");
		expect(parse("字**「引用」**字")).toBe("<p>字<strong>「引用」</strong>字</p>\n");
		expect(parse("*斜体。*后面")).toBe("<p><em>斜体。</em>后面</p>\n");
	});

	it("keeps CommonMark flanking rules for non-CJK text", () => {
		expect(parse("**end.**Then next")).toBe("<p>**end.**Then next</p>\n");
	});
});
