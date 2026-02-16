import type { AgentTool, Message, ToolResultMessage } from "@kennyfrc/mu-ai";
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { registerRuntimeProvider, unregisterRuntimeProvidersBySourceId } from "../model-config.js";
import type { SessionManager } from "../session-manager.js";
import {
	buildMuDisplayV1ForCliResult,
	deriveContentFromJsonlRecords,
	deriveOkFromJsonlRecords,
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
				this.tools.registerTool(tool, { sourceId, priority: options?.priority });
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
							return {
								content: [{ type: "text", text: res.stdout }],
								details: {
									command: spec.command,
									args: fullArgs,
									exitCode: res.exitCode,
									ok: res.exitCode === 0,
									stdout: res.stdout,
									stderr: res.stderr,
									mode: "help",
								},
							};
						}

						const records = parseJsonl(res.stdout, spec.name);
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

				this.tools.registerTool(tool, { sourceId, priority: options?.priority });
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
