import { mkdirSync, writeFileSync } from "node:fs";
import { access, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import gondolinExtension from "../../examples/extensions/gondolin/index.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { createHarness, getToolResult, type Harness } from "./harness.ts";

const guest = vi.hoisted(() => ({ root: "" }));

// Replace QEMU only; the shipped adapter reads real fixture files through the guest filesystem API.
vi.mock("@earendil-works/gondolin", () => {
	class RealFSProvider {}
	return {
		RealFSProvider,
		VM: {
			create: async () => {
				const hostPath = (file: string) => path.join(guest.root, path.posix.relative("/workspace", file));
				return {
					id: "fixture-guest",
					fs: {
						access: (file: string) => access(hostPath(file)),
						stat: (file: string) => stat(hostPath(file)),
						listDir: (file: string) => readdir(hostPath(file)),
						readFile: (file: string) => readFile(hostPath(file), "utf8"),
					},
					exec: async () => ({ stdout: "/bin/sh\n" }),
					close: async () => {},
				};
			},
		},
	};
});

const harnesses: Harness[] = [];
afterEach(() => {
	while (harnesses.length) harnesses.pop()?.cleanup();
});

async function createGuestHarness() {
	initTheme("dark");
	const harness = await createHarness({ extensionFactories: [gondolinExtension] });
	harnesses.push(harness);
	guest.root = harness.tempDir;
	mkdirSync(path.join(guest.root, ".hidden-dir"));
	writeFileSync(path.join(guest.root, ".hidden-dir", "deep.ts"), "needle hidden\n");
	writeFileSync(path.join(guest.root, "visible.ts"), "needle visible\n");
	await harness.session.bindExtensions({});
	return harness;
}

describe("Gondolin guest search", () => {
	it.each([false, true])("honors hidden:%s when visiting guest directories", async (hidden) => {
		const harness = await createGuestHarness();
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("find", { pattern: "*.ts", hidden })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Find guest TypeScript files");
		const result = getToolResult(harness, "find");
		expect(result.isError).toBe(false);
		const content = result.content[0];
		if (content.type !== "text") throw new Error("Expected text search results");
		expect(content.text.split("\n").sort()).toEqual(hidden ? [".hidden-dir/deep.ts", "visible.ts"] : ["visible.ts"]);
	});

	it("returns an explicitly selected guest file with the default pattern", async () => {
		const harness = await createGuestHarness();
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("find", { path: "visible.ts" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Find the named guest file");
		expect(getToolResult(harness, "find")).toMatchObject({
			isError: false,
			content: [{ type: "text", text: "visible.ts" }],
		});
	});

	it("rejects unsupported guest grep pagination instead of repeating a page", async () => {
		const harness = await createGuestHarness();
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("grep", { pattern: "needle", skip: 20 })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Try an unsupported guest search option");
		const result = getToolResult(harness, "grep");
		expect(result.isError).toBe(true);
		expect(result.content).toEqual([{ type: "text", text: expect.stringContaining("skip") }]);
	});

	it("keeps supported guest JavaScript regex searches working", async () => {
		const harness = await createGuestHarness();
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("grep", { pattern: "need(?=le)", path: "visible.ts", context: 0 })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Search a guest file");
		expect(getToolResult(harness, "grep")).toMatchObject({
			isError: false,
			content: [{ type: "text", text: "visible.ts:1: needle visible" }],
		});
	});
});
