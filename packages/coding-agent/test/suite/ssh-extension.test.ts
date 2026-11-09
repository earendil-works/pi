import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import sshExtension from "../../examples/extensions/ssh.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import { createHarness, getToolResult, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	while (harnesses.length) harnesses.pop()?.cleanup();
});

async function createSshHarness(ssh: string | undefined, initialActiveToolNames?: string[]) {
	const extensionsResult = await createTestExtensionsResult([sshExtension]);
	if (ssh) extensionsResult.runtime.flagValues.set("ssh", ssh);
	const harness = await createHarness({
		resourceLoader: createTestResourceLoader({ extensionsResult }),
		initialActiveToolNames,
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({});
	return harness;
}

describe("SSH extension search isolation", () => {
	it("leaves remote bash available without declaring local search tools", async () => {
		const harness = await createSshHarness("review.invalid:/remote/project");
		expect(harness.session.getActiveToolNames()).toContain("bash");
		expect(harness.session.getActiveToolNames()).not.toContain("grep");
		expect(harness.session.getActiveToolNames()).not.toContain("find");
		harness.setResponses([
			(context) => {
				const declared = getCurrentTools(context.messages).map((tool) => tool.name);
				expect(declared).toContain("bash");
				expect(declared).not.toContain("grep");
				expect(declared).not.toContain("find");
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("Inspect the remote workspace");
	});

	it("blocks searches of local files even if the tools are reactivated", async () => {
		const harness = await createSshHarness("review.invalid:/remote/project");
		const marker = "LOCAL_ONLY_SEARCH_MARKER";
		writeFileSync(join(harness.tempDir, "local-only.ts"), `${marker}\n`);
		harness.session.setActiveToolsByName(["grep", "find"]);
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("grep", { pattern: marker, path: ".", context: 0 }),
					fauxToolCall("find", { pattern: "*.ts", path: "." }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Try the search tools");
		for (const name of ["grep", "find"]) {
			const result = getToolResult(harness, name);
			expect(result.isError).toBe(true);
			for (const part of result.content) {
				if (part.type === "text") {
					expect(part.text).not.toContain(marker);
					expect(part.text).not.toContain("local-only.ts");
				}
			}
		}
	});

	it("keeps local searches working without the SSH flag", async () => {
		const harness = await createSshHarness(undefined);
		writeFileSync(join(harness.tempDir, "local-only.ts"), "local needle\n");
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("grep", { pattern: "needle", path: ".", context: 0 }),
					fauxToolCall("find", { pattern: "*.ts", path: "." }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Search the local workspace");
		expect(getToolResult(harness, "grep")).toMatchObject({
			isError: false,
			content: [{ type: "text", text: "local-only.ts:1: local needle" }],
		});
		expect(getToolResult(harness, "find")).toMatchObject({
			isError: false,
			content: [{ type: "text", text: "local-only.ts" }],
		});
	});

	it("does not activate unselected search tools without the SSH flag", async () => {
		const harness = await createSshHarness(undefined, ["read"]);
		expect(harness.session.getActiveToolNames()).not.toContain("grep");
		expect(harness.session.getActiveToolNames()).not.toContain("find");
	});
});
