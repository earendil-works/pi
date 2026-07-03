// gate.ts buildGatePrompt (task 2.2) — prompt format contract.
//
// buildGatePrompt is a pure function that turns (current + recent) into the
// ollama `/api/chat` `messages` array (system + user). It is the single source
// of truth for what the gate LLM (qwen2.5:3b) sees; scenarios S1–S4
// (downstream: 指代性 / 零信息量 / 历史回溯) all hinge
// on the system prompt guiding the LLM to emit {need_memory}
// correctly. S5 (parse fail) is exercised by 2.3 — this file only pins the
// prompt shape so 2.3 can call it without re-deriving the format.
//
// Why test the prompt text instead of round-tripping through ollama?
//   - Pure function: no I/O, no clock. Tests run in milliseconds and never
//     touch the network. That is the whole reason buildGatePrompt was split
//     out from callGate in design.md D2.
//   - The system prompt is the lever for recall precision (per design.md D3:
//     "JSON output schema, JSON.parse retry"); if a future edit drops the
//     指代性 / 零信息量 / 历史回溯 rules, S1/S2/S3/S4 stop working without any
//     local signal. Pinning the substrings here is a low-cost regression
//     guard.
//
// Scope: format only. The JSON.parse + retry + timeout logic is task 2.3.

import { describe, it, expect } from "vitest";
import { buildGatePrompt } from "../gate.ts";

describe("buildGatePrompt (task 2.2)", () => {
	it("exports buildGatePrompt as a function", () => {
		expect(typeof buildGatePrompt).toBe("function");
	});

	it("returns an array of exactly 2 messages", () => {
		const messages = buildGatePrompt("hello", []);
		expect(Array.isArray(messages)).toBe(true);
		expect(messages).toHaveLength(2);
	});

	it("first message is system role with Chinese-mixed JSON instructions", () => {
		const [system] = buildGatePrompt("hello", []);
		expect(system.role).toBe("system");
		// Spec mandates these substrings — see tasks.md task 2.2 system block.
		expect(system.content).toContain("memory recall");
		expect(system.content).toContain("决策助手");
		expect(system.content).toContain("need_memory");
		// search_query field removed in task 1.1 — gate is pure binary decision.
		expect(system.content).not.toContain("search_query");
		// The two false-positive rules (指代性 / 零信息量) drive S1 and S2.
		expect(system.content).toContain("上面的脚本");
		expect(system.content).toContain("那个");
		expect(system.content).toContain("对");
		expect(system.content).toContain("好的");
		expect(system.content).toContain("继续");
		// The historical-recall rule drives S3/S4.
		expect(system.content).toContain("之前");
		expect(system.content).toContain("记得吗");
		expect(system.content).toContain("历史");
	});

	it("second message is user role and contains Recent + Current + JSON-only instruction", () => {
		const recent = ["列一下 TODO", "列出 TODO"];
		const [, user] = buildGatePrompt("对", recent);
		expect(user.role).toBe("user");
		// Structure markers from spec.
		expect(user.content).toContain("Recent user messages:");
		expect(user.content).toContain("Current message:");
		expect(user.content).toContain("Respond JSON only:");
		// Content fidelity — both recent items and the current msg must appear verbatim.
		for (const m of recent) {
			expect(user.content).toContain(m);
		}
		expect(user.content).toContain("对");
	});

	it("when recent is empty, no list items leak in and current+JSON markers still present", () => {
		const [, user] = buildGatePrompt("继续", []);
		// Spec ambiguity: spec says "空则省略", task outline says "Recent user messages: None".
		// Either is acceptable — we only assert no fake list items appear and the rest of the
		// structure survives.
		expect(user.content).not.toMatch(/^- /m);
		expect(user.content).toContain("Current message:");
		expect(user.content).toContain("继续");
		expect(user.content).toContain("Respond JSON only:");
	});

	it("when recent has more than 3 items, only the last 3 are kept", () => {
		const recent = ["old1", "old2", "old3", "keep1", "keep2", "keep3"];
		const [, user] = buildGatePrompt("hi", recent);
		// Kept (last 3).
		expect(user.content).toContain("keep1");
		expect(user.content).toContain("keep2");
		expect(user.content).toContain("keep3");
		// Dropped (older than last 3).
		expect(user.content).not.toContain("old1");
		expect(user.content).not.toContain("old2");
		expect(user.content).not.toContain("old3");
	});

	it("when recent has exactly 3 items, all 3 are kept", () => {
		const recent = ["msg-a", "msg-b", "msg-c"];
		const [, user] = buildGatePrompt("hi", recent);
		for (const m of recent) {
			expect(user.content).toContain(m);
		}
		// All three are "- msg-X" list rows — exactly 3 list markers.
		const listMarkers = user.content.match(/^- /gm) ?? [];
		expect(listMarkers).toHaveLength(3);
	});

	it("user content ends with the 'Respond JSON only:' instruction", () => {
		const [, user] = buildGatePrompt("anything", ["recent"]);
		// Trim trailing newline so trailing-whitespace drift doesn't fail this check.
		expect(user.content.trimEnd().endsWith("Respond JSON only:")).toBe(true);
	});

	it("system and user content are independent (system does not bleed into user)", () => {
		const [system, user] = buildGatePrompt("对", ["TODO"]);
		// 'memory recall' is a system-prompt marker — it must NOT appear in the user block.
		expect(user.content).not.toContain("memory recall");
		expect(system.content).not.toContain("Current message:");
	});
});