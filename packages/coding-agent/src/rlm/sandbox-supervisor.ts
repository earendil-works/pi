/**
 * SandboxSupervisor - Session management for RLM extension
 *
 * Responsibilities:
 * - Create/destroy sessions with backend affinity
 * - Coordinate StateStore, CostLedger, and SandboxBackend
 * - Handle bridge calls from sandbox (web_search, fetch, sub_llm)
 * - Enforce budgets and limits
 *
 * Architecture:
 * - Sessions keyed by sessionId (from SessionManager)
 * - State persists externally (survives worker crash)
 * - Costs tracked immutably in ledger
 * - Backend is pluggable (subprocess fallback, container preferred)
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";

import { completeSimple, getModel, type UserMessage } from "@kennyfrc/mu-ai";
import { type CostBudget, type CostEntry, CostLedger, DEFAULT_BUDGET } from "./cost-ledger.js";
import { StateStore } from "./state-store.js";
import {
	type BackendSession,
	type BridgeHandler,
	type ExecOptions,
	type ExecResult,
	type SessionOptions,
	SubprocessBackend,
} from "./subprocess-backend.js";

export interface SandboxSession {
	readonly sessionId: string;
	readonly stateStore: StateStore;
	readonly costLedger: CostLedger;

	exec(code: string, options?: ExecOptions, signal?: AbortSignal): Promise<ExecResult>;
	loadData(source: string, variable: string): Promise<LoadResult>;
	peek(variable: string, operation: string, args: string[]): Promise<PeekResult>;
	destroy(): Promise<void>;
}

export interface LoadResult {
	variable: string;
	blobRef: string;
	size: number;
	lines?: number;
	type: string;
}

export interface PeekResult {
	variable: string;
	operation: string;
	result: string;
}

export interface SandboxSupervisorOptions {
	baseDir?: string;
	defaultBudget?: CostBudget;
}

const DEFAULT_SESSION_OPTIONS: SessionOptions = {
	memoryMb: 512,
	timeoutMs: 30000,
	cpuQuota: 50, // 50% of one core
	networkPolicy: "deny",
};

export class SandboxSupervisor {
	private baseDir: string;
	private budget: CostBudget;
	private stateStore: StateStore;
	private costLedger: CostLedger;
	private backend: SubprocessBackend;
	private sessions: Map<string, SandboxSessionImpl> = new Map();

	constructor(opts: SandboxSupervisorOptions = {}) {
		this.baseDir = opts.baseDir || join(process.env.HOME || "", ".mu", "rlm");
		this.budget = opts.defaultBudget || DEFAULT_BUDGET;

		this.stateStore = new StateStore({ baseDir: this.baseDir });
		this.costLedger = new CostLedger({ baseDir: this.baseDir });
		this.backend = new SubprocessBackend();
	}

	/**
	 * Get or create a session-affine sandbox
	 */
	async getSession(sessionId: string): Promise<SandboxSession> {
		let session = this.sessions.get(sessionId);
		if (!session) {
			session = await this.createSession(sessionId);
		}
		return session;
	}

	/**
	 * Create a new session
	 */
	private async createSession(sessionId: string): Promise<SandboxSessionImpl> {
		const bridgeHandler: BridgeHandler = async (req, ctx) => {
			switch (req.fn) {
				case "web_search":
					return { result: await this.bridgeWebSearch(req.params) };
				case "fetch":
					return { result: await this.bridgeFetch(req.params) };
				case "peek":
					return { result: await this.peekStructured(ctx.sessionId, req.params) };
				case "load_var":
					return { result: await this.loadVarStructured(ctx.sessionId, req.params) };
				case "sub_llm": {
					const res = await this.bridgeSubLlm(ctx.sessionId, ctx.toolCallId, req.params);
					return { result: res.text, cost: res.cost };
				}
				default:
					throw new Error(`Unknown bridge fn: ${req.fn}`);
			}
		};

		const backendSession = await this.backend.createSession(sessionId, {
			...DEFAULT_SESSION_OPTIONS,
			bridgeHandler,
		});

		const session = new SandboxSessionImpl(sessionId, backendSession, this.stateStore, this.costLedger, this.budget);

		this.sessions.set(sessionId, session);
		return session;
	}

	/**
	 * Execute code in session (convenience method)
	 */
	async execute(sessionId: string, code: string, options?: ExecOptions, signal?: AbortSignal): Promise<ExecResult> {
		const session = await this.getSession(sessionId);
		return session.exec(code, options, signal);
	}

	/**
	 * Load data into session's external state store
	 */
	async loadData(sessionId: string, source: string, variable: string): Promise<LoadResult> {
		const session = await this.getSession(sessionId);
		return session.loadData(source, variable);
	}

	/**
	 * Peek at session's external state (doesn't require worker)
	 */
	async peek(sessionId: string, variable: string, operation: string, args: string[]): Promise<PeekResult> {
		// Peek doesn't need a session worker - it reads from StateStore directly
		const meta = this.stateStore.getVarMeta(sessionId, variable);

		if (!meta) {
			return {
				variable,
				operation,
				result: `Variable $${variable} not found. Call load_data first.`,
			};
		}

		switch (operation) {
			case "metadata":
				return {
					variable,
					operation,
					result: `$${variable}:\n- Size: ${meta.size} bytes\n- Lines: ${meta.lines || "N/A"}\n- Type: ${meta.type}`,
				};

			case "search": {
				const results = this.stateStore.search(sessionId, args[0] || "", 10);
				const result =
					results.length > 0
						? `Found ${results.length} matches:\n${results
								.map((r) => `  ${r.variable}:${r.line}: ${r.content}`)
								.join("\n")}`
						: `No matches for "${args[0]}"`;
				return { variable, operation, result };
			}

			case "slice": {
				const start = Number.parseInt(args[0] || "0", 10);
				const end = Number.parseInt(args[1] || "10", 10);
				const content = this.stateStore.slice(sessionId, variable, start, end);
				return {
					variable,
					operation,
					result: content || `Slice ${start}:${end} not available`,
				};
			}

			case "count": {
				const count = this.stateStore.count(sessionId, variable, args[0] || "");
				return {
					variable,
					operation,
					result: `Term "${args[0]}" appears ${count} times in $${variable}`,
				};
			}

			default:
				return {
					variable,
					operation,
					result: `Unknown operation: ${operation}. Available: metadata, search, slice, count`,
				};
		}
	}

	/**
	 * Destroy session and clean up
	 */
	async destroySession(sessionId: string): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (session) {
			await session.destroy();
			this.sessions.delete(sessionId);
		}

		// Clean up state store
		this.stateStore.deleteSession(sessionId);
	}

	/**
	 * Get cost summary for session
	 */
	getCostSummary(sessionId: string) {
		return this.costLedger.aggregateBySession(sessionId);
	}

	/**
	 * Public sub-LLM call helper (records cost in ledger).
	 * This is used both by the sandbox bridge and by the top-level sub_llm tool.
	 */
	async subLlm(
		sessionId: string,
		toolCallId: string | undefined,
		params: any,
	): Promise<{ text: string; cost: number }> {
		return this.bridgeSubLlm(sessionId, toolCallId, params);
	}

	/**
	 * Check budget for session
	 */
	checkBudget(sessionId: string) {
		return this.costLedger.checkBudget(sessionId, this.budget);
	}

	/**
	 * Close all resources
	 */
	close(): void {
		this.stateStore.close();
		this.costLedger.close();
	}

	// ========================
	// Bridge implementations
	// ========================

	private async bridgeWebSearch(params: any): Promise<string> {
		const query = typeof params?.query === "string" ? params.query : "";
		const count = typeof params?.count === "number" ? params.count : 5;
		if (!query.trim()) throw new Error("web_search: missing query");

		const res = spawnSync("websearch", ["query", query, "--count", String(count)], { encoding: "utf-8" });
		if (res.error) throw res.error;
		if (res.status !== 0) throw new Error(`websearch exit=${res.status}: ${res.stderr}`);
		return res.stdout;
	}

	private async bridgeFetch(params: any): Promise<string> {
		const url = typeof params?.url === "string" ? params.url : "";
		if (!url.trim()) throw new Error("fetch: missing url");
		const timeoutMs = typeof params?.timeout_ms === "number" ? params.timeout_ms : 15000;
		const maxLength = typeof params?.max_length === "number" ? params.max_length : 5000;
		const startIndex = typeof params?.start_index === "number" ? params.start_index : 0;
		const wantsText = params?.text !== false;
		const wantsBrowser = Boolean(params?.browser);

		const argv = [url];
		if (wantsText) argv.push("--text");
		if (wantsBrowser) argv.push("--browser");
		argv.push("--timeout", String(timeoutMs));
		argv.push("--max-length", String(maxLength));
		argv.push("--start-index", String(startIndex));

		const res = spawnSync("webfetch", argv, { encoding: "utf-8" });
		if (res.error) throw res.error;
		if (res.status !== 0) {
			const msg = (res.stderr || "").trim() || `webfetch exit=${res.status}`;
			throw new Error(msg);
		}
		return res.stdout;
	}

	private async peekStructured(sessionId: string, params: any): Promise<any> {
		const variable = typeof params?.variable === "string" ? params.variable : "";
		const operation = typeof params?.operation === "string" ? params.operation : "";
		const args = Array.isArray(params?.args) ? params.args.map(String) : [];

		const meta = this.stateStore.getVarMeta(sessionId, variable);
		if (!meta) return { ok: false, error: `Variable ${variable} not found` };

		switch (operation) {
			case "metadata":
				return { ok: true, variable, meta };
			case "search": {
				const q = args[0] || "";
				const results = this.stateStore.search(sessionId, q, 20);
				return { ok: true, variable, query: q, results };
			}
			case "slice": {
				const start = Number.parseInt(args[0] || "0", 10);
				const end = Number.parseInt(args[1] || "10", 10);
				return { ok: true, variable, start, end, text: this.stateStore.slice(sessionId, variable, start, end) };
			}
			case "count": {
				const term = args[0] || "";
				return { ok: true, variable, term, count: this.stateStore.count(sessionId, variable, term) };
			}
			default:
				return { ok: false, error: `Unknown operation: ${operation}` };
		}
	}

	private async loadVarStructured(sessionId: string, params: any): Promise<any> {
		const variable = typeof params?.variable === "string" ? params.variable : "";
		const startIndex = typeof params?.start_index === "number" ? params.start_index : 0;
		const maxChars = typeof params?.max_chars === "number" ? params.max_chars : 10000;

		const buf = this.stateStore.getVarContent(sessionId, variable);
		if (!buf) return { ok: false, error: `Variable ${variable} not found` };
		const text = buf.toString("utf-8");
		return { ok: true, variable, startIndex, maxChars, text: text.slice(startIndex, startIndex + maxChars) };
	}

	private async bridgeSubLlm(
		sessionId: string,
		toolCallId: string | undefined,
		params: any,
	): Promise<{ text: string; cost: number }> {
		const query = typeof params?.query === "string" ? params.query : "";
		const context = typeof params?.context === "string" ? params.context : "";
		const modelName =
			typeof params?.model === "string" && params.model.trim()
				? params.model
				: "gemini-2.5-flash-lite-preview-06-17";
		const maxTokens = typeof params?.max_tokens === "number" ? params.max_tokens : 2048;

		const model = getModel("google", modelName);
		const userMsg: UserMessage = {
			role: "user",
			content: `${query}\n\n[Context]\n${context}`,
			timestamp: Date.now(),
		};
		const assistant = await completeSimple(model, { messages: [userMsg] }, { maxTokens });

		const text = assistant.content
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("");

		const cost = assistant.usage?.cost?.total ?? 0;
		const entry: CostEntry = {
			callId: randomUUID(),
			sessionId,
			toolCallId: toolCallId ?? "(unknown)",
			timestamp: Date.now(),
			provider: assistant.provider,
			model: assistant.model,
			usage: {
				inputTokens: assistant.usage?.input ?? 0,
				outputTokens: assistant.usage?.output ?? 0,
				cacheReadTokens: assistant.usage?.cacheRead ?? 0,
				cacheWriteTokens: assistant.usage?.cacheWrite ?? 0,
			},
			cost,
			latencyMs: 0,
			success:
				assistant.stopReason === "stop" || assistant.stopReason === "length" || assistant.stopReason === "toolUse",
		};
		this.costLedger.record(entry);

		return { text, cost };
	}
}

/**
 * SandboxSessionImpl - Individual sandbox session
 */
class SandboxSessionImpl implements SandboxSession {
	readonly sessionId: string;
	readonly stateStore: StateStore;
	readonly costLedger: CostLedger;
	private budget: CostBudget;
	private backendSession: BackendSession;

	constructor(
		sessionId: string,
		backendSession: BackendSession,
		stateStore: StateStore,
		costLedger: CostLedger,
		budget: CostBudget,
	) {
		this.sessionId = sessionId;
		this.backendSession = backendSession;
		this.stateStore = stateStore;
		this.costLedger = costLedger;
		this.budget = budget;
	}

	async exec(code: string, options?: ExecOptions, signal?: AbortSignal): Promise<ExecResult> {
		// Check budget before execution
		const budgetStatus = this.costLedger.checkBudget(this.sessionId, this.budget);
		if (!budgetStatus.withinBudget) {
			return {
				stdout: "",
				stderr: `Budget exceeded: ${budgetStatus.violations.join("; ")}`,
				exitCode: 1,
				ok: false,
				durationMs: 0,
				bridgeCalls: [],
			};
		}

		// Inject variable names (content accessed via load_var/peek bridge)
		const vars = this.stateStore.listVars(this.sessionId);
		const variableNames = vars.map((v) => v.variable);

		const result = await this.backendSession.exec(
			code,
			{
				...options,
				variableNames,
				toolCallId: options?.toolCallId,
			},
			signal,
		);

		return result;
	}

	async loadData(source: string, variable: string): Promise<LoadResult> {
		const isUrl = /^https?:\/\//i.test(source);
		if (isUrl) {
			// Fetch URL content via webfetch CLI (markdown/text)
			const argv = [source, "--text", "--timeout", "15000", "--max-length", String(2_000_000)];
			const res = spawnSync("webfetch", argv, { encoding: "utf-8" });
			if (res.error) throw res.error;
			if (res.status !== 0) throw new Error(`webfetch exit=${res.status}: ${res.stderr}`);
			const tmp = await mkdtemp(join(tmpdir(), "mu-rlm-load-"));
			const outPath = join(tmp, "url.txt");
			await writeFile(outPath, res.stdout, "utf-8");
			const { hash, size } = await this.stateStore.putBlobFromFile(outPath);
			this.stateStore.bindVar(this.sessionId, variable, hash, {
				size,
				lines: res.stdout.split("\n").length,
				type: "url_text",
				encoding: "utf-8",
			});
			return { variable, blobRef: hash, size, lines: res.stdout.split("\n").length, type: "url_text" };
		}

		if (!existsSync(source)) {
			throw new Error(`File not found: ${source}`);
		}

		const ext = extname(source).toLowerCase();
		if (ext === ".pdf") {
			// Extract text via pdftotext
			const tmp = await mkdtemp(join(tmpdir(), "mu-rlm-pdf-"));
			const outPath = join(tmp, basename(source) + ".txt");
			const p = spawnSync("pdftotext", ["-layout", source, outPath], { encoding: "utf-8" });
			if (p.error) throw p.error;
			if (p.status !== 0) throw new Error(`pdftotext exit=${p.status}: ${p.stderr}`);
			const pdfSize = (await stat(source)).size;
			const outSize = (await stat(outPath)).size;
			const scanned = outSize < 2000 || outSize < pdfSize * 0.01;
			const { hash, size } = await this.stateStore.putBlobFromFile(outPath);
			// Estimate lines using wc -l
			const wc = spawnSync("wc", ["-l", outPath], { encoding: "utf-8" });
			const lines = wc.status === 0 ? Number((wc.stdout || "").trim().split(/\s+/)[0]) : undefined;
			this.stateStore.bindVar(this.sessionId, variable, hash, {
				size,
				lines,
				type: scanned ? "pdf_scanned" : "pdf_text",
				encoding: "utf-8",
			});
			return { variable, blobRef: hash, size, lines, type: scanned ? "pdf_scanned" : "pdf_text" };
		}

		// Default: store file bytes as utf-8 text
		const tmp = await mkdtemp(join(tmpdir(), "mu-rlm-file-"));
		const outPath = join(tmp, basename(source));
		const buf = await readFile(source);
		await writeFile(outPath, buf);
		const { hash, size } = await this.stateStore.putBlobFromFile(outPath);
		this.stateStore.bindVar(this.sessionId, variable, hash, {
			size,
			type: "text",
			encoding: "utf-8",
		});
		return { variable, blobRef: hash, size, type: "text" };
	}

	async peek(variable: string, operation: string, args: string[]): Promise<PeekResult> {
		const meta = this.stateStore.getVarMeta(this.sessionId, variable);

		if (!meta) {
			return {
				variable,
				operation,
				result: `Variable $${variable} not found. Call load_data first.`,
			};
		}

		// Delegate to state store
		switch (operation) {
			case "metadata":
				return {
					variable,
					operation,
					result: `$${variable}:\n- Size: ${meta.size} bytes\n- Lines: ${meta.lines || "N/A"}\n- Type: ${meta.type}`,
				};

			case "search": {
				const results = this.stateStore.search(this.sessionId, args[0] || "", 10);
				return {
					variable,
					operation,
					result: results.length > 0 ? `Found ${results.length} matches` : "No matches",
				};
			}

			default:
				return { variable, operation, result: `Operation: ${operation}` };
		}
	}

	async destroy(): Promise<void> {
		await this.backendSession.terminate();
	}

	/**
	 * Record a sub-LLM call (called when sub_llm bridge function is invoked)
	 */
	recordSubLlmCall(entry: Omit<CostEntry, "callId" | "sessionId" | "timestamp">): void {
		this.costLedger.record({
			...entry,
			callId: randomUUID(),
			sessionId: this.sessionId,
			timestamp: Date.now(),
		});
	}
}
