import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadScopeState, mergeValidationContract, persistScopeDocuments, sanitizeScopeName } from "./storage.js";
import type { AskUserAnswer, AskUserRequest, ValidationContractDocument } from "./types.js";

describe("ask-user storage", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("sanitizes scope names into durable folder names", () => {
		expect(sanitizeScopeName(" Login Flow QA ")).toBe("login-flow-qa");
	});

	it("merges validation answers into normalized entries", () => {
		const request: AskUserRequest = {
			mode: "validation_contract",
			objective: "Verify login flow",
			questions: [],
			suggestedEntries: [{ id: "login-flow" }],
		};
		const existing: ValidationContractDocument = {
			version: 1,
			scopeName: "login-flow",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			objectiveHistory: ["Initial"],
			entries: [{ id: "login-flow", surface: "xtui" }],
			answers: [],
			notes: [],
		};
		const answers: AskUserAnswer[] = [
			{
				questionId: "surface",
				topic: "Surface",
				prompt: "Which surface?",
				answer: "cdp",
				source: "option",
				field: "surface",
				entryId: "login-flow",
			},
			{
				questionId: "expect",
				topic: "Expectation",
				prompt: "What should happen?",
				answer: "dashboard becomes visible",
				source: "custom",
				field: "expect",
				entryId: "login-flow",
			},
		];

		const merged = mergeValidationContract({
			existing,
			scopeName: "login-flow",
			request,
			answers,
		});

		expect(merged.entries).toEqual([
			{
				id: "login-flow",
				surface: "cdp",
				expect: "dashboard becomes visible",
			},
		]);
		expect(merged.objectiveHistory).toContain("Verify login flow");
	});

	it("persists scope documents and reloads them through the active-session pointer", () => {
		const cwd = mkdtempSync(join(tmpdir(), "mu-ask-user-storage-"));
		tempDirs.push(cwd);

		const validationContract: ValidationContractDocument = {
			version: 1,
			scopeName: "login-flow",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			objectiveHistory: ["Verify login flow"],
			entries: [{ id: "login-flow", surface: "cdp", expect: "dashboard visible" }],
			answers: [],
			notes: [],
		};

		const files = persistScopeDocuments({
			cwd,
			scopeName: "login-flow",
			sessionId: "session-123",
			validationContract,
		});

		expect(files.some((file) => file.endsWith("validation-contract.json"))).toBe(true);

		const state = loadScopeState({
			cwd,
			sessionId: "session-123",
		});

		expect(state.scopeName).toBe("login-flow");
		expect(state.validationContract?.entries[0]?.surface).toBe("cdp");
	});
});
