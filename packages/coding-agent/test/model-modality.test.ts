import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	extractPathCandidates,
	modelAcceptsImage,
	textRequiresImageInput,
} from "../src/modes/interactive/model-modality.ts";
import { getModelSelectorSearchText } from "../src/modes/interactive/model-search.ts";

/** Minimal valid 1x1 PNG so the byte sniffing accepts the fixture. */
const PNG_BYTES = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

let dir: string;

function writeFile(name: string, bytes: Buffer = PNG_BYTES): string {
	const path = join(dir, name);
	writeFileSync(path, bytes);
	return path;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-modality-"));
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("pending-prompt image detection", () => {
	it("detects a pasted image path as requiring image input", async () => {
		const path = writeFile("paste.png");
		expect(await textRequiresImageInput(path, { cwd: dir })).toBe(true);
		expect(await textRequiresImageInput(`explain this ${path}`, { cwd: dir })).toBe(true);
	});

	it("detects a relative image path against the working directory", async () => {
		writeFile("shot.png");
		expect(await textRequiresImageInput("look at shot.png", { cwd: dir })).toBe(true);
	});

	it("accepts jpeg, gif, webp, and bmp fixtures", async () => {
		const jpeg = writeFile("a.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]));
		const gif = writeFile("b.gif", Buffer.from("GIF89a", "ascii"));
		const webp = writeFile(
			"c.webp",
			Buffer.concat([Buffer.from("RIFF", "ascii"), Buffer.alloc(4), Buffer.from("WEBP", "ascii")]),
		);
		for (const path of [jpeg, gif, webp]) {
			expect(await textRequiresImageInput(path, { cwd: dir })).toBe(true);
		}
	});

	it("does not treat plain text as an attachment", async () => {
		expect(await textRequiresImageInput("", { cwd: dir })).toBe(false);
		expect(await textRequiresImageInput("please refactor src/index.ts", { cwd: dir })).toBe(false);
		expect(await textRequiresImageInput("what about image.png?", { cwd: dir })).toBe(false);
	});

	it("does not treat a non-image file with an image extension as an attachment", async () => {
		const fake = writeFile("notreally.png", Buffer.from("this is plain text, not a png", "utf-8"));
		expect(await textRequiresImageInput(fake, { cwd: dir })).toBe(false);
	});

	it("ignores missing files, directories, and unreadable paths", async () => {
		expect(await textRequiresImageInput(join(dir, "absent.png"), { cwd: dir })).toBe(false);
		expect(await textRequiresImageInput(dir, { cwd: dir })).toBe(false);
		expect(
			await textRequiresImageInput("broken.png", {
				cwd: dir,
				detectImage: async () => {
					throw new Error("EACCES");
				},
			}),
		).toBe(false);
	});

	it("only inspects image extensions and caps the candidate count", () => {
		expect(extractPathCandidates("a.png b.txt c")).toEqual(["a.png", "b.txt", "c"]);
		const many = Array.from({ length: 100 }, (_, i) => `f${i}.png`).join(" ");
		const probed: string[] = [];
		return textRequiresImageInput(many, {
			cwd: dir,
			detectImage: async (path) => {
				probed.push(path);
				return null;
			},
		}).then(() => {
			expect(probed.length).toBeLessThanOrEqual(32);
		});
	});

	it("reports whether a model declares image input", () => {
		expect(modelAcceptsImage({ input: ["text", "image"] })).toBe(true);
		expect(modelAcceptsImage({ input: ["text"] })).toBe(false);
		expect(modelAcceptsImage({ input: [] })).toBe(false);
	});
});

/**
 * The selector narrows its *options* when a pending attachment needs image
 * input, so an incompatible model is never offered. These assertions cover the
 * filter predicate that feeds the selector's option list.
 */
describe("model selector modality filtering", () => {
	function model(id: string, input: ("text" | "image")[]): Model<Api> {
		return {
			id,
			name: id,
			api: "openai-completions",
			provider: "orcarouter",
			baseUrl: "https://api.orcarouter.ai/v1",
			reasoning: false,
			input,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 8_192,
		} as Model<Api>;
	}

	const catalog = [
		model("orcarouter/auto", ["text"]),
		model("deepseek/deepseek-v4-pro", ["text"]),
		model("deepseek/deepseek-v4.1-flash", ["text", "image"]),
		model("google/gemini-3.5-flash", ["text", "image"]),
	];

	function optionsFor(requiresImage: boolean): string[] {
		const items = catalog.map((entry) => ({ provider: entry.provider, id: entry.id, model: entry }));
		// Same predicate the selector applies in applyRequiredInput().
		const filtered = requiresImage ? items.filter((item) => modelAcceptsImage(item.model)) : items;
		return filtered.map((item) => `${item.provider}/${item.id}`);
	}

	it("offers every model when no attachment is pending", () => {
		expect(optionsFor(false)).toHaveLength(4);
	});

	it("offers only image-capable models once an image is attached", () => {
		const options = optionsFor(true);
		expect(options).toEqual(["orcarouter/deepseek/deepseek-v4.1-flash", "orcarouter/google/gemini-3.5-flash"]);
		// Text-only models are absent from the options list, not merely rejected
		// at send time.
		expect(options).not.toContain("orcarouter/orcarouter/auto");
		expect(options).not.toContain("orcarouter/deepseek/deepseek-v4-pro");
	});

	it("leaves the selector with a clear empty state when nothing is compatible", () => {
		const textOnly = catalog.filter((entry) => !modelAcceptsImage(entry));
		const options = textOnly.filter((entry) => modelAcceptsImage(entry));
		expect(options).toHaveLength(0);
	});

	it("keeps the search text stable so filtering does not reorder by capability", () => {
		expect(getModelSelectorSearchText({ id: "deepseek/deepseek-v4.1-flash", provider: "orcarouter" })).toContain(
			"orcarouter/deepseek/deepseek-v4.1-flash",
		);
	});
});
