import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@kennyfrc/mu-ai", async () => {
	const actual = await vi.importActual<typeof import("@kennyfrc/mu-ai")>("@kennyfrc/mu-ai");
	return {
		...actual,
		completeSimple: vi.fn(async () => {
			throw new Error("gemini-cli internal failure");
		}),
	};
});

vi.mock("../src/model-config.js", async () => {
	const actual = await vi.importActual<typeof import("../src/model-config.js")>("../src/model-config.js");
	return {
		...actual,
		getApiKeyForModel: vi.fn(async () => "test-api-key"),
	};
});

import { getModel } from "@kennyfrc/mu-ai";
import { setCurrentModel } from "../src/runtime-state.js";
import { readImageTool } from "../src/tools/read-image.js";

describe("read_image delegate failures", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "mu-read-image-delegate-fail-fast-"));
		const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5WQAAAAASUVORK5CYII=";
		writeFileSync(join(dir, "image.png"), Buffer.from(pngBase64, "base64"));
		setCurrentModel({ ...getModel("anthropic", "claude-sonnet-4-5"), input: ["text"] as const });
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("throws instead of returning XML tool errors when delegated analysis fails internally", async () => {
		await expect(
			readImageTool.execute("tool-1", {
				path: join(dir, "image.png"),
				objective: "Describe this image",
				mode: "delegate",
			}),
		).rejects.toThrow("gemini-cli internal failure");
	});

	it("keeps missing-file user input errors as tool errors instead of hard failures", async () => {
		const result = await readImageTool.execute("tool-2", {
			path: join(dir, "missing.png"),
			objective: "Describe this image",
			mode: "delegate",
		});

		expect((result as { isError?: boolean }).isError).toBe(true);
		expect(result.content[0]?.type).toBe("text");
		if (result.content[0]?.type === "text") {
			expect(result.content[0].text).toContain("Failed to read file");
		}
	});
});
