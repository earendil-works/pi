import { describe, expect, it } from "vitest";
import { extractCharacterCardFromPng } from "../src/character-card/index.ts";
import { buildPngWithCard, buildPngWithTextChunks } from "./png-util.ts";

describe("extractCharacterCardFromPng", () => {
	it("extracts the chara card from a tEXt chunk", () => {
		const cardJson = JSON.stringify({ name: "阿琳", description: "酒馆老板娘" });
		const extracted = extractCharacterCardFromPng(buildPngWithCard(cardJson));
		expect(extracted).toBe(cardJson);
	});

	it("ignores unrelated tEXt chunks and finds chara", () => {
		const cardJson = JSON.stringify({ name: "测试" });
		const png = buildPngWithTextChunks([
			{ keyword: "Software", value: "SillyTavern" },
			{ keyword: "chara", value: Buffer.from(cardJson, "utf8").toString("base64") },
		]);
		expect(extractCharacterCardFromPng(png)).toBe(cardJson);
	});

	it("returns undefined when no chara chunk exists", () => {
		const png = buildPngWithTextChunks([{ keyword: "Software", value: "SillyTavern" }]);
		expect(extractCharacterCardFromPng(png)).toBeUndefined();
	});

	it("throws on non-PNG input", () => {
		expect(() => extractCharacterCardFromPng(new Uint8Array([1, 2, 3]))).toThrow(/Not a PNG/);
	});
});
