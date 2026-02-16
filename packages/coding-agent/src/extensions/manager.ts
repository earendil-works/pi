import type { AgentTool, Message, ToolResultMessage } from "@kennyfrc/mu-ai";
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { registerRuntimeProvider, unregisterRuntimeProvidersBySourceId } from "../model-config.js";
import type { SessionManager } from "../session-manager.js";
import {
	buildMuDisplayV1ForCliRawOutput,
	buildMuDisplayV1ForCliResult,
	countJsonlParseErrors,
	deriveContentFromJsonlRecords,
	deriveOkFromJsonlRecords,
	formatCommandLineForDisplay,
	hasJsonlOutputOrResultRecords,
	parseJsonl,
	runJsonlCliCommand,
} from "./cli-jsonl.js";
import { CommandRegistry } from "./command-registry.js";
import { ExtensionRunner } from "./runner.js";
import { ToolRegistry } from "./tool-registry.js";
import type {
	ErasedAgentTool,
	ExtensionApi,
	ExtensionCliToolSpec,
	ExtensionCommand,
	ExtensionFactory,
	HookRegistrationOptions,
	ToolRegistrationOptions,
} from "./types.js";
import { composeToolResultTransformer, wrapToolWithExtensions } from "./wrapper.js";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function assertHasMuDisplayV1(toolName: string, details: unknown): void {
	if (!isRecord(details)) {
		throw new Error(
			`Extension tool "${toolName}" must return toolResult.details.mu_display (version 1). Received: ${typeof details}`,
		);
	}

	const muDisplay = details.mu_display;
	if (!isRecord(muDisplay) || muDisplay.version !== 1) {
		throw new Error(
			`Extension tool "${toolName}" must return toolResult.details.mu_display.version === 1. ` +
				`Tip: if this wraps a CLI, prefer api.registerCliTool(...) which auto-generates mu_display.`,
		);
	}

	const call = muDisplay.call;
	if (!isRecord(call) || call.style !== "argv") {
		throw new Error(`Extension tool "${toolName}" must return toolResult.details.mu_display.call.style === "argv".`);
	}

	// We require argv so the TUI can render consistent "toolName + argv" lines without
	// duplicating underlying implementation commands (e.g. websearch/webfetch).
	const argv = call.argv;
	if (!Array.isArray(argv) || !argv.every((v) => typeof v === "string")) {
		throw new Error(`Extension tool "${toolName}" must return toolResult.details.mu_display.call.argv as string[].`);
	}

	const text = call.text;
	if (typeof text !== "string" || !text.trim()) {
		throw new Error(
			`Extension tool "${toolName}" must return toolResult.details.mu_display.call.text as a non-empty string.`,
		);
	}
}

function wrapExtensionToolWithStrictMuDisplay(tool: ErasedAgentTool): ErasedAgentTool {
	return {
		...tool,
		execute: async (toolCallId, params, signal, onProgress) => {
			const res = await tool.execute(toolCallId, params, signal, onProgress);
			assertHasMuDisplayV1(tool.name, (res as { details?: unknown }).details);
			return res;
		},
	};
}

function isJsonlFlagUnsupported(stderr: string, jsonlFlag: string): boolean {
	const s = stderr.toLowerCase();
	const f = jsonlFlag.toLowerCase();
	if (!f.trim()) return false;
	if (!s.includes(f)) return false;
	return (
		s.includes("unknown option") ||
		s.includes("unrecognized option") ||
		s.includes("invalid option") ||
		s.includes("unknown flag")
	);
}

export interface ExtensionManagerOptions {
	builtInTools: Record<string, ErasedAgentTool>;
	builtInSourceId?: string;
	builtInPriority?: number;
	log?: (message: string, err?: unknown) => void;
	sessionManager?: SessionManager;
}

export class ExtensionManager {
	private runner = new ExtensionRunner();
	private tools = new ToolRegistry();
	private commands = new CommandRegistry();
	private loadedSourceIds = new Set<string>();
	private builtInToolNames: Set<string>;
	private builtInSourceId: string;
	private builtInPriority: number;
	private log: (message: string, err?: unknown) => void;
	private sessionManager?: SessionManager;

	constructor(opts: ExtensionManagerOptions) {
		this.builtInToolNames = new Set(Object.keys(opts.builtInTools));
		this.builtInSourceId = opts.builtInSourceId ?? "built-in";
		this.builtInPriority = opts.builtInPriority ?? 100;
		this.log = opts.log ?? (() => {});
		this.sessionManager = opts.sessionManager;

		// Register all built-in tools so extensions can override them via priority.
		for (const tool of Object.values(opts.builtInTools)) {
			this.tools.registerTool(tool, { sourceId: this.builtInSourceId, priority: this.builtInPriority });
		}
	}

	/** Load an in-process extension factory (Phase 1 style). */
	async loadExtension(factory: ExtensionFactory, sourceId: string): Promise<void> {
		this.loadedSourceIds.add(sourceId);

		const api: ExtensionApi = {
			registerTool: (tool, options?: ToolRegistrationOptions) => {
				// Enforce a strict display contract for extension tools.
				// Without mu_display, the TUI would otherwise guess and often render confusing headers.
				this.tools.registerTool(wrapExtensionToolWithStrictMuDisplay(tool), {
					sourceId,
					priority: options?.priority,
				});
			},
			registerCliTool: (spec: ExtensionCliToolSpec, options?: ToolRegistrationOptions) => {
				const paramsSchema = Type.Object({
					argv: Type.Array(
						Type.String({ description: "Arguments passed verbatim to the CLI (no shell quoting)." }),
					),
					stdin: Type.Optional(Type.String({ description: "Optional stdin to pipe to the process." })),
				});

				type Params = Static<typeof paramsSchema>;

				const fixedArgs = spec.fixedArgs ?? [];
				const jsonlFlag = spec.jsonlFlag === undefined ? "--jsonl" : spec.jsonlFlag;

				const tool: ErasedAgentTool = {
					name: spec.name,
					label: spec.label ?? spec.name,
					description: spec.description,
					parameters: paramsSchema,
					execute: async (
						_toolCallId: string,
						params: unknown,
						signal?: AbortSignal,
						onProgress?: (chunk: string) => void,
					) => {
						const raw = typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {};
						const argv = Array.isArray(raw.argv)
							? raw.argv.filter((v): v is string => typeof v === "string")
							: [];
						const stdin = typeof raw.stdin === "string" ? raw.stdin : undefined;

						const wantsHelp = argv.includes("--help") || argv.includes("-h") || argv[0] === "help";
						const useJsonl = !wantsHelp && Boolean(jsonlFlag);

						const fullArgs = [...fixedArgs, ...(useJsonl && jsonlFlag ? [jsonlFlag] : []), ...argv];
						const displayArgv = [...fixedArgs, ...argv];

						const res = await runJsonlCliCommand({
							command: spec.command,
							args: fullArgs,
							cwd: spec.cwd,
							env: spec.env,
							stdin,
							progress: spec.progress,
							signal,
							onProgress,
						});

						if (!useJsonl) {
							const ok = res.exitCode === 0;
							const mu_display = {
								version: 1 as const,
								call: {
									style: "argv" as const,
									text: formatCommandLineForDisplay(spec.command, displayArgv),
									command: spec.command,
									argv: displayArgv,
									cwd: spec.cwd,
								},
								summary: {
									text: `${ok ? "ok" : "error"} · exit=${res.exitCode}`,
									severity: ok ? ("ok" as const) : ("error" as const),
								},
								output: { collapse: { maxVisualLines: 5, expandHint: "ctrl+o to expand" } },
							};

							return {
								content: [{ type: "text", text: res.stdout }],
								details: {
									command: spec.command,
									args: fullArgs,
									exitCode: res.exitCode,
									ok,
									stdout: res.stdout,
									stderr: res.stderr,
									mode: "help",
									mu_display,
								},
							};
						}

						// If the CLI does not support the jsonlFlag, retry once without it.
						if (
							useJsonl &&
							typeof jsonlFlag === "string" &&
							res.exitCode !== 0 &&
							isJsonlFlagUnsupported(res.stderr, jsonlFlag)
						) {
							const retryArgs = [...fixedArgs, ...argv];
							const retry = await runJsonlCliCommand({
								command: spec.command,
								args: retryArgs,
								cwd: spec.cwd,
								env: spec.env,
								stdin,
								progress: spec.progress,
								signal,
								onProgress,
							});

							const ok = retry.exitCode === 0;
							const mu_display = buildMuDisplayV1ForCliRawOutput({
								toolName: spec.name,
								command: spec.command,
								displayArgv,
								cwd: spec.cwd,
								exitCode: retry.exitCode,
								ok,
								stderr: retry.stderr,
								jsonlParseErrorCount: 0,
								reason: "unsupported_jsonl",
							});

							return {
								content: [{ type: "text", text: retry.stdout }],
								details: {
									command: spec.command,
									args: retryArgs,
									exitCode: retry.exitCode,
									ok,
									stdout: retry.stdout,
									stderr: retry.stderr,
									mode: "raw",
									jsonlUnsupported: true,
									mu_display,
								},
							};
						}

						const records = parseJsonl(res.stdout, spec.name);
						const jsonlParseErrorCount = countJsonlParseErrors(records);
						const hasOutputOrResult = hasJsonlOutputOrResultRecords(records);

						// If the CLI claims to support JSONL but emits non-JSONL output, fall back to raw stdout
						// to avoid spamming the transcript/session with per-line JSON parse errors.
						if (!hasOutputOrResult && jsonlParseErrorCount > 0) {
							const ok = res.exitCode === 0;
							const mu_display = buildMuDisplayV1ForCliRawOutput({
								toolName: spec.name,
								command: spec.command,
								displayArgv,
								cwd: spec.cwd,
								exitCode: res.exitCode,
								ok,
								stderr: res.stderr,
								jsonlParseErrorCount,
								reason: "invalid_jsonl",
							});

							return {
								content: [{ type: "text", text: res.stdout }],
								details: {
									command: spec.command,
									args: fullArgs,
									exitCode: res.exitCode,
									ok,
									stdout: res.stdout,
									stderr: res.stderr,
									mode: "raw",
									jsonlParseErrorCount,
									mu_display,
								},
							};
						}

						// If the process failed and produced no JSONL records at all, show stderr instead of "[]".
						if (!hasOutputOrResult && jsonlParseErrorCount === 0 && records.length === 0 && res.exitCode !== 0) {
							const ok = false;
							const text = res.stderr.trim() ? res.stderr : `Command failed with exit code ${res.exitCode}`;
							const mu_display = buildMuDisplayV1ForCliRawOutput({
								toolName: spec.name,
								command: spec.command,
								displayArgv,
								cwd: spec.cwd,
								exitCode: res.exitCode,
								ok,
								stderr: res.stderr,
								jsonlParseErrorCount: 0,
								reason: "stderr_only_failure",
							});

							return {
								content: [{ type: "text", text }],
								details: {
									command: spec.command,
									args: fullArgs,
									exitCode: res.exitCode,
									ok,
									stdout: res.stdout,
									stderr: res.stderr,
									mode: "stderr",
									mu_display,
								},
							};
						}

						const contentText = deriveContentFromJsonlRecords(records);
						const okFromRecords = deriveOkFromJsonlRecords(records);
						const ok = okFromRecords ?? res.exitCode === 0;

						const mu_display = buildMuDisplayV1ForCliResult({
							toolName: spec.name,
							command: spec.command,
							displayArgv,
							cwd: spec.cwd,
							exitCode: res.exitCode,
							ok,
							records,
							stderr: res.stderr,
						});

						return {
							content: [{ type: "text", text: contentText }],
							details: {
								command: spec.command,
								args: fullArgs,
								exitCode: res.exitCode,
								ok,
								stdout: res.stdout,
								stderr: res.stderr,
								records,
								mu_display,
							},
						};
					},
				};

				this.tools.registerTool(wrapExtensionToolWithStrictMuDisplay(tool), {
					sourceId,
					priority: options?.priority,
				});
			},
			registerProvider: (providerName, config, options) => {
				registerRuntimeProvider(providerName, config, { sourceId, priority: options?.priority });
			},
			context: (hook, options?: HookRegistrationOptions) => {
				this.runner.registerContext(hook, { sourceId, priority: options?.priority });
			},
			registerCommand: (command, options) => {
				this.commands.registerCommand(command, { sourceId, priority: options?.priority });
			},
			input: (hook, options?: HookRegistrationOptions) => {
				this.runner.registerInput(hook, { sourceId, priority: options?.priority });
			},
			beforeToolCall: (hook, options?: HookRegistrationOptions) => {
				this.runner.registerBeforeToolCall(hook, { sourceId, priority: options?.priority });
			},
			afterToolResult: (hook, options?: HookRegistrationOptions) => {
				this.runner.registerAfterToolResult(hook, { sourceId, priority: options?.priority });
			},
			appendSessionEntry: (customType, data) => {
				this.sessionManager?.appendCustomEntry(customType, data);
			},
			appendSessionMessage: (customType, message, options) => {
				this.sessionManager?.appendCustomMessage(customType, message, options);
			},
		};

		try {
			await factory(api);
		} catch (err) {
			this.log(`Extension failed to load: ${sourceId}`, err);
		}
	}

	unloadBySourceId(sourceId: string): void {
		this.loadedSourceIds.delete(sourceId);
		this.runner.unregisterBySourceId(sourceId);
		this.tools.unregisterBySourceId(sourceId);
		this.commands.unregisterBySourceId(sourceId);
		unregisterRuntimeProvidersBySourceId(sourceId);
	}

	unloadAllExtensions(): void {
		for (const sourceId of Array.from(this.loadedSourceIds)) {
			this.unloadBySourceId(sourceId);
		}
	}

	/**
	 * Build the final AgentTool list:
	 * - selected built-ins (or extension overrides)
	 * - all extension-defined tools with *new* names
	 * - wrap every tool with extension hooks
	 */
	getToolsForSelection(selectedToolNames: string[]): Array<AgentTool<TSchema, unknown>> {
		const selected = selectedToolNames
			.map((name) => this.tools.getTool(name))
			.filter((t): t is AgentTool<TSchema, unknown> => Boolean(t));

		const selectedNames = new Set(selected.map((t) => t.name));

		// Include extension tools that are not built-in tool names and not already selected.
		const extras = this.tools
			.listTools()
			.filter((t) => !selectedNames.has(t.name) && !this.builtInToolNames.has(t.name));

		const combined = [...selected, ...extras];

		return combined.map((t) => wrapToolWithExtensions(t, this.runner));
	}

	composeToolResultTransformer(
		base?: (toolResult: ToolResultMessage<unknown>) => ToolResultMessage<unknown>,
	): (toolResult: ToolResultMessage<unknown>) => ToolResultMessage<unknown> {
		return composeToolResultTransformer(this.runner, base);
	}

	getCommand(name: string): ExtensionCommand | undefined {
		return this.commands.getCommand(name);
	}

	listCommands(): ExtensionCommand[] {
		return this.commands.listCommands();
	}

	async applyInputHooks(text: string, abortSignal?: AbortSignal): Promise<{ handled: boolean; text: string }> {
		return this.runner.applyInput(text, abortSignal);
	}

	getMessagePreprocessor(): (messages: Message[], abortSignal?: AbortSignal) => Promise<Message[]> {
		return async (messages: Message[], abortSignal?: AbortSignal) => {
			return this.runner.applyContext(messages, abortSignal);
		};
	}
}
