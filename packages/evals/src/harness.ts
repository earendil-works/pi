import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { existsSync } from "node:fs";
import { chmod, chown, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { contentText, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type CreateAgentSessionOptions,
	createAgentSessionFromServices,
	createAgentSessionServices,
	getAgentDir,
	type InlineExtension,
	ModelRuntime,
	readStoredCredential,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
	createHarness,
	type Harness,
	type HarnessContext,
	type JsonValue,
	normalizeRecord,
	type SimpleHarnessResult,
	type TranscriptEvent,
	toJsonValue,
} from "vitest-evals/harness";
import type { DocumentationVariant } from "./plan.ts";
import { PI_SESSION_SNAPSHOT_ARTIFACT } from "./report.ts";

export type PiCodingAgentInput = string | Array<{ type: "prompt"; content: string } | { type: "reload" }>;

export type PiCodingAgentModelSelection = {
	provider: string;
	id: string;
};

export type PiCodingAgentHarnessOptions = {
	name?: string;
	model?: PiCodingAgentModelSelection;
	noTools?: CreateAgentSessionOptions["noTools"];
	tools?: CreateAgentSessionOptions["tools"];
	customTools?: CreateAgentSessionOptions["customTools"];
	workspaceFiles?: Readonly<Record<string, string>>;
	transformSystemPrompt?: (defaultPrompt: string) => string;
	expectedPiDocumentation?: boolean;
};

export type PiCodingAgentHarnessWithOutput<TOutput extends JsonValue> = PiCodingAgentHarnessOptions & {
	output: (args: {
		response: string;
		session: AgentSession;
		systemPrompt: string;
		agentDir: string;
	}) => TOutput | Promise<TOutput>;
};

export function resolveModelSelection(
	explicitModel: PiCodingAgentModelSelection | undefined,
	environment: { PI_PROVIDER?: string; PI_MODEL?: string } = process.env,
): PiCodingAgentModelSelection {
	const provider = (explicitModel?.provider ?? environment.PI_PROVIDER)?.trim();
	const id = (explicitModel?.id ?? environment.PI_MODEL)?.trim();
	if (!provider || !id) {
		throw new Error("Select a harness model explicitly or set both PI_PROVIDER and PI_MODEL as defaults.");
	}
	return { provider, id };
}

export function applyIsolatedEnvironment(home: string, agentDir: string): () => void {
	const overrides = { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir };
	const previous = new Map<string, string | undefined>();
	for (const name of Object.keys(process.env)) {
		if (!name.startsWith("PI_EVAL_")) continue;
		previous.set(name, process.env[name]);
		delete process.env[name];
	}
	for (const [name, value] of Object.entries(overrides)) {
		if (!previous.has(name)) previous.set(name, process.env[name]);
		process.env[name] = value;
	}
	return () => {
		for (const [name, value] of previous) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	};
}

type SandboxIdentity = { uid: number; gid: number };

function parseSandboxId(name: "PI_EVAL_SANDBOX_UID" | "PI_EVAL_SANDBOX_GID"): number | undefined {
	const value = process.env[name];
	if (value === undefined) return undefined;
	const id = Number(value);
	if (!Number.isSafeInteger(id) || id < 1) throw new Error(`${name} must be a positive integer.`);
	return id;
}

function resolveSandboxIdentity(): SandboxIdentity | undefined {
	const uid = parseSandboxId("PI_EVAL_SANDBOX_UID");
	const gid = parseSandboxId("PI_EVAL_SANDBOX_GID");
	if (uid === undefined && gid === undefined) return undefined;
	if (uid === undefined || gid === undefined) {
		throw new Error("Set both PI_EVAL_SANDBOX_UID and PI_EVAL_SANDBOX_GID, or neither.");
	}
	return { uid, gid };
}

async function chownTree(path: string, identity: SandboxIdentity): Promise<void> {
	const stats = await lstat(path);
	if (stats.isDirectory() && !stats.isSymbolicLink()) {
		await Promise.all((await readdir(path)).map((entry) => chownTree(join(path, entry), identity)));
	}
	await chown(path, identity.uid, identity.gid);
}

async function protectTransformedModules(): Promise<string[]> {
	const protectedPaths: string[] = [];
	for (const directory of await readdir(tmpdir(), { withFileTypes: true })) {
		if (!directory.isDirectory()) continue;
		const cacheRoot = join(tmpdir(), directory.name);
		const ssrRoot = join(cacheRoot, "ssr");
		let files: Dirent[];
		try {
			files = await readdir(ssrRoot, { withFileTypes: true });
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
			throw error;
		}
		await Promise.all([chmod(cacheRoot, 0o755), chmod(ssrRoot, 0o755)]);
		for (const file of files) {
			if (!file.isFile()) continue;
			const path = join(ssrRoot, file.name);
			await chmod(path, 0o600);
			protectedPaths.push(path);
		}
	}
	return protectedPaths;
}

async function enterToolSandbox(root: string, identity: SandboxIdentity | undefined): Promise<void> {
	if (!identity) return;
	if (
		typeof process.getuid !== "function" ||
		typeof process.geteuid !== "function" ||
		typeof process.setuid !== "function" ||
		typeof process.setgid !== "function" ||
		typeof process.setgroups !== "function"
	) {
		throw new Error("The eval filesystem sandbox requires POSIX user APIs.");
	}
	if (process.getuid() !== 0 || process.geteuid() !== 0) {
		throw new Error("The eval runner must start as root before entering the unprivileged tool sandbox.");
	}

	const protectedPaths = await protectTransformedModules();
	await chownTree(root, identity);
	process.setgroups([]);
	process.setgid(identity.gid);
	process.setuid(identity.uid);
	if (process.getuid() !== identity.uid || process.geteuid() !== identity.uid) {
		throw new Error("Failed to enter the unprivileged eval tool sandbox.");
	}
	for (const path of protectedPaths) {
		try {
			await readFile(path);
		} catch (error) {
			if (error instanceof Error && "code" in error && (error.code === "EACCES" || error.code === "ENOENT")) {
				continue;
			}
			throw error;
		}
		throw new Error(`The unprivileged eval process can read a transformed eval module: ${path}`);
	}
}

function toTranscriptEvents(messages: AgentSession["messages"]): TranscriptEvent[] {
	const events: TranscriptEvent[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			events.push({ type: "message", role: "user", content: contentText(message.content) });
			continue;
		}
		if (message.role === "assistant") {
			const text = contentText(message.content);
			if (text) events.push({ type: "message", role: "assistant", content: text });
			for (const part of message.content) {
				if (part.type !== "toolCall") continue;
				events.push({
					type: "tool_call",
					id: part.id,
					name: part.name,
					arguments: normalizeRecord(part.arguments),
				});
			}
			continue;
		}
		if (message.role === "toolResult") {
			const text = contentText(message.content);
			events.push({
				type: "tool_result",
				toolCallId: message.toolCallId,
				name: message.toolName,
				content: message.content.every((part) => part.type === "text") ? text : toJsonValue(message.content),
				...(message.isError ? { error: { message: text || "Tool failed" } } : {}),
			});
		}
	}
	return events;
}

async function seedWorkspace(workspace: string, files: Readonly<Record<string, string>> | undefined): Promise<void> {
	for (const [name, content] of Object.entries(files ?? {})) {
		if (!name || isAbsolute(name)) throw new TypeError(`Invalid workspace fixture path: ${name}`);
		const path = resolve(workspace, name);
		const pathFromWorkspace = relative(workspace, path);
		if (pathFromWorkspace === ".." || pathFromWorkspace.startsWith(`..${sep}`) || isAbsolute(pathFromWorkspace)) {
			throw new TypeError(`Workspace fixture escapes the workspace: ${name}`);
		}
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, content, { mode: 0o600 });
	}
}

async function promptAgent(session: AgentSession, input: string, signal: AbortSignal | undefined): Promise<string> {
	signal?.throwIfAborted();
	const previousMessageCount = session.messages.length;
	await session.prompt(input);
	const assistant = session.messages
		.slice(previousMessageCount)
		.reverse()
		.find((message) => message.role === "assistant");
	if (!assistant) throw new Error("Agent run completed without an assistant message.");
	if (assistant.stopReason !== "stop" && assistant.stopReason !== "toolUse") {
		throw new Error(
			assistant.errorMessage ?? `Agent run ended with unexpected stop reason: ${assistant.stopReason}.`,
		);
	}
	const output = session.getLastAssistantText();
	if (!output && assistant.stopReason === "stop") throw new Error("Agent run produced no assistant text.");
	return output ?? "";
}

function verifySystemPrompt(systemPrompt: string, options: PiCodingAgentHarnessOptions): void {
	if (options.expectedPiDocumentation === undefined) return;
	if (!systemPrompt.includes("\nGuidelines:\n")) {
		throw new Error(`Pi system prompt lost its guidelines in the ${options.name} eval variant.`);
	}
	const hasDocumentation = systemPrompt.includes("\nPi documentation (read only");
	if (hasDocumentation !== options.expectedPiDocumentation) {
		throw new Error(`Pi system prompt does not match the ${options.name} eval variant.`);
	}
}

async function runPiCodingAgent<TOutput extends JsonValue>(
	input: PiCodingAgentInput,
	signal: AbortSignal | undefined,
	setArtifact: HarnessContext["setArtifact"],
	options: PiCodingAgentHarnessOptions | PiCodingAgentHarnessWithOutput<TOutput>,
): Promise<SimpleHarnessResult<string | TOutput>> {
	const startedAt = performance.now();
	signal?.throwIfAborted();
	const selection = resolveModelSelection(options.model);
	const hostAgentDir = getAgentDir();
	const sandboxIdentity = resolveSandboxIdentity();
	const root = await mkdtemp(join(tmpdir(), "pi-eval-"));
	const workspace = join(root, "workspace");
	const isolatedHome = join(root, "home");
	const agentDir = join(isolatedHome, ".pi", "agent");
	const extensionFactories: InlineExtension[] = [];
	if (options.transformSystemPrompt) {
		const transform = options.transformSystemPrompt;
		extensionFactories.push({
			name: "eval-system-prompt-transform",
			hidden: true,
			factory: (pi) => {
				pi.on("before_agent_start", ({ systemPrompt }) => ({ systemPrompt: transform(systemPrompt) }));
			},
		});
	}

	let sessionManager: SessionManager | undefined;
	let session: AgentSession | undefined;
	let result: SimpleHarnessResult<string | TOutput> | undefined;
	let runError: unknown;
	const cleanupErrors: unknown[] = [];
	let hiddenCredentialEnvironment: { name: string; value: string } | undefined;
	const restoreEnvironment = applyIsolatedEnvironment(isolatedHome, agentDir);
	try {
		const authPath = join(hostAgentDir, "auth.json");
		const credentials = new InMemoryCredentialStore();
		const storedCredential = readStoredCredential(selection.provider, authPath);
		if (storedCredential) await credentials.modify(selection.provider, async () => storedCredential);
		const modelRuntime = await ModelRuntime.create({ credentials });
		await Promise.all([mkdir(workspace), mkdir(agentDir, { recursive: true })]);
		await seedWorkspace(workspace, options.workspaceFiles);
		const model = modelRuntime.getModel(selection.provider, selection.id);
		if (!model) throw new Error(`Eval model not found: ${selection.provider}/${selection.id}`);
		const auth = await modelRuntime.getAuth(model);
		if (!auth) {
			throw new Error(`Eval model has no configured authentication: ${selection.provider}/${selection.id}`);
		}
		if (!storedCredential && auth.auth.apiKey) {
			await modelRuntime.setRuntimeApiKey(selection.provider, auth.auth.apiKey);
		}
		if (sandboxIdentity) {
			await rm(authPath, { force: true });
			const credentialEnvironmentValue = auth.source ? process.env[auth.source] : undefined;
			if (auth.source && /^[A-Z][A-Z0-9_]*$/.test(auth.source) && credentialEnvironmentValue) {
				hiddenCredentialEnvironment = { name: auth.source, value: credentialEnvironmentValue };
				delete process.env[auth.source];
			}
		}

		const services = await createAgentSessionServices({
			cwd: workspace,
			modelRuntime,
			resourceLoaderOptions: { extensionFactories },
		});
		signal?.throwIfAborted();
		sessionManager = SessionManager.create(workspace, join(root, "sessions"));
		setArtifact("runId", sessionManager.getSessionId());
		session = (
			await createAgentSessionFromServices({
				services,
				sessionManager,
				model,
				thinkingLevel: "off",
				tools: options.tools,
				noTools: options.noTools,
				customTools: options.customTools,
			})
		).session;

		const expectedInlinePaths = new Set(extensionFactories.map(({ name }) => `<inline:${name}>`));
		const unexpectedExtensions = session.extensionRunner
			.getExtensionPaths()
			.filter((path) => !expectedInlinePaths.has(path));
		if (unexpectedExtensions.length > 0) {
			throw new Error(`Isolated eval loaded unexpected extensions: ${unexpectedExtensions.join(", ")}`);
		}

		await enterToolSandbox(root, sandboxIdentity);
		let response: string | undefined;
		let systemPrompt: string | undefined;
		const steps = typeof input === "string" ? [{ type: "prompt" as const, content: input }] : input;
		let abortPromise: Promise<void> | undefined;
		const abort = () => {
			abortPromise ??= session!.abort();
		};
		signal?.addEventListener("abort", abort, { once: true });
		try {
			for (const step of steps) {
				if (step.type === "reload") {
					await session.reload();
					continue;
				}
				response = await promptAgent(session, step.content, signal);
				systemPrompt = session.systemPrompt;
			}
		} finally {
			signal?.removeEventListener("abort", abort);
			if (abortPromise) await abortPromise;
		}
		if (response === undefined || systemPrompt === undefined) {
			throw new Error("Pi eval input must include at least one prompt step.");
		}
		verifySystemPrompt(systemPrompt, options);
		const output =
			"output" in options ? await options.output({ response, session, systemPrompt, agentDir }) : response;
		const stats = session.getSessionStats();
		const hasPricing = [model.cost, ...(model.cost.tiers ?? [])].some(
			({ input: inputCost, output: outputCost, cacheRead, cacheWrite }) =>
				inputCost > 0 || outputCost > 0 || cacheRead > 0 || cacheWrite > 0,
		);
		result = {
			output,
			events: toTranscriptEvents(session.messages),
			metadata: { systemPromptSha256: createHash("sha256").update(systemPrompt).digest("hex") },
			usage: {
				provider: model.provider,
				model: model.id,
				inputTokens: stats.tokens.input,
				outputTokens: stats.tokens.output,
				totalTokens: stats.tokens.total,
				toolCalls: stats.toolCalls,
				metadata: {
					cacheReadTokens: stats.tokens.cacheRead,
					cacheWriteTokens: stats.tokens.cacheWrite,
					...(hasPricing ? { estimatedCostUsd: stats.cost } : {}),
				},
			},
		};
	} catch (error) {
		runError = error;
	} finally {
		if (sessionManager) {
			const sessionPath = sessionManager.getSessionFile();
			if (!sessionPath || !existsSync(sessionPath)) {
				cleanupErrors.push(new Error("Pi eval produced no session file."));
			} else {
				try {
					setArtifact(PI_SESSION_SNAPSHOT_ARTIFACT, await readFile(sessionPath, "utf8"));
				} catch (error) {
					cleanupErrors.push(error);
				}
			}
		}
		try {
			session?.dispose();
		} catch (error) {
			cleanupErrors.push(error);
		}
		try {
			await rm(root, { recursive: true, force: true });
		} catch (error) {
			cleanupErrors.push(error);
		}
		restoreEnvironment();
		if (hiddenCredentialEnvironment) {
			process.env[hiddenCredentialEnvironment.name] = hiddenCredentialEnvironment.value;
		}
	}

	if (runError !== undefined) {
		if (cleanupErrors.length === 0) throw runError;
		throw new AggregateError([runError, ...cleanupErrors], "Agent run failed and cleanup also failed.");
	}
	if (cleanupErrors.length === 1) throw cleanupErrors[0];
	if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, "Agent cleanup failed.");
	if (!result) throw new Error("Pi eval completed without a result.");
	return { ...result, timings: { totalMs: performance.now() - startedAt } };
}

export function createPiCodingAgentHarness<TOutput extends JsonValue>(
	options: PiCodingAgentHarnessWithOutput<TOutput>,
): Harness<PiCodingAgentInput, TOutput>;
export function createPiCodingAgentHarness(options?: PiCodingAgentHarnessOptions): Harness<PiCodingAgentInput, string>;
export function createPiCodingAgentHarness<TOutput extends JsonValue>(
	options: PiCodingAgentHarnessOptions | PiCodingAgentHarnessWithOutput<TOutput> = {},
): Harness<PiCodingAgentInput, string | TOutput> {
	return createHarness<PiCodingAgentInput, string | TOutput>({
		name: options.name ?? "pi-coding-agent",
		run: ({ input, signal, setArtifact }) => runPiCodingAgent(input, signal, setArtifact, options),
	});
}

/** Documentation evals intentionally exclude shell and unrestricted network tools. */
export const DOCUMENTATION_EVAL_TOOLS = ["read", "write", "edit", "grep", "find", "ls"] as const;

export function resolveDocumentationVariant(
	value: string | undefined = process.env.PI_EVAL_VARIANT,
): DocumentationVariant {
	if (value === "without_docs" || value === "with_docs") return value;
	throw new TypeError('PI_EVAL_VARIANT must be "without_docs" or "with_docs".');
}

export function excludePiDocumentation(defaultPrompt: string): string {
	const documentationStart = defaultPrompt.indexOf("\nPi documentation (read only");
	if (documentationStart === -1) throw new Error("Default Pi system prompt has no Pi documentation section.");
	const cwdStart = defaultPrompt.lastIndexOf("\nCurrent working directory: ");
	if (cwdStart === -1) throw new Error("Default Pi system prompt has no working-directory section.");
	return defaultPrompt.slice(0, documentationStart) + defaultPrompt.slice(cwdStart);
}

type DocumentationHarnessOptions = Omit<
	PiCodingAgentHarnessOptions,
	"name" | "transformSystemPrompt" | "expectedPiDocumentation"
>;
type DocumentationHarnessWithOutput<TOutput extends JsonValue> = Omit<
	PiCodingAgentHarnessWithOutput<TOutput>,
	"name" | "transformSystemPrompt" | "expectedPiDocumentation"
>;

export function createPiDocumentationEvalHarness<TOutput extends JsonValue>(
	options: DocumentationHarnessWithOutput<TOutput>,
): Harness<PiCodingAgentInput, TOutput>;
export function createPiDocumentationEvalHarness(
	options?: DocumentationHarnessOptions,
): Harness<PiCodingAgentInput, string>;
export function createPiDocumentationEvalHarness<TOutput extends JsonValue>(
	options: DocumentationHarnessOptions | DocumentationHarnessWithOutput<TOutput> = {},
) {
	if (process.env.PI_EVAL_CONTAINER !== "1" || !resolveSandboxIdentity()) {
		throw new Error("Documentation evals must run in the isolated container sandbox.");
	}
	const variant = resolveDocumentationVariant();
	return createPiCodingAgentHarness({
		...options,
		name: variant,
		tools: options.tools ?? [...DOCUMENTATION_EVAL_TOOLS],
		...(variant === "without_docs" ? { transformSystemPrompt: excludePiDocumentation } : {}),
		expectedPiDocumentation: variant === "with_docs",
	});
}
