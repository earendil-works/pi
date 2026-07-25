import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	appendAnsteelTeamEvent,
	claimAnsteelTeamTask,
	createAnsteelTeamState,
	getAnsteelTeamEventPath,
	getAnsteelTeamStatePath,
	getAnsteelTeamWriteBlockReason,
	listAnsteelTeamEvents,
	loadAnsteelTeamState,
	recordAnsteelTeamTaskTestResult,
	reviewAnsteelTeamTask,
	runAnsteelTeamTaskTest,
	saveAnsteelTeamState,
	submitAnsteelTeamTask,
} from "../src/core/ansteel-team.ts";

const temporaryDirectories: string[] = [];

function createTemporaryProject(): string {
	const cwd = mkdtempSync(join(tmpdir(), "pi-ansteel-team-"));
	temporaryDirectories.push(cwd);
	return cwd;
}

function createTeam(cwd: string) {
	return createAnsteelTeamState({
		cwd,
		topic: "Review the parser change",
		roleModels: {
			"tech-lead": "provider-a/model-a",
			"staff-engineer": "provider-b/model-b",
			"qa-engineer": "provider-c/model-c",
		},
		now: new Date("2026-07-24T00:00:00.000Z"),
	});
}

function initializeGitProject(cwd: string): void {
	mkdirSync(join(cwd, "src"), { recursive: true });
	writeFileSync(join(cwd, "src", "parser.ts"), "export const parser = 'before';\n", "utf8");
	execFileSync("git", ["init"], { cwd, stdio: "ignore" });
	execFileSync("git", ["config", "user.email", "ansteel@example.test"], { cwd, stdio: "ignore" });
	execFileSync("git", ["config", "user.name", "Ansteel Test"], { cwd, stdio: "ignore" });
	execFileSync("git", ["add", "src/parser.ts"], { cwd, stdio: "ignore" });
	execFileSync("git", ["commit", "-m", "baseline"], { cwd, stdio: "ignore" });
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { force: true, recursive: true });
	}
});

describe("Ansteel team state", () => {
	it("persists an active team with one independent role session slot per role", () => {
		const cwd = createTemporaryProject();
		const team = createTeam(cwd);

		saveAnsteelTeamState(cwd, team);

		expect(loadAnsteelTeamState(cwd)).toEqual(team);
		expect(team.status).toBe("active");
		expect(team.nextEventSequence).toBe(1);
		expect(Object.keys(team.roles)).toEqual(["tech-lead", "staff-engineer", "qa-engineer"]);
		expect(team.roles["qa-engineer"].model).toBe("provider-c/model-c");
		expect(team.tasks).toEqual([]);
	});

	it("migrates a persisted version 1 team with an empty task and hashed event ledger", () => {
		const cwd = createTemporaryProject();
		const team = createTeam(cwd);
		const legacyTeam = { ...team, version: 1 } as Record<string, unknown>;
		delete legacyTeam.tasks;
		delete legacyTeam.ledgerHeadHash;
		mkdirSync(join(cwd, ".pi", "ansteel-team"), { recursive: true });
		writeFileSync(getAnsteelTeamStatePath(cwd), `${JSON.stringify(legacyTeam)}\n`, "utf8");

		const migrated = loadAnsteelTeamState(cwd);

		expect(migrated).toMatchObject({ version: 3, tasks: [], ledgerHeadHash: null });
		expect(migrated?.roles).toEqual(team.roles);
	});

	it("migrates a contiguous legacy event ledger into a persisted hash chain", () => {
		const cwd = createTemporaryProject();
		const team = createTeam(cwd);
		const legacyTeam = { ...team, version: 1, nextEventSequence: 2 } as Record<string, unknown>;
		delete legacyTeam.tasks;
		delete legacyTeam.ledgerHeadHash;
		mkdirSync(join(cwd, ".pi", "ansteel-team"), { recursive: true });
		writeFileSync(getAnsteelTeamStatePath(cwd), `${JSON.stringify(legacyTeam)}\n`, "utf8");
		writeFileSync(
			getAnsteelTeamEventPath(cwd),
			`${JSON.stringify({
				sequence: 1,
				type: "role-report",
				role: "tech-lead",
				content: "L1: inspected the legacy parser implementation.",
				createdAt: "2026-07-24T00:00:00.000Z",
			})}\n`,
			"utf8",
		);

		const migrated = loadAnsteelTeamState(cwd);
		const events = listAnsteelTeamEvents(cwd);
		const persistedState = JSON.parse(readFileSync(getAnsteelTeamStatePath(cwd), "utf8")) as Record<string, unknown>;
		const persistedEvent = JSON.parse(readFileSync(getAnsteelTeamEventPath(cwd), "utf8")) as Record<string, unknown>;

		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			sequence: 1,
			previousHash: null,
			hash: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
		expect(migrated).toMatchObject({ version: 3, ledgerHeadHash: events[0]?.hash, nextEventSequence: 2 });
		expect(persistedState).toMatchObject({ version: 3, ledgerHeadHash: events[0]?.hash });
		expect(persistedEvent).toMatchObject({ previousHash: null, hash: events[0]?.hash });
	});

	it("rejects a mixed legacy and hashed event ledger during migration", () => {
		const cwd = createTemporaryProject();
		const team = createTeam(cwd);
		const legacyTeam = { ...team, version: 2, nextEventSequence: 3 } as Record<string, unknown>;
		delete legacyTeam.ledgerHeadHash;
		mkdirSync(join(cwd, ".pi", "ansteel-team"), { recursive: true });
		writeFileSync(getAnsteelTeamStatePath(cwd), `${JSON.stringify(legacyTeam)}\n`, "utf8");
		writeFileSync(
			getAnsteelTeamEventPath(cwd),
			`${[
				JSON.stringify({
					sequence: 1,
					type: "role-report",
					role: "tech-lead",
					content: "L1: legacy event.",
					createdAt: "2026-07-24T00:00:00.000Z",
				}),
				JSON.stringify({
					sequence: 2,
					type: "role-report",
					role: "qa-engineer",
					content: "L1: malformed mixed event.",
					createdAt: "2026-07-24T00:01:00.000Z",
					previousHash: "0".repeat(64),
				}),
			].join("\n")}\n`,
			"utf8",
		);

		expect(() => loadAnsteelTeamState(cwd)).toThrow("mixed legacy and hashed");
	});

	it("appends public events in sequence and advances the persisted state", () => {
		const cwd = createTemporaryProject();
		const team = createTeam(cwd);
		saveAnsteelTeamState(cwd, team);

		const report = appendAnsteelTeamEvent(cwd, team, {
			type: "role-report",
			role: "staff-engineer",
			content: "L1: package test output is green.",
		});
		const challenge = appendAnsteelTeamEvent(cwd, team, {
			type: "challenge",
			role: "qa-engineer",
			targetRole: "staff-engineer",
			challengeId: "QA-1",
			content: "Add a regression for malformed input.",
		});

		expect(report.sequence).toBe(1);
		expect(challenge.sequence).toBe(2);
		expect(loadAnsteelTeamState(cwd)?.nextEventSequence).toBe(3);
		expect(listAnsteelTeamEvents(cwd)).toEqual([report, challenge]);
		expect(readFileSync(getAnsteelTeamEventPath(cwd), "utf8").trim().split("\n")).toHaveLength(2);
	});

	it("links event hashes and rejects a tampered event ledger", () => {
		const cwd = createTemporaryProject();
		const team = createTeam(cwd);
		saveAnsteelTeamState(cwd, team);

		const first = appendAnsteelTeamEvent(cwd, team, {
			type: "role-report",
			role: "tech-lead",
			content: "L1: inspected the parser implementation.",
		});
		const second = appendAnsteelTeamEvent(cwd, team, {
			type: "role-report",
			role: "qa-engineer",
			content: "L1: reviewed the test evidence.",
		});

		expect(first.previousHash).toBeNull();
		expect(second.previousHash).toBe(first.hash);
		expect(team.ledgerHeadHash).toBe(second.hash);

		const eventPath = getAnsteelTeamEventPath(cwd);
		const events = readFileSync(eventPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		events[1].content = "L1: rewritten after review.";
		writeFileSync(eventPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");

		expect(() => listAnsteelTeamEvents(cwd)).toThrow("hash mismatch");
	});

	it("rejects a persisted state whose ledger head does not match the event chain", () => {
		const cwd = createTemporaryProject();
		const team = createTeam(cwd);
		saveAnsteelTeamState(cwd, team);
		appendAnsteelTeamEvent(cwd, team, {
			type: "role-report",
			role: "tech-lead",
			content: "L1: inspected the parser implementation.",
		});

		const statePath = getAnsteelTeamStatePath(cwd);
		const state = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
		state.ledgerHeadHash = "0".repeat(64);
		writeFileSync(statePath, `${JSON.stringify(state)}\n`, "utf8");

		expect(() => loadAnsteelTeamState(cwd)).toThrow("ledger head hash");
	});

	it("requires an owner to claim exact in-project files before a change task is active", () => {
		const cwd = createTemporaryProject();
		const team = createTeam(cwd);

		const task = claimAnsteelTeamTask(cwd, team, {
			id: "TASK-1",
			owner: "staff-engineer",
			files: ["src/parser.ts", "test/parser.test.ts"],
			description: "Handle empty parser input.",
			acceptanceCriteria: "The targeted parser test passes.",
		});

		expect(task).toMatchObject({
			id: "TASK-1",
			owner: "staff-engineer",
			files: ["src/parser.ts", "test/parser.test.ts"],
			status: "claimed",
		});
		expect(() =>
			claimAnsteelTeamTask(cwd, team, {
				id: "TASK-2",
				owner: "qa-engineer",
				files: ["src/parser.ts"],
				description: "Competing change.",
				acceptanceCriteria: "No conflict.",
			}),
		).toThrow("already claimed");
		expect(() =>
			claimAnsteelTeamTask(cwd, team, {
				id: "TASK-3",
				owner: "tech-lead",
				files: ["../outside.ts"],
				description: "Escaping change.",
				acceptanceCriteria: "Never runs.",
			}),
		).toThrow("must stay inside the project");
		expect(getAnsteelTeamWriteBlockReason(cwd, team, "staff-engineer", "src/parser.ts")).toBeUndefined();
		expect(getAnsteelTeamWriteBlockReason(cwd, team, "qa-engineer", "src/parser.ts")).toContain("must be claimed");
	});

	it("submits an immutable scoped diff only after a successful recorded test", () => {
		const cwd = createTemporaryProject();
		initializeGitProject(cwd);
		const team = createTeam(cwd);
		const task = claimAnsteelTeamTask(cwd, team, {
			id: "TASK-1",
			owner: "staff-engineer",
			files: ["src/parser.ts"],
			description: "Handle empty parser input.",
			acceptanceCriteria: "The targeted parser test passes.",
		});
		writeFileSync(join(cwd, "src", "parser.ts"), "export const parser = 'after';\n", "utf8");

		recordAnsteelTeamTaskTestResult(cwd, team, "staff-engineer", task.id, {
			command: "npm test -- parser",
			output: "PASS parser handles empty input",
			isError: false,
		});
		const submission = submitAnsteelTeamTask(cwd, team, "staff-engineer", task.id, "npm test -- parser");

		expect(submission.diff).toContain("parser = 'after'");
		expect(submission.test).toMatchObject({ command: "npm test -- parser", isError: false });
		expect(task.status).toBe("submitted");
		expect(getAnsteelTeamWriteBlockReason(cwd, team, "staff-engineer", "src/parser.ts")).toContain("code is frozen");
	});

	it("runs a bounded allowed test command and records its real output", () => {
		const cwd = createTemporaryProject();
		mkdirSync(join(cwd, "test"), { recursive: true });
		writeFileSync(
			join(cwd, "test", "task.test.mjs"),
			"import test from 'node:test';\ntest('ok', () => {});\n",
			"utf8",
		);
		const team = createTeam(cwd);
		const task = claimAnsteelTeamTask(cwd, team, {
			id: "TASK-1",
			owner: "staff-engineer",
			files: ["src/parser.ts"],
			description: "Handle empty parser input.",
			acceptanceCriteria: "The targeted parser test passes.",
		});

		const test = runAnsteelTeamTaskTest(cwd, team, "staff-engineer", task.id, "node --test test/task.test.mjs");

		expect(test.isError).toBe(false);
		expect(test.output).toMatch(/pass 1/i);
	});

	it("returns a submitted change for revision when QA rejects and approves only after both peers agree", () => {
		const cwd = createTemporaryProject();
		initializeGitProject(cwd);
		const team = createTeam(cwd);
		const task = claimAnsteelTeamTask(cwd, team, {
			id: "TASK-1",
			owner: "staff-engineer",
			files: ["src/parser.ts"],
			description: "Handle empty parser input.",
			acceptanceCriteria: "The targeted parser test passes.",
		});
		writeFileSync(join(cwd, "src", "parser.ts"), "export const parser = 'first';\n", "utf8");
		recordAnsteelTeamTaskTestResult(cwd, team, "staff-engineer", task.id, {
			command: "npm test -- parser",
			output: "PASS first revision",
			isError: false,
		});
		submitAnsteelTeamTask(cwd, team, "staff-engineer", task.id, "npm test -- parser");

		reviewAnsteelTeamTask(cwd, team, "tech-lead", task.id, { verdict: "approve" });
		reviewAnsteelTeamTask(cwd, team, "qa-engineer", task.id, {
			verdict: "reject",
			issue: "QA-1: empty input remains untested.",
		});
		expect(task.status).toBe("revision-required");

		writeFileSync(join(cwd, "src", "parser.ts"), "export const parser = 'second';\n", "utf8");
		recordAnsteelTeamTaskTestResult(cwd, team, "staff-engineer", task.id, {
			command: "npm test -- parser",
			output: "PASS revised parser",
			isError: false,
		});
		submitAnsteelTeamTask(cwd, team, "staff-engineer", task.id, "npm test -- parser");
		reviewAnsteelTeamTask(cwd, team, "tech-lead", task.id, { verdict: "approve" });
		reviewAnsteelTeamTask(cwd, team, "qa-engineer", task.id, { verdict: "approve" });

		expect(task.status).toBe("approved");
		expect(task.submissions).toHaveLength(2);
	});

	it("closes an open challenge only through a matching resolution event", () => {
		const cwd = createTemporaryProject();
		const team = createTeam(cwd);

		appendAnsteelTeamEvent(cwd, team, {
			type: "challenge",
			role: "staff-engineer",
			targetRole: "tech-lead",
			challengeId: "STAFF-1",
			content: "Clarify the transaction boundary.",
		});
		expect(team.openChallenges).toEqual([
			{
				id: "STAFF-1",
				raisedBy: "staff-engineer",
				targetRole: "tech-lead",
				status: "open",
			},
		]);

		appendAnsteelTeamEvent(cwd, team, {
			type: "resolution",
			role: "tech-lead",
			challengeId: "STAFF-1",
			content: "The boundary is documented and covered by a test.",
		});

		expect(team.openChallenges[0]?.status).toBe("resolved");
	});

	it("rejects state and event paths that escape the reviewed project", () => {
		const cwd = createTemporaryProject();

		expect(getAnsteelTeamStatePath(cwd)).toMatch(/^.+\.pi[\\/]ansteel-team[\\/]team\.json$/);
		expect(getAnsteelTeamEventPath(cwd)).toMatch(/^.+\.pi[\\/]ansteel-team[\\/]events\.jsonl$/);
		expect(() => createAnsteelTeamState({ cwd: "", topic: "Review", roleModels: {} as never })).toThrow(
			"Ansteel team requires a project directory",
		);
	});

	it("rejects corrupt persisted challenge entries with a governance error", () => {
		const cwd = createTemporaryProject();
		const team = createTeam(cwd);
		team.openChallenges = [null as unknown as (typeof team.openChallenges)[number]];

		expect(() => saveAnsteelTeamState(cwd, team)).toThrow("Ansteel team state has invalid challenge entries");
	});
});
