import { describe, expect, it } from "vitest";
import { parsePersistentStore, resolvePersistentStore, resolveSessionStore } from "../src/core/persistent-store.ts";

describe("persistent store selection", () => {
	it("defaults to JSONL", () => {
		expect(parsePersistentStore(undefined)).toBe("jsonl");
		expect(parsePersistentStore("")).toBe("jsonl");
	});

	it("normalizes supported values", () => {
		expect(parsePersistentStore("JSONL")).toBe("jsonl");
		expect(parsePersistentStore(" SQLite ")).toBe("sqlite");
	});

	it("rejects unsupported values", () => {
		expect(() => parsePersistentStore("memory")).toThrow(
			'Invalid PERSISTENT_STORE value "memory"; expected "jsonl" or "sqlite"',
		);
	});

	it("prefers explicit SDK configuration over the environment", () => {
		expect(resolvePersistentStore("sqlite", { PERSISTENT_STORE: "jsonl" })).toBe("sqlite");
		expect(resolvePersistentStore(undefined, { PERSISTENT_STORE: "SQLITE" })).toBe("sqlite");
	});

	it("gives no-session memory mode precedence without parsing the environment", () => {
		expect(resolveSessionStore({ noSession: true, env: { PERSISTENT_STORE: "invalid" } })).toBe("memory");
		expect(resolveSessionStore({ noSession: false, env: { PERSISTENT_STORE: "sqlite" } })).toBe("sqlite");
	});
});
