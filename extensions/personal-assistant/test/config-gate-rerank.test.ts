import { describe, it, expect } from "vitest";
import type { PersonalAssistantConfig } from "../memory.ts";

// Type-level test for design.md D6 / spec R5 / addendum B7-B8 —
// PersonalAssistantConfig.memory must accept `gate: { enabled?: boolean }`,
// `rewrite: { enabled?: boolean }`, and `rerank: { enabled?: boolean }`.
//
// Defaults are `true` when the field is omitted, and existing settings.json
// files (which lack these fields entirely) must continue to typecheck — the
// fields are optional and the existing `loadConfig()` body already coalesces
// missing fields via `JSON.parse + ?? {}`, so no runtime fallback change.
//
// Vitest alone cannot detect a missing optional field at runtime (TypeScript
// types are erased), so the real verification is `npm run check` (tsgo
// --noEmit). The runtime assertions below serve as documentation and
// smoke-check that the literal was preserved.

describe("PersonalAssistantConfig gate/rewrite/rerank fields (D6 / spec R5 / B7-B8)", () => {
	it("P5: accepts memory.gate = { enabled: false }", () => {
		const cfg: PersonalAssistantConfig = {
			memory: { gate: { enabled: false }, dbPath: "/tmp/x.db" },
		};
		expect(cfg.memory?.gate?.enabled).toBe(false);
	});

	it("P5: accepts memory.gate = { enabled: true }", () => {
		const cfg: PersonalAssistantConfig = {
			memory: { gate: { enabled: true }, dbPath: "/tmp/x.db" },
		};
		expect(cfg.memory?.gate?.enabled).toBe(true);
	});

	it("P5: accepts memory.gate = {} (field-level default)", () => {
		const cfg: PersonalAssistantConfig = {
			memory: { gate: {}, dbPath: "/tmp/x.db" },
		};
		expect(cfg.memory?.gate?.enabled).toBeUndefined();
	});

	it("B7: accepts memory.rewrite = { enabled: false }", () => {
		const cfg: PersonalAssistantConfig = {
			memory: { rewrite: { enabled: false }, dbPath: "/tmp/x.db" },
		};
		expect(cfg.memory?.rewrite?.enabled).toBe(false);
	});

	it("B7: accepts memory.rewrite = { enabled: true }", () => {
		const cfg: PersonalAssistantConfig = {
			memory: { rewrite: { enabled: true }, dbPath: "/tmp/x.db" },
		};
		expect(cfg.memory?.rewrite?.enabled).toBe(true);
	});

	it("B7: accepts memory.rewrite = {} (field-level default)", () => {
		const cfg: PersonalAssistantConfig = {
			memory: { rewrite: {}, dbPath: "/tmp/x.db" },
		};
		expect(cfg.memory?.rewrite?.enabled).toBeUndefined();
	});

	it("fixup: rewrite and gate are independent (B8)", () => {
		const cfg: PersonalAssistantConfig = {
			memory: {
				gate: { enabled: false },
				rewrite: { enabled: true },
				dbPath: "/tmp/x.db",
			},
		};
		expect(cfg.memory?.gate?.enabled).toBe(false);
		expect(cfg.memory?.rewrite?.enabled).toBe(true);
	});

	it("P6: accepts memory.rerank = { enabled: false }", () => {
		const cfg: PersonalAssistantConfig = {
			memory: { rerank: { enabled: false }, dbPath: "/tmp/x.db" },
		};
		expect(cfg.memory?.rerank?.enabled).toBe(false);
	});

	it("P6: accepts memory.rerank = { enabled: true }", () => {
		const cfg: PersonalAssistantConfig = {
			memory: { rerank: { enabled: true }, dbPath: "/tmp/x.db" },
		};
		expect(cfg.memory?.rerank?.enabled).toBe(true);
	});

	it("P6: accepts memory.rerank = {} (field-level default)", () => {
		const cfg: PersonalAssistantConfig = {
			memory: { rerank: {}, dbPath: "/tmp/x.db" },
		};
		expect(cfg.memory?.rerank?.enabled).toBeUndefined();
	});

	it("backward compat: old settings.json shape (no gate / no rewrite / no rerank) still typechecks", () => {
		// Pre-R5 settings.json — only the fields R5 didn't add. Must keep
		// typechecking so old configs don't break (principle 8: backward compat).
		const old: PersonalAssistantConfig = {
			memory: { enabled: true, dbPath: "/tmp/x.db" },
		};
		expect(old.memory?.gate).toBeUndefined();
		expect(old.memory?.rewrite).toBeUndefined();
		expect(old.memory?.rerank).toBeUndefined();
	});

	it("backward compat: empty memory block still typechecks", () => {
		const cfg: PersonalAssistantConfig = { memory: {} };
		expect(cfg.memory?.gate).toBeUndefined();
		expect(cfg.memory?.rewrite).toBeUndefined();
		expect(cfg.memory?.rerank).toBeUndefined();
	});

	it("backward compat: missing memory block still typechecks", () => {
		const cfg: PersonalAssistantConfig = {};
		expect(cfg.memory).toBeUndefined();
	});
});
