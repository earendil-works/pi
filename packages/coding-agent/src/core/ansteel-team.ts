import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { getCwdRelativePath, resolvePath } from "../utils/paths.ts";
import { ANSTEEL_ROLES, type AnsteelRole } from "./ansteel-discussion.ts";

const ANSTEEL_TEAM_STATE_VERSION = 3;
const MAX_PUBLIC_EVENT_CONTENT_LENGTH = 16_384;
const ANSTEEL_TEAM_TEST_TIMEOUT_MS = 60_000;
const ANSTEEL_TEAM_TEST_COMMAND_PREFIX =
	/^(?:npm (?:test|run (?:test|check|lint|typecheck)\b|exec -- (?:vitest|jest|tsc)\b)|npx (?:vitest|jest|tsc)\b|pnpm (?:test|run (?:test|check|lint|typecheck)\b)|yarn (?:test|run (?:test|check|lint|typecheck)\b)|bun test\b|vitest\b|jest\b|node --test\b|pytest\b|go test\b|cargo test\b|dotnet test\b|mvn test\b|(?:\.\/)?gradlew test\b|make test\b)/;

export type AnsteelTeamStatus = "active" | "stopped";

export type AnsteelTeamEventType =
	| "role-report"
	| "challenge"
	| "resolution"
	| "role-failure"
	| "task-claimed"
	| "task-submitted"
	| "task-review";

export interface AnsteelTeamRoleState {
	model: string;
	sessionFile: string;
	status: "idle" | "working" | "failed";
}

export interface AnsteelTeamChallenge {
	id: string;
	raisedBy: AnsteelRole;
	targetRole: AnsteelRole;
	status: "open" | "resolved";
}

export interface AnsteelTeamTask {
	id: string;
	owner: AnsteelRole;
	files: string[];
	description: string;
	acceptanceCriteria: string;
	status: "claimed" | "submitted" | "revision-required" | "approved";
	revision: number;
	testEvidence: AnsteelTeamTaskTestEvidence[];
	submissions: AnsteelTeamTaskSubmission[];
	reviews: AnsteelTeamTaskReview[];
}

export interface AnsteelTeamTaskTestEvidence {
	command: string;
	output: string;
	isError: boolean;
	completedAt: string;
}

export interface AnsteelTeamTaskSubmission {
	revision: number;
	submittedAt: string;
	diff: string;
	test: AnsteelTeamTaskTestEvidence;
}

export interface AnsteelTeamTaskReview {
	revision: number;
	reviewer: AnsteelRole;
	verdict: "approve" | "reject";
	issue?: string;
	reviewedAt: string;
}

export interface ClaimAnsteelTeamTaskInput {
	id: string;
	owner: AnsteelRole;
	files: string[];
	description: string;
	acceptanceCriteria: string;
}

export interface RecordAnsteelTeamTaskTestResultInput {
	command: string;
	output: string;
	isError: boolean;
}

export interface ReviewAnsteelTeamTaskInput {
	verdict: "approve" | "reject";
	issue?: string;
}

export interface AnsteelTeamState {
	version: number;
	id: string;
	topic: string;
	status: AnsteelTeamStatus;
	createdAt: string;
	updatedAt: string;
	nextEventSequence: number;
	roles: Record<AnsteelRole, AnsteelTeamRoleState>;
	openChallenges: AnsteelTeamChallenge[];
	tasks: AnsteelTeamTask[];
	ledgerHeadHash: string | null;
}

export interface CreateAnsteelTeamStateOptions {
	cwd: string;
	topic: string;
	roleModels: Record<AnsteelRole, string>;
	now?: Date;
}

export interface AnsteelTeamEventInput {
	type: AnsteelTeamEventType;
	role: AnsteelRole;
	targetRole?: AnsteelRole;
	challengeId?: string;
	content: string;
}

export interface AnsteelTeamEvent extends AnsteelTeamEventInput {
	sequence: number;
	createdAt: string;
	previousHash: string | null;
	hash: string;
}

export class AnsteelTeamStateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AnsteelTeamStateError";
	}
}

function assertProjectDirectory(cwd: string): string {
	if (cwd.trim().length === 0) throw new AnsteelTeamStateError("Ansteel team requires a project directory");
	return resolvePath(cwd);
}

export function getAnsteelTeamDirectory(cwd: string): string {
	return resolvePath(join(assertProjectDirectory(cwd), ".pi", "ansteel-team"));
}

export function getAnsteelTeamStatePath(cwd: string): string {
	return join(getAnsteelTeamDirectory(cwd), "team.json");
}

export function getAnsteelTeamEventPath(cwd: string): string {
	return join(getAnsteelTeamDirectory(cwd), "events.jsonl");
}

function getAnsteelTeamRoleSessionPath(cwd: string, role: AnsteelRole): string {
	return join(getAnsteelTeamDirectory(cwd), "sessions", `${role}.jsonl`);
}

function createAnsteelTeamId(now: Date): string {
	return `ansteel-team-${now.toISOString().replace(/[:.]/g, "-")}`;
}

function assertRoleModels(roleModels: Record<AnsteelRole, string>): void {
	for (const role of ANSTEEL_ROLES) {
		if (typeof roleModels[role] !== "string" || roleModels[role].trim().length === 0) {
			throw new AnsteelTeamStateError(`Ansteel team role ${role} requires a configured provider/model`);
		}
	}
}

function assertRole(role: unknown, field: string): asserts role is AnsteelRole {
	if (!ANSTEEL_ROLES.includes(role as AnsteelRole)) {
		throw new AnsteelTeamStateError(`Ansteel team ${field} must be one of ${ANSTEEL_ROLES.join(", ")}`);
	}
}

function assertChallengeId(id: string | undefined, eventType: AnsteelTeamEventType): asserts id is string {
	if (typeof id !== "string" || !/^[A-Z][A-Z0-9-]*$/.test(id)) {
		throw new AnsteelTeamStateError(`Ansteel team ${eventType} requires an uppercase challenge ID`);
	}
}

function assertTaskId(id: unknown): asserts id is string {
	if (typeof id !== "string" || !/^TASK-[A-Z0-9-]+$/.test(id)) {
		throw new AnsteelTeamStateError("Ansteel team task IDs must use the TASK-<UPPERCASE-ID> form");
	}
}

function assertPublicContent(content: string): void {
	if (typeof content !== "string" || content.trim().length === 0) {
		throw new AnsteelTeamStateError("Ansteel team events require non-empty public content");
	}
	if (content.length > MAX_PUBLIC_EVENT_CONTENT_LENGTH) {
		throw new AnsteelTeamStateError(
			`Ansteel team public content exceeds ${MAX_PUBLIC_EVENT_CONTENT_LENGTH} characters`,
		);
	}
}

function assertLedgerHash(value: unknown, field: string, allowNull: true): asserts value is string | null;
function assertLedgerHash(value: unknown, field: string, allowNull: false): asserts value is string;
function assertLedgerHash(value: unknown, field: string, allowNull: boolean): asserts value is string | null {
	if (allowNull && value === null) return;
	if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
		throw new AnsteelTeamStateError(`Ansteel team ${field} must be a SHA-256 hash`);
	}
}

function assertState(state: AnsteelTeamState): void {
	if (state.version !== ANSTEEL_TEAM_STATE_VERSION) {
		throw new AnsteelTeamStateError(`Unsupported Ansteel team state version: ${state.version}`);
	}
	if (typeof state.id !== "string" || state.id.length === 0)
		throw new AnsteelTeamStateError("Ansteel team state requires an ID");
	if (typeof state.topic !== "string" || state.topic.trim().length === 0) {
		throw new AnsteelTeamStateError("Ansteel team state requires a topic");
	}
	if (state.status !== "active" && state.status !== "stopped") {
		throw new AnsteelTeamStateError("Ansteel team state has an invalid status");
	}
	if (!Number.isSafeInteger(state.nextEventSequence) || state.nextEventSequence < 1) {
		throw new AnsteelTeamStateError("Ansteel team state has an invalid next event sequence");
	}
	assertLedgerHash(state.ledgerHeadHash, "ledger head hash", true);
	assertRoleModels(
		Object.fromEntries(ANSTEEL_ROLES.map((role) => [role, state.roles?.[role]?.model])) as Record<
			AnsteelRole,
			string
		>,
	);
	for (const role of ANSTEEL_ROLES) {
		const roleState = state.roles[role];
		if (typeof roleState.sessionFile !== "string" || roleState.sessionFile.length === 0) {
			throw new AnsteelTeamStateError(`Ansteel team ${role} requires a session file`);
		}
		if (roleState.status !== "idle" && roleState.status !== "working" && roleState.status !== "failed") {
			throw new AnsteelTeamStateError(`Ansteel team ${role} has an invalid role status`);
		}
	}
	if (!Array.isArray(state.openChallenges))
		throw new AnsteelTeamStateError("Ansteel team state has invalid challenges");
	for (const challenge of state.openChallenges) {
		if (!isRecord(challenge)) throw new AnsteelTeamStateError("Ansteel team state has invalid challenge entries");
		assertChallengeId(challenge.id, "challenge");
		assertRole(challenge.raisedBy, "challenge author");
		assertRole(challenge.targetRole, "challenge target");
		if (challenge.raisedBy === challenge.targetRole) {
			throw new AnsteelTeamStateError("Ansteel team challenges cannot target their author");
		}
		if (challenge.status !== "open" && challenge.status !== "resolved") {
			throw new AnsteelTeamStateError("Ansteel team challenge has an invalid status");
		}
	}
	if (!Array.isArray(state.tasks)) throw new AnsteelTeamStateError("Ansteel team state has invalid tasks");
	const taskIds = new Set<string>();
	for (const task of state.tasks) {
		if (!isRecord(task)) throw new AnsteelTeamStateError("Ansteel team state has invalid task entries");
		assertTaskId(task.id);
		if (taskIds.has(task.id)) throw new AnsteelTeamStateError(`Ansteel team task ${task.id} is duplicated`);
		taskIds.add(task.id);
		assertRole(task.owner, "task owner");
		if (
			!Array.isArray(task.files) ||
			task.files.length === 0 ||
			task.files.some((file) => typeof file !== "string")
		) {
			throw new AnsteelTeamStateError(`Ansteel team task ${task.id} requires exact file paths`);
		}
		if (typeof task.description !== "string" || task.description.trim().length === 0) {
			throw new AnsteelTeamStateError(`Ansteel team task ${task.id} requires a description`);
		}
		if (typeof task.acceptanceCriteria !== "string" || task.acceptanceCriteria.trim().length === 0) {
			throw new AnsteelTeamStateError(`Ansteel team task ${task.id} requires acceptance criteria`);
		}
		if (
			task.status !== "claimed" &&
			task.status !== "submitted" &&
			task.status !== "revision-required" &&
			task.status !== "approved"
		) {
			throw new AnsteelTeamStateError(`Ansteel team task ${task.id} has an invalid status`);
		}
		if (!Number.isSafeInteger(task.revision) || task.revision < 0) {
			throw new AnsteelTeamStateError(`Ansteel team task ${task.id} has an invalid revision`);
		}
		if (!Array.isArray(task.testEvidence)) {
			throw new AnsteelTeamStateError(`Ansteel team task ${task.id} has invalid test evidence`);
		}
		for (const test of task.testEvidence) {
			if (!isRecord(test) || typeof test.command !== "string" || typeof test.output !== "string") {
				throw new AnsteelTeamStateError(`Ansteel team task ${task.id} has invalid test evidence`);
			}
			if (typeof test.isError !== "boolean" || typeof test.completedAt !== "string") {
				throw new AnsteelTeamStateError(`Ansteel team task ${task.id} has invalid test evidence`);
			}
		}
		if (!Array.isArray(task.submissions)) {
			throw new AnsteelTeamStateError(`Ansteel team task ${task.id} has invalid submissions`);
		}
		for (const submission of task.submissions) {
			if (
				!isRecord(submission) ||
				!Number.isSafeInteger(submission.revision) ||
				submission.revision < 1 ||
				typeof submission.submittedAt !== "string" ||
				typeof submission.diff !== "string" ||
				!isRecord(submission.test)
			) {
				throw new AnsteelTeamStateError(`Ansteel team task ${task.id} has invalid submissions`);
			}
		}
		if (!Array.isArray(task.reviews)) {
			throw new AnsteelTeamStateError(`Ansteel team task ${task.id} has invalid reviews`);
		}
		for (const review of task.reviews) {
			if (
				!isRecord(review) ||
				!Number.isSafeInteger(review.revision) ||
				review.revision < 1 ||
				(review.verdict !== "approve" && review.verdict !== "reject") ||
				typeof review.reviewedAt !== "string"
			) {
				throw new AnsteelTeamStateError(`Ansteel team task ${task.id} has invalid reviews`);
			}
			assertRole(review.reviewer, "task reviewer");
			if (review.reviewer === task.owner) {
				throw new AnsteelTeamStateError(`Ansteel team task ${task.id} owner cannot review its own change`);
			}
			if (review.verdict === "reject" && (typeof review.issue !== "string" || review.issue.trim().length === 0)) {
				throw new AnsteelTeamStateError(`Ansteel team task ${task.id} rejection requires an issue`);
			}
		}
	}
}

export function createAnsteelTeamState(options: CreateAnsteelTeamStateOptions): AnsteelTeamState {
	const cwd = assertProjectDirectory(options.cwd);
	if (typeof options.topic !== "string" || options.topic.trim().length === 0) {
		throw new AnsteelTeamStateError("Ansteel team requires a topic");
	}
	assertRoleModels(options.roleModels);
	const now = options.now ?? new Date();
	const timestamp = now.toISOString();
	const state: AnsteelTeamState = {
		version: ANSTEEL_TEAM_STATE_VERSION,
		id: createAnsteelTeamId(now),
		topic: options.topic.trim(),
		status: "active",
		createdAt: timestamp,
		updatedAt: timestamp,
		nextEventSequence: 1,
		roles: Object.fromEntries(
			ANSTEEL_ROLES.map((role) => [
				role,
				{ model: options.roleModels[role], sessionFile: getAnsteelTeamRoleSessionPath(cwd, role), status: "idle" },
			]),
		) as Record<AnsteelRole, AnsteelTeamRoleState>,
		openChallenges: [],
		tasks: [],
		ledgerHeadHash: null,
	};
	assertState(state);
	return state;
}

function normalizeTaskFilePath(cwd: string, file: unknown): string {
	if (typeof file !== "string" || file.trim().length === 0 || isAbsolute(file)) {
		throw new AnsteelTeamStateError("Ansteel team task files must use non-empty project-relative paths");
	}
	const relativePath = getCwdRelativePath(resolvePath(file, cwd), cwd);
	if (relativePath === undefined || relativePath === ".") {
		throw new AnsteelTeamStateError("Ansteel team task files must stay inside the project");
	}
	const normalizedPath = relativePath.replace(/\\/g, "/");
	if (normalizedPath === ".pi" || normalizedPath.startsWith(".pi/")) {
		throw new AnsteelTeamStateError("Ansteel team task files cannot modify team governance state");
	}
	return normalizedPath;
}

function isTaskStillActive(task: AnsteelTeamTask): boolean {
	return task.status !== "approved";
}

export function getAnsteelTeamWriteBlockReason(
	cwd: string,
	state: AnsteelTeamState,
	role: AnsteelRole,
	file: string,
): string | undefined {
	const projectDirectory = assertProjectDirectory(cwd);
	assertState(state);
	assertRole(role, "write role");
	let normalizedFile: string;
	try {
		normalizedFile = normalizeTaskFilePath(projectDirectory, file);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	const task = state.tasks.find((item) => item.files.includes(normalizedFile));
	if (!task) {
		return `Ansteel team writes to ${normalizedFile} must be claimed before code can be modified`;
	}
	if (task.owner !== role) {
		return `Ansteel team writes to ${normalizedFile} must be claimed by ${role}; it belongs to ${task.owner} via ${task.id}`;
	}
	if (task.status !== "claimed" && task.status !== "revision-required") {
		return `Ansteel team task ${task.id} is ${task.status}; code is frozen until peer review returns it for revision`;
	}
	return undefined;
}

export function isAnsteelTeamGovernancePath(cwd: string, file: unknown): boolean {
	if (typeof file !== "string" || file.trim().length === 0) return false;
	const teamDirectory = getAnsteelTeamDirectory(cwd);
	const resolvedFile = resolvePath(file, cwd);
	return resolvedFile === teamDirectory || getCwdRelativePath(resolvedFile, teamDirectory) !== undefined;
}

export function claimAnsteelTeamTask(
	cwd: string,
	state: AnsteelTeamState,
	input: ClaimAnsteelTeamTaskInput,
): AnsteelTeamTask {
	const projectDirectory = assertProjectDirectory(cwd);
	assertState(state);
	assertTaskId(input.id);
	assertRole(input.owner, "task owner");
	if (!Array.isArray(input.files) || input.files.length === 0) {
		throw new AnsteelTeamStateError("Ansteel team task requires one or more exact file paths");
	}
	if (typeof input.description !== "string" || input.description.trim().length === 0) {
		throw new AnsteelTeamStateError("Ansteel team task requires a description");
	}
	if (typeof input.acceptanceCriteria !== "string" || input.acceptanceCriteria.trim().length === 0) {
		throw new AnsteelTeamStateError("Ansteel team task requires acceptance criteria");
	}
	if (state.tasks.some((task) => task.id === input.id)) {
		throw new AnsteelTeamStateError(`Ansteel team task ${input.id} already exists`);
	}
	const files = [...new Set(input.files.map((file) => normalizeTaskFilePath(projectDirectory, file)))];
	if (files.length !== input.files.length) {
		throw new AnsteelTeamStateError("Ansteel team task cannot claim the same file more than once");
	}
	for (const file of files) {
		const conflictingTask = state.tasks.find((task) => isTaskStillActive(task) && task.files.includes(file));
		if (conflictingTask) {
			throw new AnsteelTeamStateError(`Ansteel team file ${file} is already claimed by ${conflictingTask.id}`);
		}
	}
	const task: AnsteelTeamTask = {
		id: input.id,
		owner: input.owner,
		files,
		description: input.description.trim(),
		acceptanceCriteria: input.acceptanceCriteria.trim(),
		status: "claimed",
		revision: 0,
		testEvidence: [],
		submissions: [],
		reviews: [],
	};
	state.tasks.push(task);
	saveAnsteelTeamState(projectDirectory, state);
	return task;
}

function getTaskForOwner(state: AnsteelTeamState, role: AnsteelRole, taskId: string): AnsteelTeamTask {
	assertRole(role, "task role");
	assertTaskId(taskId);
	const task = state.tasks.find((item) => item.id === taskId);
	if (!task) throw new AnsteelTeamStateError(`Ansteel team task ${taskId} does not exist`);
	if (task.owner !== role) throw new AnsteelTeamStateError(`Ansteel team task ${taskId} belongs to ${task.owner}`);
	return task;
}

function assertTaskCanBeChanged(task: AnsteelTeamTask): void {
	if (task.status !== "claimed" && task.status !== "revision-required") {
		throw new AnsteelTeamStateError(`Ansteel team task ${task.id} is ${task.status}; it cannot be changed`);
	}
}

export function recordAnsteelTeamTaskTestResult(
	cwd: string,
	state: AnsteelTeamState,
	role: AnsteelRole,
	taskId: string,
	input: RecordAnsteelTeamTaskTestResultInput,
): AnsteelTeamTaskTestEvidence {
	const projectDirectory = assertProjectDirectory(cwd);
	assertState(state);
	const task = getTaskForOwner(state, role, taskId);
	assertTaskCanBeChanged(task);
	if (typeof input.command !== "string" || input.command.trim().length === 0) {
		throw new AnsteelTeamStateError("Ansteel team test evidence requires a command");
	}
	if (typeof input.output !== "string" || typeof input.isError !== "boolean") {
		throw new AnsteelTeamStateError("Ansteel team test evidence requires output and an error status");
	}
	const evidence: AnsteelTeamTaskTestEvidence = {
		command: input.command.trim(),
		output: input.output.slice(0, MAX_PUBLIC_EVENT_CONTENT_LENGTH),
		isError: input.isError,
		completedAt: new Date().toISOString(),
	};
	task.testEvidence.push(evidence);
	saveAnsteelTeamState(projectDirectory, state);
	return evidence;
}

function assertAllowedTaskTestCommand(command: string): string {
	const normalizedCommand = command.trim();
	if (normalizedCommand.length === 0 || normalizedCommand.length > 1_024) {
		throw new AnsteelTeamStateError("Ansteel team task tests require a bounded command");
	}
	if (/[\r\n;&|><`$()]/.test(normalizedCommand) || !ANSTEEL_TEAM_TEST_COMMAND_PREFIX.test(normalizedCommand)) {
		throw new AnsteelTeamStateError(
			"Ansteel team task tests only allow a single supported test, check, lint, or typecheck command",
		);
	}
	return normalizedCommand;
}

export function runAnsteelTeamTaskTest(
	cwd: string,
	state: AnsteelTeamState,
	role: AnsteelRole,
	taskId: string,
	command: string,
): AnsteelTeamTaskTestEvidence {
	const projectDirectory = assertProjectDirectory(cwd);
	assertState(state);
	const task = getTaskForOwner(state, role, taskId);
	assertTaskCanBeChanged(task);
	if (typeof command !== "string") {
		throw new AnsteelTeamStateError("Ansteel team task tests require a command");
	}
	const normalizedCommand = assertAllowedTaskTestCommand(command);
	const result = spawnSync(normalizedCommand, {
		cwd: projectDirectory,
		encoding: "utf8",
		shell: true,
		timeout: ANSTEEL_TEAM_TEST_TIMEOUT_MS,
		maxBuffer: 4 * 1024 * 1024,
		windowsHide: true,
	});
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}${result.error ? `\n${result.error.message}` : ""}`;
	return recordAnsteelTeamTaskTestResult(projectDirectory, state, role, taskId, {
		command: normalizedCommand,
		output,
		isError: result.status !== 0 || result.error !== undefined,
	});
}

function runGit(cwd: string, args: string[], allowedExitCodes: readonly number[]): string {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		maxBuffer: 4 * 1024 * 1024,
		windowsHide: true,
	});
	if (result.error || result.status === null || !allowedExitCodes.includes(result.status)) {
		const reason = result.error?.message ?? result.stderr?.trim() ?? "unknown git failure";
		throw new AnsteelTeamStateError(`Ansteel team could not capture the task diff: ${reason}`);
	}
	return result.stdout;
}

function captureTaskDiff(cwd: string, task: AnsteelTeamTask): string {
	const repository = runGit(cwd, ["rev-parse", "--is-inside-work-tree"], [0]).trim();
	if (repository !== "true") {
		throw new AnsteelTeamStateError("Ansteel team task submission requires a Git worktree");
	}
	const trackedDiff = runGit(cwd, ["diff", "--no-ext-diff", "--binary", "HEAD", "--", ...task.files], [0]);
	const untrackedFiles = runGit(cwd, ["ls-files", "--others", "--exclude-standard", "--", ...task.files], [0])
		.split("\n")
		.map((file) => file.trim())
		.filter((file) => file.length > 0);
	const untrackedDiffs = untrackedFiles.map((file) =>
		runGit(cwd, ["diff", "--no-index", "--binary", "--", "/dev/null", file], [0, 1]),
	);
	const diff = [trackedDiff, ...untrackedDiffs].filter((entry) => entry.length > 0).join("\n");
	if (diff.trim().length === 0) {
		throw new AnsteelTeamStateError(`Ansteel team task ${task.id} has no Git diff for its claimed files`);
	}
	return diff;
}

export function submitAnsteelTeamTask(
	cwd: string,
	state: AnsteelTeamState,
	role: AnsteelRole,
	taskId: string,
	testCommand: string,
): AnsteelTeamTaskSubmission {
	const projectDirectory = assertProjectDirectory(cwd);
	assertState(state);
	const task = getTaskForOwner(state, role, taskId);
	assertTaskCanBeChanged(task);
	if (typeof testCommand !== "string" || testCommand.trim().length === 0) {
		throw new AnsteelTeamStateError("Ansteel team task submission requires the exact test command");
	}
	const test = [...task.testEvidence]
		.reverse()
		.find((evidence) => evidence.command === testCommand.trim() && !evidence.isError);
	if (!test) {
		throw new AnsteelTeamStateError(
			`Ansteel team task ${task.id} requires a successful recorded result for ${testCommand.trim()}`,
		);
	}
	const submission: AnsteelTeamTaskSubmission = {
		revision: task.revision + 1,
		submittedAt: new Date().toISOString(),
		diff: captureTaskDiff(projectDirectory, task),
		test: { ...test },
	};
	task.revision = submission.revision;
	task.submissions.push(submission);
	task.status = "submitted";
	saveAnsteelTeamState(projectDirectory, state);
	return submission;
}

export function reviewAnsteelTeamTask(
	cwd: string,
	state: AnsteelTeamState,
	reviewer: AnsteelRole,
	taskId: string,
	input: ReviewAnsteelTeamTaskInput,
): AnsteelTeamTaskReview {
	const projectDirectory = assertProjectDirectory(cwd);
	assertState(state);
	assertRole(reviewer, "task reviewer");
	assertTaskId(taskId);
	const task = state.tasks.find((item) => item.id === taskId);
	if (!task) throw new AnsteelTeamStateError(`Ansteel team task ${taskId} does not exist`);
	if (task.owner === reviewer)
		throw new AnsteelTeamStateError(`Ansteel team task ${taskId} owner cannot review its own change`);
	if (task.status !== "submitted" && task.status !== "revision-required") {
		throw new AnsteelTeamStateError(`Ansteel team task ${taskId} has no submitted change to review`);
	}
	if (input.verdict !== "approve" && input.verdict !== "reject") {
		throw new AnsteelTeamStateError("Ansteel team task review requires approve or reject");
	}
	if (input.verdict === "reject" && (typeof input.issue !== "string" || input.issue.trim().length === 0)) {
		throw new AnsteelTeamStateError("Ansteel team task rejection requires an issue");
	}
	const submission = task.submissions.at(-1);
	if (!submission || submission.revision !== task.revision) {
		throw new AnsteelTeamStateError(`Ansteel team task ${taskId} has no immutable evidence package to review`);
	}
	if (task.reviews.some((review) => review.revision === submission.revision && review.reviewer === reviewer)) {
		throw new AnsteelTeamStateError(
			`Ansteel team task ${taskId} already has a ${reviewer} review for revision ${submission.revision}`,
		);
	}
	const review: AnsteelTeamTaskReview = {
		revision: submission.revision,
		reviewer,
		verdict: input.verdict,
		...(input.verdict === "reject" ? { issue: input.issue!.trim() } : {}),
		reviewedAt: new Date().toISOString(),
	};
	task.reviews.push(review);
	if (review.verdict === "reject") {
		task.status = "revision-required";
		task.testEvidence = [];
	} else {
		const peerReviews = task.reviews.filter((item) => item.revision === submission.revision);
		const peerRoles = ANSTEEL_ROLES.filter((role) => role !== task.owner);
		if (peerRoles.every((role) => peerReviews.some((item) => item.reviewer === role && item.verdict === "approve"))) {
			task.status = "approved";
		}
	}
	saveAnsteelTeamState(projectDirectory, state);
	return review;
}

function writeAnsteelTeamState(path: string, state: AnsteelTeamState): void {
	const directory = getAnsteelTeamDirectoryFromStatePath(path);
	mkdirSync(directory, { recursive: true });
	const temporaryPath = `${path}.${process.pid}.tmp`;
	writeFileSync(temporaryPath, `${JSON.stringify(state, null, "\t")}\n`, "utf8");
	renameSync(temporaryPath, path);
}

function getAnsteelTeamDirectoryFromStatePath(path: string): string {
	return resolvePath(join(path, ".."));
}

export function saveAnsteelTeamState(cwd: string, state: AnsteelTeamState): void {
	assertProjectDirectory(cwd);
	assertState(state);
	assertAnsteelTeamEventLedger(cwd, state);
	writeAnsteelTeamState(getAnsteelTeamStatePath(cwd), state);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function migrateAnsteelTeamState(value: unknown): unknown {
	if (!isRecord(value)) return value;
	const taskState = value.version === 1 && !("tasks" in value) ? { ...value, version: 2, tasks: [] } : value;
	if (taskState.version !== 2) return taskState;
	return { ...taskState, version: ANSTEEL_TEAM_STATE_VERSION, ledgerHeadHash: null };
}

function parseAnsteelTeamState(value: unknown): AnsteelTeamState {
	const migratedValue = migrateAnsteelTeamState(value);
	if (!isRecord(migratedValue)) throw new AnsteelTeamStateError("Ansteel team state must be a JSON object");
	const state = migratedValue as unknown as AnsteelTeamState;
	assertState(state);
	return state;
}

function isLegacyAnsteelTeamState(value: unknown): boolean {
	return isRecord(value) && (value.version === 1 || value.version === 2);
}

function writeAnsteelTeamEventLedger(cwd: string, events: readonly AnsteelTeamEvent[]): void {
	const path = getAnsteelTeamEventPath(cwd);
	mkdirSync(getAnsteelTeamDirectory(cwd), { recursive: true });
	const temporaryPath = `${path}.${process.pid}.tmp`;
	writeFileSync(
		temporaryPath,
		`${events.map((event) => JSON.stringify(event)).join("\n")}${events.length === 0 ? "" : "\n"}`,
		"utf8",
	);
	renameSync(temporaryPath, path);
}

function migrateLegacyAnsteelTeamEventLedger(cwd: string, state: AnsteelTeamState): void {
	const rawEvents = readAnsteelTeamEventLedger(cwd);
	const hashFieldPresence = rawEvents.map(
		(event) => isRecord(event) && (Object.hasOwn(event, "previousHash") || Object.hasOwn(event, "hash")),
	);
	if (hashFieldPresence.some(Boolean)) {
		if (hashFieldPresence.every(Boolean)) {
			throw new AnsteelTeamStateError("Ansteel team legacy state cannot be migrated from a hashed event ledger");
		}
		throw new AnsteelTeamStateError("Ansteel team event ledger has mixed legacy and hashed events");
	}

	const events: AnsteelTeamEvent[] = [];
	let previousHash: string | null = null;
	for (let index = 0; index < rawEvents.length; index++) {
		const legacyEvent = parseAnsteelTeamEventFields(rawEvents[index]);
		if (legacyEvent.sequence !== index + 1) {
			throw new AnsteelTeamStateError("Ansteel team event ledger has a non-contiguous sequence");
		}
		const unsignedEvent = { ...legacyEvent, previousHash };
		const event: AnsteelTeamEvent = { ...unsignedEvent, hash: hashAnsteelTeamEvent(unsignedEvent) };
		events.push(event);
		previousHash = event.hash;
	}
	if (state.nextEventSequence !== events.length + 1) {
		throw new AnsteelTeamStateError("Ansteel team next event sequence does not match the event ledger");
	}
	state.ledgerHeadHash = previousHash;
	writeAnsteelTeamEventLedger(cwd, events);
	writeAnsteelTeamState(getAnsteelTeamStatePath(cwd), state);
}

export function loadAnsteelTeamState(cwd: string): AnsteelTeamState | undefined {
	const path = getAnsteelTeamStatePath(cwd);
	if (!existsSync(path)) return undefined;
	try {
		const rawState = JSON.parse(readFileSync(path, "utf8"));
		const state = parseAnsteelTeamState(rawState);
		if (isLegacyAnsteelTeamState(rawState)) {
			migrateLegacyAnsteelTeamEventLedger(cwd, state);
		}
		assertAnsteelTeamEventLedger(cwd, state);
		return state;
	} catch (error) {
		if (error instanceof AnsteelTeamStateError) throw error;
		throw new AnsteelTeamStateError(
			`Ansteel team state could not be read: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function parseAnsteelTeamEventFields(value: unknown): Omit<AnsteelTeamEvent, "previousHash" | "hash"> {
	if (!isRecord(value)) throw new AnsteelTeamStateError("Ansteel team event must be a JSON object");
	const event = value as unknown as AnsteelTeamEvent;
	if (!Number.isSafeInteger(event.sequence) || event.sequence < 1) {
		throw new AnsteelTeamStateError("Ansteel team event has an invalid sequence");
	}
	if (
		event.type !== "role-report" &&
		event.type !== "challenge" &&
		event.type !== "resolution" &&
		event.type !== "role-failure" &&
		event.type !== "task-claimed" &&
		event.type !== "task-submitted" &&
		event.type !== "task-review"
	) {
		throw new AnsteelTeamStateError("Ansteel team event has an invalid type");
	}
	assertRole(event.role, "event role");
	assertPublicContent(event.content);
	if (typeof event.createdAt !== "string" || Number.isNaN(Date.parse(event.createdAt))) {
		throw new AnsteelTeamStateError("Ansteel team event has an invalid timestamp");
	}
	if (event.type === "challenge") {
		assertRole(event.targetRole, "challenge target");
		if (event.targetRole === event.role)
			throw new AnsteelTeamStateError("Ansteel team challenges cannot target their author");
		assertChallengeId(event.challengeId, "challenge");
	}
	if (event.type === "resolution") assertChallengeId(event.challengeId, "resolution");
	return {
		sequence: event.sequence,
		type: event.type,
		role: event.role,
		...(event.targetRole === undefined ? {} : { targetRole: event.targetRole }),
		...(event.challengeId === undefined ? {} : { challengeId: event.challengeId }),
		content: event.content,
		createdAt: event.createdAt,
	};
}

function parseAnsteelTeamEvent(value: unknown): AnsteelTeamEvent {
	const fields = parseAnsteelTeamEventFields(value);
	if (!isRecord(value)) throw new AnsteelTeamStateError("Ansteel team event must be a JSON object");
	const previousHash = value.previousHash;
	const hash = value.hash;
	assertLedgerHash(previousHash, "event previous hash", true);
	assertLedgerHash(hash, "event hash", false);
	return { ...fields, previousHash, hash };
}

function hashAnsteelTeamEvent(event: Omit<AnsteelTeamEvent, "hash">): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				sequence: event.sequence,
				type: event.type,
				role: event.role,
				targetRole: event.targetRole ?? null,
				challengeId: event.challengeId ?? null,
				content: event.content,
				createdAt: event.createdAt,
				previousHash: event.previousHash,
			}),
			"utf8",
		)
		.digest("hex");
}

function readAnsteelTeamEventLedger(cwd: string): unknown[] {
	const path = getAnsteelTeamEventPath(cwd);
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => {
			try {
				return JSON.parse(line);
			} catch (error) {
				if (error instanceof AnsteelTeamStateError) throw error;
				throw new AnsteelTeamStateError(
					`Ansteel team event ledger could not be read: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		});
}

export function listAnsteelTeamEvents(cwd: string): AnsteelTeamEvent[] {
	const events = readAnsteelTeamEventLedger(cwd).map((event) => parseAnsteelTeamEvent(event));
	let previousHash: string | null = null;
	for (let index = 0; index < events.length; index++) {
		if (events[index].sequence !== index + 1) {
			throw new AnsteelTeamStateError("Ansteel team event ledger has a non-contiguous sequence");
		}
		if (events[index].previousHash !== previousHash) {
			throw new AnsteelTeamStateError("Ansteel team event ledger has an invalid previous hash");
		}
		if (events[index].hash !== hashAnsteelTeamEvent(events[index])) {
			throw new AnsteelTeamStateError("Ansteel team event ledger has a hash mismatch");
		}
		previousHash = events[index].hash;
	}
	return events;
}

function assertAnsteelTeamEventLedger(cwd: string, state: AnsteelTeamState): void {
	const events = listAnsteelTeamEvents(cwd);
	const ledgerHeadHash = events.at(-1)?.hash ?? null;
	if (state.ledgerHeadHash !== ledgerHeadHash) {
		throw new AnsteelTeamStateError("Ansteel team ledger head hash does not match the event chain");
	}
	if (state.nextEventSequence !== events.length + 1) {
		throw new AnsteelTeamStateError("Ansteel team next event sequence does not match the event ledger");
	}
}

function applyAnsteelTeamEvent(state: AnsteelTeamState, event: AnsteelTeamEvent): void {
	if (event.type === "challenge") {
		if (state.openChallenges.some((challenge) => challenge.id === event.challengeId)) {
			throw new AnsteelTeamStateError(`Ansteel team challenge ${event.challengeId} already exists`);
		}
		state.openChallenges.push({
			id: event.challengeId!,
			raisedBy: event.role,
			targetRole: event.targetRole!,
			status: "open",
		});
	}
	if (event.type === "resolution") {
		const challenge = state.openChallenges.find((item) => item.id === event.challengeId && item.status === "open");
		if (!challenge) throw new AnsteelTeamStateError(`Ansteel team has no open challenge ${event.challengeId}`);
		if (challenge.targetRole !== event.role) {
			throw new AnsteelTeamStateError(
				`Ansteel team challenge ${event.challengeId} must be resolved by ${challenge.targetRole}`,
			);
		}
		challenge.status = "resolved";
	}
}

export function appendAnsteelTeamEvent(
	cwd: string,
	state: AnsteelTeamState,
	input: AnsteelTeamEventInput,
): AnsteelTeamEvent {
	assertProjectDirectory(cwd);
	assertState(state);
	assertAnsteelTeamEventLedger(cwd, state);
	const unsignedEvent = {
		...input,
		sequence: state.nextEventSequence,
		createdAt: new Date().toISOString(),
		previousHash: state.ledgerHeadHash,
	};
	const event = parseAnsteelTeamEvent({
		...unsignedEvent,
		hash: hashAnsteelTeamEvent(unsignedEvent),
	});
	applyAnsteelTeamEvent(state, event);
	mkdirSync(getAnsteelTeamDirectory(cwd), { recursive: true });
	appendFileSync(getAnsteelTeamEventPath(cwd), `${JSON.stringify(event)}\n`, "utf8");
	state.nextEventSequence = event.sequence + 1;
	state.ledgerHeadHash = event.hash;
	state.updatedAt = event.createdAt;
	saveAnsteelTeamState(cwd, state);
	return event;
}
