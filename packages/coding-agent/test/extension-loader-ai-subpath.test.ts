import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadExtensions } from "../src/core/extensions/loader.ts";

const codexResponsesSpecifier = "@earendil-works/pi-ai/api/openai-codex-responses";

describe("extension loader pi-ai public subpaths", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-extension-ai-subpath-"));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("loads the Codex responses public subpath through the development alias", async () => {
		const extensionPath = path.join(tempDir, "extension.ts");
		fs.writeFileSync(
			extensionPath,
			`import { closeOpenAICodexWebSocketSessions } from "${codexResponsesSpecifier}";

export default function(pi) {
	if (typeof closeOpenAICodexWebSocketSessions !== "function") {
		throw new Error("Codex WebSocket session closer is not a function");
	}
	pi.registerCommand("codex-closer-imported", { handler: async () => {} });
}`,
		);

		const result = await loadExtensions([extensionPath], tempDir);

		expect(result.errors).toEqual([]);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].commands.has("codex-closer-imported")).toBe(true);
	});

	it("statically bundles the Codex responses public subpath for Bun virtual modules", () => {
		const loaderSource = fs.readFileSync(new URL("../src/core/extensions/loader.ts", import.meta.url), "utf-8");

		expect(loaderSource).toContain(`import * as _bundledPiAiOpenAICodexResponses from "${codexResponsesSpecifier}";`);
		expect(loaderSource).toContain(`"${codexResponsesSpecifier}": _bundledPiAiOpenAICodexResponses`);
	});
});
