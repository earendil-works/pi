import { describe, expect, it } from "vitest";
import { buildPersonaAnchor, parseCharacterCard } from "../src/character-card/index.ts";

describe("parseCharacterCard", () => {
	it("parses a V2 card", () => {
		const card = parseCharacterCard(
			JSON.stringify({
				spec: "chara_card_v2",
				spec_version: "2.0",
				data: {
					name: "阿琳",
					description: "一位经营小酒馆的老板娘。",
					personality: "温柔而略带调侃",
					scenario: "傍晚的乡村酒馆里",
					first_mes: "欢迎光临～要来一杯吗？",
					mes_example: "<START>\n阿琳: 今晚月色真好啊。\n{{user}}: 是啊。",
					system_prompt: "你说话时常常提到麦酒。",
					post_history_instructions: "保持开场氛围。",
					alternate_greetings: ["哟，又见面了。", "新面孔呢。"],
					tags: ["fantasy", "tavern"],
					creator: "someone",
					character_version: "1.0",
				},
			}),
		);
		expect(card.name).toBe("阿琳");
		expect(card.description).toBe("一位经营小酒馆的老板娘。");
		expect(card.firstMes).toBe("欢迎光临～要来一杯吗？");
		expect(card.alternateGreetings).toEqual(["哟，又见面了。", "新面孔呢。"]);
		expect(card.tags).toEqual(["fantasy", "tavern"]);
		expect(card.systemPrompt).toBe("你说话时常常提到麦酒。");
	});

	it("falls back to the V1 flat format", () => {
		const card = parseCharacterCard(
			JSON.stringify({
				name: "V1角色",
				description: "旧格式",
				first_mes: "嗨",
			}),
		);
		expect(card.name).toBe("V1角色");
		expect(card.firstMes).toBe("嗨");
	});

	it("ignores a V2 data block missing optional fields", () => {
		const card = parseCharacterCard(JSON.stringify({ spec: "chara_card_v2", data: { name: "仅名字" } }));
		expect(card.name).toBe("仅名字");
		expect(card.description).toBeUndefined();
		expect(card.alternateGreetings).toEqual([]);
		expect(card.tags).toEqual([]);
	});

	it("throws when name is missing", () => {
		expect(() => parseCharacterCard(JSON.stringify({ description: "no name" }))).toThrow(/name/);
	});

	it("throws on invalid JSON", () => {
		expect(() => parseCharacterCard("not json")).toThrow();
	});
});

describe("buildPersonaAnchor", () => {
	it("assembles persona fields and roleplay rules", () => {
		const card = parseCharacterCard(
			JSON.stringify({
				name: "阿琳",
				description: "酒馆老板娘。",
				personality: "温柔",
				scenario: "酒馆内",
			}),
		);
		const anchor = buildPersonaAnchor(card);
		expect(anchor).toContain("You are 阿琳.");
		expect(anchor).toContain("酒馆老板娘。");
		expect(anchor).toContain("Scenario: 酒馆内");
		expect(anchor).toContain("Never break character");
		expect(anchor).toContain("senses");
	});

	it("omits roleplay rules when disabled", () => {
		const anchor = buildPersonaAnchor({ name: "X", alternateGreetings: [], tags: [] }, { roleplayRules: false });
		expect(anchor).not.toContain("Roleplay rules");
	});

	it("includes the example dialogue section", () => {
		const anchor = buildPersonaAnchor(
			{ name: "X", mesExample: "<START>\nX: 你好\n{{user}}: 你好呀", alternateGreetings: [], tags: [] },
			{ roleplayRules: false },
		);
		expect(anchor).toContain("Example dialogue");
		expect(anchor).toContain("X: 你好");
	});
});
