import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
	AskUserAnswer,
	AskUserRequest,
	AskUserScopePointer,
	SpecClarificationDocument,
	SpecClarificationItem,
	ValidationContractDocument,
	ValidationContractEntry,
} from "./types.js";

const VALIDATION_CONTRACT_FIELDS = new Set(["surface", "commandOrAction", "expect", "notes"]);

interface ScopePaths {
	rootDir: string;
	scopeDir: string;
	validationContractPath: string;
	specClarificationsPath: string;
	activeScopeDir: string;
	activeScopePath: string;
}

function asRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function asStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string");
}

function uniqueStrings(values: string[]): string[] {
	return Array.from(new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)));
}

function nowIso(): string {
	return new Date().toISOString();
}

export function sanitizeScopeName(scopeName: string): string {
	const trimmed = scopeName.trim().toLowerCase();
	const normalized = trimmed
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
	if (!normalized) {
		throw new Error("Scope name must contain at least one letter or number");
	}
	return normalized;
}

export function getScopePaths(args: { cwd?: string; scopeName: string; sessionId?: string | null }): ScopePaths {
	const cwd = resolve(args.cwd ?? process.cwd());
	const sanitizedScopeName = sanitizeScopeName(args.scopeName);
	const rootDir = join(cwd, "devdocs", "scopes");
	const scopeDir = join(rootDir, sanitizedScopeName);
	const activeScopeDir = join(rootDir, "_active");
	const activeScopePath = join(activeScopeDir, `${args.sessionId ?? "unknown"}.json`);

	return {
		rootDir,
		scopeDir,
		validationContractPath: join(scopeDir, "validation-contract.json"),
		specClarificationsPath: join(scopeDir, "spec-clarifications.json"),
		activeScopeDir,
		activeScopePath,
	};
}

function ensureDir(path: string): void {
	mkdirSync(path, { recursive: true });
}

function readJson<T>(path: string, parse: (value: unknown) => T | null): T | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		return parse(parsed) ?? undefined;
	} catch {
		return undefined;
	}
}

function parseValidationEntry(value: unknown): ValidationContractEntry | null {
	if (!asRecord(value)) return null;
	const id = typeof value.id === "string" ? value.id : "";
	if (!id.trim()) return null;
	const entry: ValidationContractEntry = { id };
	if (typeof value.surface === "string" && value.surface.trim()) entry.surface = value.surface;
	if (typeof value.commandOrAction === "string" && value.commandOrAction.trim()) {
		entry.commandOrAction = value.commandOrAction;
	}
	if (typeof value.expect === "string" && value.expect.trim()) entry.expect = value.expect;
	if (typeof value.notes === "string" && value.notes.trim()) entry.notes = value.notes;
	return entry;
}

function parseAskUserAnswer(value: unknown): AskUserAnswer | null {
	if (!asRecord(value)) return null;
	if (
		typeof value.questionId !== "string" ||
		typeof value.topic !== "string" ||
		typeof value.prompt !== "string" ||
		typeof value.answer !== "string" ||
		(value.source !== "option" && value.source !== "custom")
	) {
		return null;
	}

	const answer: AskUserAnswer = {
		questionId: value.questionId,
		topic: value.topic,
		prompt: value.prompt,
		answer: value.answer,
		source: value.source,
	};

	if (typeof value.field === "string" && value.field.trim()) {
		answer.field = value.field;
	}
	if (typeof value.entryId === "string" && value.entryId.trim()) {
		answer.entryId = value.entryId;
	}
	return answer;
}

function parseValidationContractDocument(value: unknown): ValidationContractDocument | null {
	if (!asRecord(value) || value.version !== 1 || typeof value.scopeName !== "string") {
		return null;
	}

	const entries = Array.isArray(value.entries)
		? value.entries.map(parseValidationEntry).filter((item): item is ValidationContractEntry => item !== null)
		: [];
	const answers = Array.isArray(value.answers)
		? value.answers.map(parseAskUserAnswer).filter((item): item is AskUserAnswer => item !== null)
		: [];

	return {
		version: 1,
		scopeName: value.scopeName,
		createdAt: typeof value.createdAt === "string" ? value.createdAt : nowIso(),
		updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : nowIso(),
		objectiveHistory: uniqueStrings(asStringArray(value.objectiveHistory)),
		entries,
		answers,
		notes: uniqueStrings(asStringArray(value.notes)),
	};
}

function parseSpecClarificationItem(value: unknown): SpecClarificationItem | null {
	if (!asRecord(value)) return null;
	if (
		typeof value.id !== "string" ||
		typeof value.topic !== "string" ||
		typeof value.question !== "string" ||
		typeof value.answer !== "string" ||
		(value.source !== "option" && value.source !== "custom")
	) {
		return null;
	}
	return {
		id: value.id,
		topic: value.topic,
		question: value.question,
		answer: value.answer,
		source: value.source,
		updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : nowIso(),
	};
}

function parseSpecClarificationDocument(value: unknown): SpecClarificationDocument | null {
	if (!asRecord(value) || value.version !== 1 || typeof value.scopeName !== "string") {
		return null;
	}

	const items = Array.isArray(value.items)
		? value.items.map(parseSpecClarificationItem).filter((item): item is SpecClarificationItem => item !== null)
		: [];

	return {
		version: 1,
		scopeName: value.scopeName,
		createdAt: typeof value.createdAt === "string" ? value.createdAt : nowIso(),
		updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : nowIso(),
		objectiveHistory: uniqueStrings(asStringArray(value.objectiveHistory)),
		items,
		notes: uniqueStrings(asStringArray(value.notes)),
	};
}

function parseActiveScopePointer(value: unknown): AskUserScopePointer | null {
	if (!asRecord(value)) return null;
	if (
		typeof value.sessionId !== "string" ||
		typeof value.scopeName !== "string" ||
		typeof value.updatedAt !== "string"
	) {
		return null;
	}
	return {
		sessionId: value.sessionId,
		scopeName: value.scopeName,
		updatedAt: value.updatedAt,
	};
}

export function loadValidationContract(path: string): ValidationContractDocument | undefined {
	return readJson(path, parseValidationContractDocument);
}

export function loadSpecClarifications(path: string): SpecClarificationDocument | undefined {
	return readJson(path, parseSpecClarificationDocument);
}

export function loadActiveScopePointer(path: string): AskUserScopePointer | undefined {
	return readJson(path, parseActiveScopePointer);
}

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function mergeValidationEntries(args: {
	existingEntries: ValidationContractEntry[];
	suggestedEntries: ValidationContractEntry[];
	answers: AskUserAnswer[];
}): ValidationContractEntry[] {
	const byId = new Map<string, ValidationContractEntry>();

	for (const entry of [...args.existingEntries, ...args.suggestedEntries]) {
		byId.set(entry.id, { ...byId.get(entry.id), ...entry });
	}

	for (const answer of args.answers) {
		if (!answer.field || !answer.entryId || !VALIDATION_CONTRACT_FIELDS.has(answer.field)) continue;
		const current = byId.get(answer.entryId) ?? { id: answer.entryId };
		if (answer.field === "surface") current.surface = answer.answer;
		if (answer.field === "commandOrAction") current.commandOrAction = answer.answer;
		if (answer.field === "expect") current.expect = answer.answer;
		if (answer.field === "notes") current.notes = answer.answer;
		byId.set(answer.entryId, current);
	}

	return Array.from(byId.values());
}

export function mergeValidationContract(args: {
	existing: ValidationContractDocument | undefined;
	scopeName: string;
	request: AskUserRequest;
	answers: AskUserAnswer[];
}): ValidationContractDocument {
	const timestamp = nowIso();
	return {
		version: 1,
		scopeName: args.scopeName,
		createdAt: args.existing?.createdAt ?? timestamp,
		updatedAt: timestamp,
		objectiveHistory: uniqueStrings([...(args.existing?.objectiveHistory ?? []), args.request.objective]),
		entries: mergeValidationEntries({
			existingEntries: args.existing?.entries ?? [],
			suggestedEntries: args.request.suggestedEntries ?? [],
			answers: args.answers,
		}),
		answers: [...(args.existing?.answers ?? []), ...args.answers],
		notes: uniqueStrings([...(args.existing?.notes ?? []), args.request.notes ?? ""]),
	};
}

export function mergeSpecClarifications(args: {
	existing: SpecClarificationDocument | undefined;
	scopeName: string;
	request: AskUserRequest;
	answers: AskUserAnswer[];
}): SpecClarificationDocument {
	const timestamp = nowIso();
	const byId = new Map<string, SpecClarificationItem>();

	for (const item of args.existing?.items ?? []) {
		byId.set(item.id, item);
	}

	for (const answer of args.answers) {
		byId.set(answer.questionId, {
			id: answer.questionId,
			topic: answer.topic,
			question: answer.prompt,
			answer: answer.answer,
			source: answer.source,
			updatedAt: timestamp,
		});
	}

	return {
		version: 1,
		scopeName: args.scopeName,
		createdAt: args.existing?.createdAt ?? timestamp,
		updatedAt: timestamp,
		objectiveHistory: uniqueStrings([...(args.existing?.objectiveHistory ?? []), args.request.objective]),
		items: Array.from(byId.values()),
		notes: uniqueStrings([...(args.existing?.notes ?? []), args.request.notes ?? ""]),
	};
}

export function persistScopeDocuments(args: {
	cwd?: string;
	scopeName: string;
	sessionId?: string | null;
	validationContract?: ValidationContractDocument;
	specClarifications?: SpecClarificationDocument;
}): string[] {
	const paths = getScopePaths(args);
	ensureDir(paths.scopeDir);
	const written: string[] = [];

	if (args.validationContract) {
		writeJson(paths.validationContractPath, args.validationContract);
		written.push(paths.validationContractPath);
	}
	if (args.specClarifications) {
		writeJson(paths.specClarificationsPath, args.specClarifications);
		written.push(paths.specClarificationsPath);
	}

	if (args.sessionId) {
		ensureDir(paths.activeScopeDir);
		writeJson(paths.activeScopePath, {
			sessionId: args.sessionId,
			scopeName: sanitizeScopeName(args.scopeName),
			updatedAt: nowIso(),
		} satisfies AskUserScopePointer);
		written.push(paths.activeScopePath);
	}

	return written;
}

export function loadScopeState(args: { cwd?: string; scopeName?: string | null; sessionId?: string | null }): {
	scopeName: string | null;
	validationContract?: ValidationContractDocument;
	specClarifications?: SpecClarificationDocument;
	paths?: ScopePaths;
} {
	const sessionId = args.sessionId ?? null;
	const cwd = args.cwd ?? process.cwd();
	const explicitScopeName = args.scopeName?.trim() ? sanitizeScopeName(args.scopeName) : null;
	const pointer =
		!explicitScopeName && sessionId
			? loadActiveScopePointer(getScopePaths({ cwd, scopeName: "placeholder", sessionId }).activeScopePath)
			: undefined;
	const resolvedScopeName = explicitScopeName ?? pointer?.scopeName ?? null;

	if (!resolvedScopeName) {
		return { scopeName: null };
	}

	const paths = getScopePaths({ cwd, scopeName: resolvedScopeName, sessionId });
	return {
		scopeName: resolvedScopeName,
		validationContract: loadValidationContract(paths.validationContractPath),
		specClarifications: loadSpecClarifications(paths.specClarificationsPath),
		paths,
	};
}
