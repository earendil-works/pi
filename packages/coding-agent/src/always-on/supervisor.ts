import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, type FSWatcher, mkdirSync, readFileSync, watch } from "node:fs";
import { dirname, join, resolve } from "node:path";

import * as notification from "../notification.js";
import { SessionManager } from "../session-manager.js";

import {
	type AlwaysOnAgentConfig,
	type AlwaysOnThinkingLevel,
	createAlwaysOnAgentRegistry,
	getAlwaysOnBaseDir,
} from "./agent-registry.js";

export interface AlwaysOnExecutionTarget {
	provider: string;
	modelId: string;
	thinkingLevel: AlwaysOnThinkingLevel;
}

export type AlwaysOnSchedule = { kind: "once"; at: string } | { kind: "recurring"; cron: string; timezone?: string };

export interface AlwaysOnWorkItem {
	workItemId: string;
	agentId: string;
	workspacePath?: string;
	instruction: string;
	executionTarget?: AlwaysOnExecutionTarget;
	relatedWorkItemIds?: string[];
	relatedSessionIds?: string[];
	schedule?: AlwaysOnSchedule;
	createdAt: string;
	disabledAt?: string;
}

export type AlwaysOnRunOutcome = "completed" | "blocked" | "needs_user" | "error" | "abandoned";

export interface AlwaysOnRun {
	runId: string;
	workItemId: string;
	agentId: string;
	trigger: "manual" | "schedule";
	scheduledOccurrenceKey?: string;
	provider: string;
	modelId: string;
	thinkingLevel: AlwaysOnThinkingLevel;
	sessionId: string;
	startedAt: string;
	finishedAt?: string;
	outcome?: AlwaysOnRunOutcome;
	errorMessage?: string;
}

export interface AlwaysOnSupervisorNotification {
	title: string;
	message: string;
	workItemId: string;
	runId: string;
	sessionId: string;
	outcome: AlwaysOnRunOutcome;
}

interface WorkItemCreatedFact {
	type: "work_item_created";
	workItemId: string;
	agentId: string;
	workspacePath?: string;
	instruction: string;
	executionTarget?: AlwaysOnExecutionTarget;
	relatedWorkItemIds?: string[];
	relatedSessionIds?: string[];
	schedule?: AlwaysOnSchedule;
	timestamp: string;
}

interface WorkItemDisabledFact {
	type: "work_item_disabled";
	workItemId: string;
	timestamp: string;
}

type AlwaysOnWorkItemFact = WorkItemCreatedFact | WorkItemDisabledFact;

interface RunStartedFact {
	type: "run_started";
	runId: string;
	workItemId: string;
	agentId: string;
	trigger: "manual" | "schedule";
	scheduledOccurrenceKey?: string;
	provider: string;
	modelId: string;
	thinkingLevel: AlwaysOnThinkingLevel;
	sessionId: string;
	timestamp: string;
}

interface RunFinishedFact {
	type: "run_finished";
	runId: string;
	outcome: AlwaysOnRunOutcome;
	errorMessage?: string;
	timestamp: string;
}

type AlwaysOnRunFact = RunStartedFact | RunFinishedFact;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function requireNonEmptyString(
	record: Record<string, unknown>,
	key: string,
	lineNumber: number,
	fileName: string,
): string {
	const value = record[key];
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`Invalid ${fileName} fact on line ${lineNumber}: missing ${key}`);
	}
	return value;
}

function parseOptionalStringArray(
	value: unknown,
	key: string,
	lineNumber: number,
	fileName: string,
): string[] | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
		throw new Error(`Invalid ${fileName} fact on line ${lineNumber}: ${key} must be a string[]`);
	}
	return value;
}

function asThinkingLevel(value: string, lineNumber: number, fileName: string): AlwaysOnThinkingLevel {
	if (
		value === "off" ||
		value === "minimal" ||
		value === "low" ||
		value === "medium" ||
		value === "high" ||
		value === "xhigh"
	) {
		return value;
	}
	throw new Error(`Invalid ${fileName} fact on line ${lineNumber}: invalid thinkingLevel`);
}

function parseOptionalExecutionTarget(
	value: unknown,
	lineNumber: number,
	fileName: string,
): AlwaysOnExecutionTarget | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!isRecord(value)) {
		throw new Error(`Invalid ${fileName} fact on line ${lineNumber}: executionTarget must be an object`);
	}
	return {
		provider: requireNonEmptyString(value, "provider", lineNumber, fileName),
		modelId: requireNonEmptyString(value, "modelId", lineNumber, fileName),
		thinkingLevel: asThinkingLevel(
			requireNonEmptyString(value, "thinkingLevel", lineNumber, fileName),
			lineNumber,
			fileName,
		),
	};
}

function parseOptionalSchedule(value: unknown, lineNumber: number, fileName: string): AlwaysOnSchedule | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!isRecord(value)) {
		throw new Error(`Invalid ${fileName} fact on line ${lineNumber}: schedule must be an object`);
	}
	const kind = requireNonEmptyString(value, "kind", lineNumber, fileName);
	if (kind === "once") {
		return {
			kind,
			at: requireNonEmptyString(value, "at", lineNumber, fileName),
		};
	}
	if (kind === "recurring") {
		return {
			kind,
			cron: requireNonEmptyString(value, "cron", lineNumber, fileName),
			timezone: typeof value.timezone === "string" && value.timezone.trim().length > 0 ? value.timezone : undefined,
		};
	}
	throw new Error(`Invalid ${fileName} fact on line ${lineNumber}: unsupported schedule kind ${kind}`);
}

function parseWorkItemFact(line: string, lineNumber: number): AlwaysOnWorkItemFact {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Invalid work-items.jsonl fact on line ${lineNumber}: ${message}`);
	}
	if (!isRecord(parsed)) {
		throw new Error(`Invalid work-items.jsonl fact on line ${lineNumber}: expected an object`);
	}
	const type = requireNonEmptyString(parsed, "type", lineNumber, "work-items.jsonl");
	if (type === "work_item_created") {
		return {
			type,
			workItemId: requireNonEmptyString(parsed, "workItemId", lineNumber, "work-items.jsonl"),
			agentId: requireNonEmptyString(parsed, "agentId", lineNumber, "work-items.jsonl"),
			workspacePath:
				typeof parsed.workspacePath === "string" && parsed.workspacePath.trim().length > 0
					? parsed.workspacePath
					: undefined,
			instruction: requireNonEmptyString(parsed, "instruction", lineNumber, "work-items.jsonl"),
			executionTarget: parseOptionalExecutionTarget(parsed.executionTarget, lineNumber, "work-items.jsonl"),
			relatedWorkItemIds: parseOptionalStringArray(
				parsed.relatedWorkItemIds,
				"relatedWorkItemIds",
				lineNumber,
				"work-items.jsonl",
			),
			relatedSessionIds: parseOptionalStringArray(
				parsed.relatedSessionIds,
				"relatedSessionIds",
				lineNumber,
				"work-items.jsonl",
			),
			schedule: parseOptionalSchedule(parsed.schedule, lineNumber, "work-items.jsonl"),
			timestamp: requireNonEmptyString(parsed, "timestamp", lineNumber, "work-items.jsonl"),
		};
	}
	if (type === "work_item_disabled") {
		return {
			type,
			workItemId: requireNonEmptyString(parsed, "workItemId", lineNumber, "work-items.jsonl"),
			timestamp: requireNonEmptyString(parsed, "timestamp", lineNumber, "work-items.jsonl"),
		};
	}
	throw new Error(`Invalid work-items.jsonl fact on line ${lineNumber}: unsupported type ${type}`);
}

function parseRunFact(line: string, lineNumber: number): AlwaysOnRunFact {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Invalid runs.jsonl fact on line ${lineNumber}: ${message}`);
	}
	if (!isRecord(parsed)) {
		throw new Error(`Invalid runs.jsonl fact on line ${lineNumber}: expected an object`);
	}
	const type = requireNonEmptyString(parsed, "type", lineNumber, "runs.jsonl");
	if (type === "run_started") {
		return {
			type,
			runId: requireNonEmptyString(parsed, "runId", lineNumber, "runs.jsonl"),
			workItemId: requireNonEmptyString(parsed, "workItemId", lineNumber, "runs.jsonl"),
			agentId: requireNonEmptyString(parsed, "agentId", lineNumber, "runs.jsonl"),
			trigger: requireNonEmptyString(parsed, "trigger", lineNumber, "runs.jsonl") as "manual" | "schedule",
			scheduledOccurrenceKey:
				typeof parsed.scheduledOccurrenceKey === "string" && parsed.scheduledOccurrenceKey.trim().length > 0
					? parsed.scheduledOccurrenceKey
					: undefined,
			provider: requireNonEmptyString(parsed, "provider", lineNumber, "runs.jsonl"),
			modelId: requireNonEmptyString(parsed, "modelId", lineNumber, "runs.jsonl"),
			thinkingLevel: asThinkingLevel(
				requireNonEmptyString(parsed, "thinkingLevel", lineNumber, "runs.jsonl"),
				lineNumber,
				"runs.jsonl",
			),
			sessionId: requireNonEmptyString(parsed, "sessionId", lineNumber, "runs.jsonl"),
			timestamp: requireNonEmptyString(parsed, "timestamp", lineNumber, "runs.jsonl"),
		};
	}
	if (type === "run_finished") {
		return {
			type,
			runId: requireNonEmptyString(parsed, "runId", lineNumber, "runs.jsonl"),
			outcome: requireNonEmptyString(parsed, "outcome", lineNumber, "runs.jsonl") as AlwaysOnRunOutcome,
			errorMessage:
				typeof parsed.errorMessage === "string" && parsed.errorMessage.trim().length > 0
					? parsed.errorMessage
					: undefined,
			timestamp: requireNonEmptyString(parsed, "timestamp", lineNumber, "runs.jsonl"),
		};
	}
	throw new Error(`Invalid runs.jsonl fact on line ${lineNumber}: unsupported type ${type}`);
}

export function getAlwaysOnWorkItemsLedgerPath(baseDir?: string): string {
	return join(getAlwaysOnBaseDir(baseDir), "always-on", "work-items.jsonl");
}

export function getAlwaysOnRunsLedgerPath(baseDir?: string): string {
	return join(getAlwaysOnBaseDir(baseDir), "always-on", "runs.jsonl");
}

function appendFact(path: string, fact: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, `${JSON.stringify(fact)}\n`, "utf8");
}

export function readAlwaysOnWorkItemFacts(baseDir?: string): AlwaysOnWorkItemFact[] {
	const ledgerPath = getAlwaysOnWorkItemsLedgerPath(baseDir);
	if (!existsSync(ledgerPath)) {
		return [];
	}
	const trimmed = readFileSync(ledgerPath, "utf8").trim();
	if (trimmed.length === 0) {
		return [];
	}
	return trimmed.split("\n").map((line, index) => parseWorkItemFact(line, index + 1));
}

export function readAlwaysOnRunFacts(baseDir?: string): AlwaysOnRunFact[] {
	const ledgerPath = getAlwaysOnRunsLedgerPath(baseDir);
	if (!existsSync(ledgerPath)) {
		return [];
	}
	const trimmed = readFileSync(ledgerPath, "utf8").trim();
	if (trimmed.length === 0) {
		return [];
	}
	return trimmed.split("\n").map((line, index) => parseRunFact(line, index + 1));
}

export function deriveAlwaysOnWorkItems(facts: AlwaysOnWorkItemFact[]): AlwaysOnWorkItem[] {
	const workItems = new Map<string, AlwaysOnWorkItem>();
	for (const fact of facts) {
		if (fact.type === "work_item_created") {
			if (workItems.has(fact.workItemId)) {
				throw new Error(`Duplicate always-on work item id: ${fact.workItemId}`);
			}
			workItems.set(fact.workItemId, {
				workItemId: fact.workItemId,
				agentId: fact.agentId,
				workspacePath: fact.workspacePath,
				instruction: fact.instruction,
				executionTarget: fact.executionTarget,
				relatedWorkItemIds: fact.relatedWorkItemIds,
				relatedSessionIds: fact.relatedSessionIds,
				schedule: fact.schedule,
				createdAt: fact.timestamp,
			});
			continue;
		}
		const existing = workItems.get(fact.workItemId);
		if (!existing) {
			throw new Error(`Cannot disable missing always-on work item: ${fact.workItemId}`);
		}
		existing.disabledAt = fact.timestamp;
	}
	return [...workItems.values()];
}

export function deriveAlwaysOnRuns(facts: AlwaysOnRunFact[]): AlwaysOnRun[] {
	const runs = new Map<string, AlwaysOnRun>();
	for (const fact of facts) {
		if (fact.type === "run_started") {
			if (runs.has(fact.runId)) {
				throw new Error(`Duplicate always-on run id: ${fact.runId}`);
			}
			runs.set(fact.runId, {
				runId: fact.runId,
				workItemId: fact.workItemId,
				agentId: fact.agentId,
				trigger: fact.trigger,
				scheduledOccurrenceKey: fact.scheduledOccurrenceKey,
				provider: fact.provider,
				modelId: fact.modelId,
				thinkingLevel: fact.thinkingLevel,
				sessionId: fact.sessionId,
				startedAt: fact.timestamp,
			});
			continue;
		}
		const existing = runs.get(fact.runId);
		if (!existing) {
			throw new Error(`Cannot finish missing always-on run: ${fact.runId}`);
		}
		existing.finishedAt = fact.timestamp;
		existing.outcome = fact.outcome;
		existing.errorMessage = fact.errorMessage;
	}
	return [...runs.values()];
}

function generateId(prefix: string): string {
	return `${prefix}-${randomUUID().slice(0, 8)}`;
}

export interface AlwaysOnSupervisorExecutionRequest {
	agent: AlwaysOnAgentConfig;
	workItem: AlwaysOnWorkItem;
	effectiveTarget: AlwaysOnExecutionTarget;
	tools: Array<{ name: string }>;
}

export interface AlwaysOnSupervisorExecutionResult {
	outcome: AlwaysOnRunOutcome;
	errorMessage?: string;
}

export interface AlwaysOnSupervisorStartedExecution {
	sessionId: string;
	completion: Promise<AlwaysOnSupervisorExecutionResult>;
}

export interface AlwaysOnSupervisorOptions {
	baseDir?: string;
	clock?: () => string;
	onWake?: (reason: string) => void;
	notify?: (notification: AlwaysOnSupervisorNotification) => void;
	resolveTools?: (input: {
		agent: AlwaysOnAgentConfig;
		workItem: AlwaysOnWorkItem;
		effectiveTarget: AlwaysOnExecutionTarget;
	}) => Promise<Array<{ name: string }>> | Array<{ name: string }>;
	executeRun: (request: AlwaysOnSupervisorExecutionRequest) => AlwaysOnSupervisorStartedExecution;
}

function buildEffectiveTarget(agent: AlwaysOnAgentConfig, workItem: AlwaysOnWorkItem): AlwaysOnExecutionTarget {
	return (
		workItem.executionTarget ?? {
			provider: agent.provider,
			modelId: agent.modelId,
			thinkingLevel: agent.thinkingLevel,
		}
	);
}

function readPendingImmediateWorkItems(baseDir: string): AlwaysOnWorkItem[] {
	const workItems = deriveAlwaysOnWorkItems(readAlwaysOnWorkItemFacts(baseDir));
	const runs = deriveAlwaysOnRuns(readAlwaysOnRunFacts(baseDir));
	const startedWorkItemIds = new Set(runs.map((run) => run.workItemId));
	return workItems.filter(
		(workItem) => !workItem.schedule && !workItem.disabledAt && !startedWorkItemIds.has(workItem.workItemId),
	);
}

function normalizeIsoMinute(date: Date): string {
	const normalized = new Date(date.getTime());
	normalized.setUTCSeconds(0, 0);
	return normalized.toISOString();
}

function parseCronMinuteInterval(cron: string): number {
	const parts = cron.trim().split(/\s+/);
	if (parts.length !== 5) {
		throw new Error(`Unsupported cron expression: ${cron}`);
	}
	const [minuteField, hourField, dayOfMonthField, monthField, dayOfWeekField] = parts;
	if (hourField !== "*" || dayOfMonthField !== "*" || monthField !== "*" || dayOfWeekField !== "*") {
		throw new Error(`Unsupported cron expression: ${cron}`);
	}
	if (minuteField === "*") {
		return 1;
	}
	const match = /^\*\/(\d+)$/.exec(minuteField);
	if (!match) {
		throw new Error(`Unsupported cron expression: ${cron}`);
	}
	const interval = Number.parseInt(match[1] ?? "0", 10);
	if (!Number.isFinite(interval) || interval <= 0 || interval > 60) {
		throw new Error(`Unsupported cron expression: ${cron}`);
	}
	return interval;
}

function deriveLatestRecurringOccurrenceKey(
	schedule: Extract<AlwaysOnSchedule, { kind: "recurring" }>,
	nowIso: string,
): string | null {
	if (schedule.timezone && schedule.timezone !== "UTC") {
		throw new Error(`Unsupported timezone: ${schedule.timezone}`);
	}
	const interval = parseCronMinuteInterval(schedule.cron);
	const now = new Date(nowIso);
	if (Number.isNaN(now.getTime())) {
		throw new Error(`Invalid clock timestamp: ${nowIso}`);
	}
	const latest = new Date(now.getTime());
	latest.setUTCSeconds(0, 0);
	latest.setUTCMinutes(Math.floor(latest.getUTCMinutes() / interval) * interval);
	return latest.toISOString();
}

function deriveDueOccurrenceKey(workItem: AlwaysOnWorkItem, nowIso: string): string | null {
	if (!workItem.schedule) {
		return null;
	}
	const createdAt = new Date(workItem.createdAt).getTime();
	if (workItem.schedule.kind === "once") {
		const dueAt = new Date(workItem.schedule.at).getTime();
		const now = new Date(nowIso).getTime();
		if (Number.isNaN(dueAt) || Number.isNaN(now)) {
			throw new Error(`Invalid schedule timestamp for work item ${workItem.workItemId}`);
		}
		if (dueAt < createdAt || dueAt > now) {
			return null;
		}
		return new Date(workItem.schedule.at).toISOString();
	}

	const latestKey = deriveLatestRecurringOccurrenceKey(workItem.schedule, nowIso);
	if (!latestKey) {
		return null;
	}
	if (new Date(latestKey).getTime() < createdAt) {
		return null;
	}
	return latestKey;
}

function hasCompletedOccurrence(runs: AlwaysOnRun[], occurrenceKey: string): boolean {
	return runs.some(
		(run) =>
			run.scheduledOccurrenceKey === occurrenceKey &&
			run.finishedAt !== undefined &&
			run.outcome !== undefined &&
			run.outcome !== "abandoned",
	);
}

function findInterruptedOccurrenceRun(runs: AlwaysOnRun[], occurrenceKey: string): AlwaysOnRun | undefined {
	return runs.find((run) => run.scheduledOccurrenceKey === occurrenceKey && run.finishedAt === undefined);
}

function selectLaterOccurrenceKey(currentKey: string | undefined, candidateKey: string | null): string | undefined {
	if (!candidateKey) {
		return currentKey;
	}
	if (!currentKey) {
		return candidateKey;
	}
	return new Date(candidateKey).getTime() > new Date(currentKey).getTime() ? candidateKey : currentKey;
}

function findAlwaysOnWorkItem(workItems: AlwaysOnWorkItem[], workItemId: string): AlwaysOnWorkItem | undefined {
	return workItems.find((workItem) => workItem.workItemId === workItemId);
}

function findAlwaysOnRun(runs: AlwaysOnRun[], runId: string): AlwaysOnRun | undefined {
	return runs.find((run) => run.runId === runId);
}

function findLatestAlwaysOnRunForWorkItem(runs: AlwaysOnRun[], workItemId: string): AlwaysOnRun | undefined {
	const relatedRuns = runs.filter((run) => run.workItemId === workItemId);
	return relatedRuns[relatedRuns.length - 1];
}

function buildAlwaysOnNotificationPayload(input: {
	workItem: AlwaysOnWorkItem;
	runId: string;
	sessionId: string;
	outcome: AlwaysOnRunOutcome;
	errorMessage?: string;
}): AlwaysOnSupervisorNotification | null {
	if (input.outcome !== "completed" && input.outcome !== "blocked" && input.outcome !== "needs_user") {
		return null;
	}

	const title = `Always-on ${input.outcome}`;
	const messageParts = [
		`Job ${input.workItem.workItemId}`,
		`run ${input.runId}`,
		`session ${input.sessionId}`,
		input.errorMessage?.trim(),
	].filter((value): value is string => typeof value === "string" && value.trim().length > 0);

	return {
		title,
		message: messageParts.join(" — "),
		workItemId: input.workItem.workItemId,
		runId: input.runId,
		sessionId: input.sessionId,
		outcome: input.outcome,
	};
}

function emitAlwaysOnNotification(
	options: AlwaysOnSupervisorOptions,
	payload: AlwaysOnSupervisorNotification | null,
): void {
	if (!payload) {
		return;
	}
	notification.sendNotification(payload.title, payload.message);
	options.notify?.(payload);
}

export function createAlwaysOnSupervisor(options: AlwaysOnSupervisorOptions) {
	const baseDir = getAlwaysOnBaseDir(options.baseDir);
	const clock = options.clock ?? (() => new Date().toISOString());
	const registry = createAlwaysOnAgentRegistry({ baseDir });
	const activeScheduledRuns = new Map<string, { runId: string; scheduledOccurrenceKey?: string }>();
	const pendingScheduledOccurrenceByWorkItemId = new Map<string, string>();
	let wakeLoopTimer: ReturnType<typeof setInterval> | null = null;
	let workItemsWatcher: FSWatcher | null = null;
	let serializedWork: Promise<void> = Promise.resolve();

	const runSerialized = async <T>(task: () => Promise<T>): Promise<T> => {
		const result = serializedWork.then(task);
		serializedWork = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	};

	const letFastCompletionsSettle = async (): Promise<void> => {
		await Promise.resolve();
		await Promise.resolve();
	};

	const queueWakeCycle = (reason: string): void => {
		options.onWake?.(reason);
		void runSerialized(async () => {
			await drainImmediateWorkItems();
			await reconcileScheduledWork();
		}).catch(() => undefined);
	};

	const executeWorkItem = async (
		workItem: AlwaysOnWorkItem,
		trigger: "manual" | "schedule",
		scheduledOccurrenceKey?: string,
	): Promise<AlwaysOnRun> => {
		const agent = registry.resolveTargetAgent({ agentId: workItem.agentId });
		const effectiveTarget = buildEffectiveTarget(agent, workItem);
		const runId = generateId("run");
		const tools = options.resolveTools ? await options.resolveTools({ agent, workItem, effectiveTarget }) : [];
		let startedExecution: AlwaysOnSupervisorStartedExecution;
		let result: AlwaysOnSupervisorExecutionResult;
		try {
			startedExecution = options.executeRun({ agent, workItem, effectiveTarget, tools });
		} catch (error) {
			startedExecution = {
				sessionId: `unlinked-${randomUUID().slice(0, 8)}`,
				completion: Promise.resolve({
					outcome: "error",
					errorMessage: error instanceof Error ? error.message : String(error),
				}),
			};
		}

		appendFact(getAlwaysOnRunsLedgerPath(baseDir), {
			type: "run_started",
			runId,
			workItemId: workItem.workItemId,
			agentId: agent.agentId,
			trigger,
			scheduledOccurrenceKey,
			provider: effectiveTarget.provider,
			modelId: effectiveTarget.modelId,
			thinkingLevel: effectiveTarget.thinkingLevel,
			sessionId: startedExecution.sessionId,
			timestamp: clock(),
		});

		if (trigger === "schedule") {
			activeScheduledRuns.set(workItem.workItemId, { runId, scheduledOccurrenceKey });
		}

		void startedExecution.completion
			.catch(
				(error): AlwaysOnSupervisorExecutionResult => ({
					outcome: "error",
					errorMessage: error instanceof Error ? error.message : String(error),
				}),
			)
			.then((completedResult) => {
				result = completedResult;
				appendFact(getAlwaysOnRunsLedgerPath(baseDir), {
					type: "run_finished",
					runId,
					outcome: completedResult.outcome,
					errorMessage: completedResult.errorMessage,
					timestamp: clock(),
				});
				emitAlwaysOnNotification(
					options,
					buildAlwaysOnNotificationPayload({
						workItem,
						runId,
						sessionId: startedExecution.sessionId,
						outcome: completedResult.outcome,
						errorMessage: completedResult.errorMessage,
					}),
				);
			})
			.finally(() => {
				if (trigger !== "schedule") {
					return;
				}
				const activeRun = activeScheduledRuns.get(workItem.workItemId);
				if (activeRun?.runId === runId) {
					activeScheduledRuns.delete(workItem.workItemId);
				}
				if (wakeLoopTimer !== null && pendingScheduledOccurrenceByWorkItemId.has(workItem.workItemId)) {
					queueWakeCycle("run_finished");
				}
			});

		await letFastCompletionsSettle();

		const run = deriveAlwaysOnRuns(readAlwaysOnRunFacts(baseDir)).find((entry) => entry.runId === runId);
		if (!run) {
			throw new Error(`Failed to resolve newly created run ${runId}`);
		}
		return run;
	};

	const drainImmediateWorkItems = async (): Promise<{ startedRuns: AlwaysOnRun[] }> => {
		const startedRuns: AlwaysOnRun[] = [];
		const pendingItems = readPendingImmediateWorkItems(baseDir);
		for (const workItem of pendingItems) {
			startedRuns.push(await executeWorkItem(workItem, "manual"));
		}
		return { startedRuns };
	};

	const reconcileScheduledWork = async (): Promise<{ startedRuns: AlwaysOnRun[] }> => {
		const startedRuns: AlwaysOnRun[] = [];
		const workItems = deriveAlwaysOnWorkItems(readAlwaysOnWorkItemFacts(baseDir)).filter(
			(workItem) => workItem.schedule && !workItem.disabledAt,
		);
		for (const workItem of workItems) {
			const dueOccurrenceKey = deriveDueOccurrenceKey(workItem, clock());
			const runsForWorkItem = deriveAlwaysOnRuns(readAlwaysOnRunFacts(baseDir)).filter(
				(run) => run.workItemId === workItem.workItemId,
			);

			const activeRun = activeScheduledRuns.get(workItem.workItemId);
			if (activeRun) {
				if (
					workItem.schedule?.kind === "recurring" &&
					dueOccurrenceKey &&
					dueOccurrenceKey !== activeRun.scheduledOccurrenceKey
				) {
					const nextPending = selectLaterOccurrenceKey(
						pendingScheduledOccurrenceByWorkItemId.get(workItem.workItemId),
						dueOccurrenceKey,
					);
					if (nextPending) {
						pendingScheduledOccurrenceByWorkItemId.set(workItem.workItemId, nextPending);
					}
				}
				continue;
			}

			const candidateOccurrenceKey = selectLaterOccurrenceKey(
				pendingScheduledOccurrenceByWorkItemId.get(workItem.workItemId),
				dueOccurrenceKey,
			);
			if (!candidateOccurrenceKey) {
				continue;
			}

			if (hasCompletedOccurrence(runsForWorkItem, candidateOccurrenceKey)) {
				if (pendingScheduledOccurrenceByWorkItemId.get(workItem.workItemId) === candidateOccurrenceKey) {
					pendingScheduledOccurrenceByWorkItemId.delete(workItem.workItemId);
				}
				continue;
			}

			const interruptedRun = findInterruptedOccurrenceRun(runsForWorkItem, candidateOccurrenceKey);
			if (interruptedRun) {
				appendFact(getAlwaysOnRunsLedgerPath(baseDir), {
					type: "run_finished",
					runId: interruptedRun.runId,
					outcome: "abandoned",
					timestamp: clock(),
				});
			}

			pendingScheduledOccurrenceByWorkItemId.delete(workItem.workItemId);
			startedRuns.push(await executeWorkItem(workItem, "schedule", candidateOccurrenceKey));
		}
		return { startedRuns };
	};

	return {
		async submitImmediateWork(input: {
			agentId?: string;
			workspacePath?: string;
			instruction: string;
			executionTarget?: AlwaysOnExecutionTarget;
		}): Promise<{ workItemId: string }> {
			const agent = registry.resolveTargetAgent({ agentId: input.agentId, workspacePath: input.workspacePath });
			const workItemId = generateId("job");
			appendFact(getAlwaysOnWorkItemsLedgerPath(baseDir), {
				type: "work_item_created",
				workItemId,
				agentId: agent.agentId,
				workspacePath: input.workspacePath ? resolve(input.workspacePath) : undefined,
				instruction: input.instruction,
				executionTarget: input.executionTarget,
				timestamp: clock(),
			});
			if (wakeLoopTimer !== null) {
				queueWakeCycle("new_work");
			} else {
				options.onWake?.("new_work");
			}
			return { workItemId };
		},

		async scheduleWork(input: {
			agentId?: string;
			instruction: string;
			schedule: AlwaysOnSchedule;
			executionTarget?: AlwaysOnExecutionTarget;
		}): Promise<{ workItemId: string }> {
			const agent = registry.resolveTargetAgent({ agentId: input.agentId });
			const workItemId = generateId("job");
			appendFact(getAlwaysOnWorkItemsLedgerPath(baseDir), {
				type: "work_item_created",
				workItemId,
				agentId: agent.agentId,
				instruction: input.instruction,
				schedule: input.schedule,
				executionTarget: input.executionTarget,
				timestamp: clock(),
			});
			if (wakeLoopTimer !== null) {
				queueWakeCycle("new_work");
			} else {
				options.onWake?.("new_work");
			}
			return { workItemId };
		},

		async createFollowUpWorkItem(input: {
			workItemId: string;
			instruction: string;
			executionTarget?: AlwaysOnExecutionTarget;
		}): Promise<{ workItemId: string }> {
			const workItems = deriveAlwaysOnWorkItems(readAlwaysOnWorkItemFacts(baseDir));
			const parentWorkItem = findAlwaysOnWorkItem(workItems, input.workItemId);
			if (!parentWorkItem) {
				throw new Error(`Always-on job not found: ${input.workItemId}`);
			}

			const runs = deriveAlwaysOnRuns(readAlwaysOnRunFacts(baseDir));
			const parentRun = findLatestAlwaysOnRunForWorkItem(runs, input.workItemId);
			const agent = registry.resolveTargetAgent({ agentId: parentWorkItem.agentId });
			const inheritedExecutionTarget = parentRun
				? {
						provider: parentRun.provider,
						modelId: parentRun.modelId,
						thinkingLevel: parentRun.thinkingLevel,
					}
				: buildEffectiveTarget(agent, parentWorkItem);

			const workItemId = generateId("job");
			appendFact(getAlwaysOnWorkItemsLedgerPath(baseDir), {
				type: "work_item_created",
				workItemId,
				agentId: parentWorkItem.agentId,
				workspacePath: parentWorkItem.workspacePath,
				instruction: input.instruction,
				executionTarget: input.executionTarget ?? inheritedExecutionTarget,
				relatedWorkItemIds: [parentWorkItem.workItemId],
				relatedSessionIds: parentRun ? [parentRun.sessionId] : undefined,
				timestamp: clock(),
			});
			if (wakeLoopTimer !== null) {
				queueWakeCycle("new_work");
			} else {
				options.onWake?.("new_work");
			}
			return { workItemId };
		},

		startWakeLoop(loopOptions?: { tickMs?: number }): void {
			if (wakeLoopTimer !== null) {
				return;
			}
			const tickMs = loopOptions?.tickMs ?? 1000;
			mkdirSync(join(baseDir, "always-on"), { recursive: true });
			workItemsWatcher = watch(join(baseDir, "always-on"), (_eventType, filename) => {
				const changedName = filename == null ? undefined : String(filename);
				if (changedName === "work-items.jsonl") {
					queueWakeCycle("file_watch");
				}
			});
			wakeLoopTimer = setInterval(() => {
				queueWakeCycle("tick");
			}, tickMs);
			queueWakeCycle("start_loop");
		},

		async stopWakeLoop(): Promise<void> {
			if (workItemsWatcher !== null) {
				workItemsWatcher.close();
				workItemsWatcher = null;
			}
			if (wakeLoopTimer !== null) {
				clearInterval(wakeLoopTimer);
				wakeLoopTimer = null;
			}
			await serializedWork;
		},

		async drainOnce(): Promise<{ startedRuns: AlwaysOnRun[] }> {
			return runSerialized(async () => drainImmediateWorkItems());
		},

		async reconcileOnce(): Promise<{ startedRuns: AlwaysOnRun[] }> {
			return runSerialized(async () => reconcileScheduledWork());
		},

		readWorkItems(): AlwaysOnWorkItem[] {
			return deriveAlwaysOnWorkItems(readAlwaysOnWorkItemFacts(baseDir));
		},

		readRuns(): AlwaysOnRun[] {
			return deriveAlwaysOnRuns(readAlwaysOnRunFacts(baseDir));
		},
	};
}

export function renderAlwaysOnJobs(baseDir?: string, agentId?: string): string {
	const workItems = deriveAlwaysOnWorkItems(readAlwaysOnWorkItemFacts(baseDir));
	const runs = deriveAlwaysOnRuns(readAlwaysOnRunFacts(baseDir));
	const filteredWorkItems = agentId ? workItems.filter((workItem) => workItem.agentId === agentId) : workItems;
	if (filteredWorkItems.length === 0) {
		return "No always-on jobs recorded.";
	}

	return [
		"Always-on jobs:",
		...filteredWorkItems.map((workItem) => {
			const relatedRuns = runs.filter((run) => run.workItemId === workItem.workItemId);
			const latestRun = relatedRuns[relatedRuns.length - 1];
			const status = latestRun?.outcome ?? "pending";
			const lineageLabel = workItem.relatedWorkItemIds?.length ? "follow-up" : "job";
			const followUpLine = workItem.relatedWorkItemIds?.length
				? `\n  Follow-up to: ${workItem.relatedWorkItemIds.join(", ")}`
				: "";
			const relatedSessionsLine = workItem.relatedSessionIds?.length
				? `\n  Related sessions: ${workItem.relatedSessionIds.join(", ")}`
				: "";
			return `- ${workItem.workItemId} (${lineageLabel})\n  Agent: ${workItem.agentId}\n  Instruction: ${workItem.instruction}\n  Status: ${status}${followUpLine}${relatedSessionsLine}`;
		}),
	].join("\n");
}

export function renderAlwaysOnRuns(baseDir: string | undefined, workItemId: string): string {
	const workItems = deriveAlwaysOnWorkItems(readAlwaysOnWorkItemFacts(baseDir));
	const workItem = findAlwaysOnWorkItem(workItems, workItemId);
	const runs = deriveAlwaysOnRuns(readAlwaysOnRunFacts(baseDir)).filter((run) => run.workItemId === workItemId);
	if (!workItem) {
		return `No always-on job recorded for ${workItemId}.`;
	}
	if (runs.length === 0) {
		return `No always-on runs recorded for ${workItemId}.`;
	}
	const lineageLines = [
		workItem.relatedWorkItemIds?.length ? `Follow-up to: ${workItem.relatedWorkItemIds.join(", ")}` : undefined,
		workItem.relatedSessionIds?.length ? `Related sessions: ${workItem.relatedSessionIds.join(", ")}` : undefined,
	].filter((value): value is string => typeof value === "string");
	return [
		`Always-on runs for ${workItemId}:`,
		`Instruction: ${workItem.instruction}`,
		...lineageLines,
		...runs.map(
			(run) =>
				`- ${run.runId}\n  Outcome: ${run.outcome ?? "running"}\n  Model: ${run.provider} / ${run.modelId} / ${run.thinkingLevel}\n  Session: ${run.sessionId}`,
		),
	].join("\n");
}

export function renderAlwaysOnThread(baseDir: string | undefined, runId: string): string {
	const runs = deriveAlwaysOnRuns(readAlwaysOnRunFacts(baseDir));
	const run = findAlwaysOnRun(runs, runId);
	if (!run) {
		return `No always-on run recorded for ${runId}.`;
	}

	const workItems = deriveAlwaysOnWorkItems(readAlwaysOnWorkItemFacts(baseDir));
	const workItem = findAlwaysOnWorkItem(workItems, run.workItemId);
	const sessionManager = new SessionManager(false, undefined, true);
	const transcript = sessionManager.getThreadContent(run.sessionId, {
		maxMessages: 200,
		startIndex: 0,
		detailed: false,
		globalSearch: true,
	});

	return [
		`Always-on thread for run ${run.runId}`,
		`Work item: ${run.workItemId}`,
		`Session: ${run.sessionId}`,
		workItem?.relatedWorkItemIds?.length ? `Follow-up to: ${workItem.relatedWorkItemIds.join(", ")}` : undefined,
		workItem?.relatedSessionIds?.length ? `Related sessions: ${workItem.relatedSessionIds.join(", ")}` : undefined,
		transcript?.content ?? `Session transcript unavailable for ${run.sessionId}.`,
	]
		.filter((value): value is string => typeof value === "string")
		.join("\n\n");
}
