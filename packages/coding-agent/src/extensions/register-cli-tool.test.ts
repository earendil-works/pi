import { describe, expect, it } from "vitest";
import { ExtensionManager } from "./manager.js";

function fixtureScriptPath(): string {
	return new URL("../../test/fixtures/jsonl-cli.mjs", import.meta.url).pathname;
}

describe("ExtensionApi.registerCliTool", () => {
	it("spawns a CLI, parses stdout JSONL, and prefers output records for content", async () => {
		const mgr = new ExtensionManager({ builtInTools: {} });

		await mgr.loadExtension((api) => {
			api.registerCliTool({
				name: "fixture_cli",
				description: "Fixture JSONL CLI tool",
				command: process.execPath,
				fixedArgs: [fixtureScriptPath()],
			});
		}, "ext-fixture");

		const tool = mgr.getToolsForSelection([]).find((t) => t.name === "fixture_cli");
		expect(tool).toBeTruthy();

		const progress: string[] = [];
		const res = await tool!.execute("tc_1", { argv: [] }, undefined, (chunk) => progress.push(chunk));

		const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
		expect(text).toBe("hello");

		const details = res.details as unknown as {
			exitCode: number;
			ok: boolean;
			records: unknown[];
			stderr: string;
			mu_display?: {
				version: number;
				call?: { text?: string };
			};
		};
		expect(details.exitCode).toBe(0);
		expect(details.ok).toBe(true);
		expect(details.records.length).toBeGreaterThanOrEqual(2);
		expect(details.stderr).toContain("[fixture] starting");

		expect(details.mu_display?.version).toBe(1);
		expect(details.mu_display?.call?.text).toContain("jsonl-cli.mjs");

		const progressText = progress.join("");
		expect(progressText).toContain("[fixture] starting");
		expect(progressText).not.toContain('"type":"meta"');
	});

	it("falls back to raw stdout when the CLI emits non-JSONL output", async () => {
		const mgr = new ExtensionManager({ builtInTools: {} });

		await mgr.loadExtension((api) => {
			api.registerCliTool({
				name: "fixture_cli_plain",
				description: "Fixture JSONL CLI tool (plain stdout)",
				command: process.execPath,
				fixedArgs: [fixtureScriptPath()],
			});
		}, "ext-fixture-plain");

		const tool = mgr.getToolsForSelection([]).find((t) => t.name === "fixture_cli_plain");
		expect(tool).toBeTruthy();

		const res = await tool!.execute("tc_1", { argv: ["--plain"] });
		const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
		expect(text).toContain("Query: plain mode");
		expect(text).not.toContain("jsonl_parse_error");

		const details = res.details as unknown as {
			mode?: string;
			jsonlParseErrorCount?: number;
			mu_display?: { summary?: { text?: string; severity?: string } };
		};
		expect(details.mode).toBe("raw");
		expect(details.jsonlParseErrorCount).toBeGreaterThan(0);
		expect(details.mu_display?.summary?.severity).toBe("warning");
		expect(details.mu_display?.summary?.text).toContain("non-jsonl output");
	});

	it("returns parsed records and ok=false when the CLI exits non-zero", async () => {
		const mgr = new ExtensionManager({ builtInTools: {} });

		await mgr.loadExtension((api) => {
			api.registerCliTool({
				name: "fixture_cli_fail",
				description: "Fixture JSONL CLI tool (fails)",
				command: process.execPath,
				fixedArgs: [fixtureScriptPath()],
			});
		}, "ext-fixture-fail");

		const tool = mgr.getToolsForSelection([]).find((t) => t.name === "fixture_cli_fail");
		expect(tool).toBeTruthy();

		const res = await tool!.execute("tc_1", { argv: ["--fail"] });
		const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
		expect(text).toContain('"type": "error"');

		const details = res.details as unknown as { exitCode: number; ok: boolean; records: unknown[] };
		expect(details.exitCode).toBe(1);
		expect(details.ok).toBe(false);
		expect(details.records.length).toBeGreaterThanOrEqual(2);
	});

	it("does not force --jsonl when argv requests help", async () => {
		const mgr = new ExtensionManager({ builtInTools: {} });

		await mgr.loadExtension((api) => {
			api.registerCliTool({
				name: "fixture_cli_help",
				description: "Fixture JSONL CLI tool (help mode)",
				command: process.execPath,
				fixedArgs: [fixtureScriptPath()],
			});
		}, "ext-fixture-help");

		const tool = mgr.getToolsForSelection([]).find((t) => t.name === "fixture_cli_help");
		expect(tool).toBeTruthy();

		const res = await tool!.execute("tc_1", { argv: ["--help"] });
		const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
		expect(text).toContain("fixture help");
	});
});
