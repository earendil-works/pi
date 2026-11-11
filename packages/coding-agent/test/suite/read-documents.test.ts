import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { getOutputArtifacts } from "../../src/core/output-artifacts.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { ReadToolDetails } from "../../src/core/tools/read.ts";
import { createHarness, getMessageText, getToolResult, type Harness } from "./harness.ts";

const fixtures: Array<{ harness: Harness; directory: string }> = [];
afterEach(async () => {
	for (const { harness, directory } of fixtures.splice(0)) {
		await harness.session.abort();
		harness.cleanup();
		rmSync(directory, { recursive: true, force: true });
	}
});

async function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "pi-read-snapshot-"));
	const harness = await createHarness({
		sessionManager: SessionManager.create(directory, join(directory, "sessions")),
		settings: {
			compaction: { enabled: false },
			retry: { enabled: false },
			cacheWarming: "off",
			outputArtifacts: { maxInlineTokens: 128 },
		},
	});
	fixtures.push({ harness, directory });
	await harness.session.bindExtensions({});
	return harness;
}

describe("document snapshot retrieval", () => {
	it("retains omitted URL lines once and continues the original snapshot after the server changes", async () => {
		let requests = 0;
		let body = "ORIGINAL first\nORIGINAL second\nORIGINAL third\n";
		const server = createServer((_request, response) => {
			requests++;
			response.writeHead(200, { "Content-Type": "text/plain" });
			response.end(body);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Missing HTTP fixture address");
			const url = `http://127.0.0.1:${address.port}/changing`;
			const harness = await fixture();
			let uri = "";
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("read", { path: url, offset: 4, limit: 1 })], { stopReason: "toolUse" }),
				() => {
					const result = getToolResult(harness, "read");
					const details = result.details as ReadToolDetails;
					expect(getMessageText(result)).toContain("ORIGINAL first");
					expect(details.source).toMatchObject({ kind: "web", finalUrl: url });
					const page = details.artifactPage!;
					const nextByteOffset = page.nextByteOffset;
					if (nextByteOffset === undefined) throw new Error("Missing document snapshot continuation");
					uri = page.uri;
					body = "CHANGED first\nCHANGED second\n";
					return fauxAssistantMessage(
						[fauxToolCall("read", { path: page.uri, byteOffset: nextByteOffset, limit: 1 })],
						{ stopReason: "toolUse" },
					);
				},
				fauxAssistantMessage("Snapshot continued"),
			]);
			await harness.session.prompt("Read the URL then continue its snapshot");
			expect(getMessageText(getToolResult(harness, "read"))).toContain("ORIGINAL second");
			expect(getMessageText(getToolResult(harness, "read"))).not.toContain("CHANGED");
			expect(requests).toBe(1);
			expect(readFileSync(getOutputArtifacts(harness.sessionManager)!.resolve(uri), "utf8")).toContain(
				"ORIGINAL third",
			);
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it("automatically retains a large fetched document through the normal session budget", async () => {
		const body = `${"document evidence\n".repeat(500)}FINAL_RETRIEVABLE_EVIDENCE`;
		const server = createServer((_request, response) => {
			response.writeHead(200, { "Content-Type": "text/plain" });
			response.end(body);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Missing HTTP fixture address");
			const harness = await fixture();
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("read", { path: `http://127.0.0.1:${address.port}/large` })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("Output retained"),
			]);
			await harness.session.prompt("Read the full document");
			const result = getToolResult(harness, "read");
			const visible = getMessageText(result);
			const uri = /artifact:\/\/[a-f0-9]{64}\/[a-f0-9-]{36}/.exec(visible)?.[0];
			if (!uri) throw new Error("Document did not retain its artifact");
			const store = getOutputArtifacts(harness.sessionManager)!;
			expect(visible.length).toBeLessThanOrEqual(store.budget().maxChars);
			expect(visible).not.toContain("FINAL_RETRIEVABLE_EVIDENCE");
			expect(readFileSync(store.resolve(uri), "utf8")).toContain(body);
			expect(readFileSync(harness.sessionManager.getSessionFile()!, "utf8")).not.toContain(
				"FINAL_RETRIEVABLE_EVIDENCE",
			);
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});
