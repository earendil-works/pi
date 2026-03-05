/**
 * SubprocessBackend - Python sandbox backend (local subprocess)
 *
 * This backend focuses on two things:
 * 1) Make PTC/RLM *useful now*: Python code can call web_search/fetch/peek/sub_llm synchronously.
 * 2) Make it as safe as a subprocess backend reasonably can be.
 *
 * Security notes (important):
 * - This is NOT equivalent to container/microVM isolation.
 * - We apply static pre-checks and runtime guardrails, but a determined attacker may still escape.
 * - Treat this as "trusted-local" until a ContainerBackend lands.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ExecOptions {
	/** Kill the python process if it runs longer than this. */
	timeoutMs?: number;
	/** Informational only for now (true memory limiting requires OS/container support). */
	memoryMb?: number;
	/** Variable names to inject into Python as strings (e.g. doc="doc"). */
	variableNames?: string[];
	/** Parent tool call ID (for cost ledger attribution). */
	toolCallId?: string;
}

export interface ExecResult {
	/** User-visible stdout (may be empty if code returns a value). */
	stdout: string;
	/** User-visible stderr (bridge protocol lines removed). */
	stderr: string;
	exitCode: number;
	ok: boolean;
	durationMs: number;
	bridgeCalls: BridgeCall[];
	/** Final return value from the code (preferred output). */
	result?: unknown;
}

export interface BridgeCall {
	fn: string;
	params: unknown;
	result: unknown;
	durationMs: number;
	cost?: number;
}

export type BridgeRequest = { fn: string; params: any; id: string };

export type BridgeHandler = (
	req: { fn: string; params: any },
	ctx: { sessionId: string; toolCallId?: string },
) => Promise<{ result: unknown; cost?: number }>;

export interface SessionOptions {
	timeoutMs: number;
	memoryMb: number;
	cpuQuota: number;
	networkPolicy: "deny" | "allow-list";
	allowedDomains?: string[];
	bridgeHandler?: BridgeHandler;
}

export interface BackendSession {
	exec(code: string, options: ExecOptions, signal?: AbortSignal): Promise<ExecResult>;
	terminate(): Promise<void>;
}

const CALL_PREFIX = "__MU_BRIDGE_CALL__";
const RESULT_PREFIX = "__MU_BRIDGE_RESULT__";
const FINAL_PREFIX = "__MU_FINAL_RESULT__";

// Security: best-effort static checks
const BLOCKED_IMPORTS = [
	"subprocess",
	"socket",
	"requests",
	"urllib",
	"http.client",
	"ftplib",
	"smtplib",
	"telnetlib",
	"pexpect",
	"ctypes",
];

const BLOCKED_PATTERNS: RegExp[] = [
	/\bexec\s*\(/,
	/\beval\s*\(/,
	/\bcompile\s*\(/,
	/\b__import__\s*\(/,
	/\binput\s*\(/,
	/\bos\.system\s*\(/,
	/\bos\.popen\s*\(/,
	/\bsubprocess\./,
];

function preCheckCode(code: string): { ok: boolean; violations: string[] } {
	const violations: string[] = [];
	for (const imp of BLOCKED_IMPORTS) {
		const re1 = new RegExp(`^\\s*import\\s+${imp}(\\s|$)`, "m");
		const re2 = new RegExp(`^\\s*from\\s+${imp}(\\s|$)`, "m");
		if (re1.test(code) || re2.test(code)) violations.push(`Blocked import: ${imp}`);
	}
	for (const pat of BLOCKED_PATTERNS) {
		if (pat.test(code)) violations.push(`Blocked pattern: ${pat}`);
	}
	return { ok: violations.length === 0, violations };
}

function buildPythonRunner(): string {
	// Runner protocol:
	// - bridge calls go to stderr as: CALL_PREFIX + JSON + "\n"
	// - host replies on stdin as: RESULT_PREFIX + JSON + "\n"
	// - final return value goes to stderr as: FINAL_PREFIX + JSON + "\n"
	return `
import builtins
import json
import os
import sys
import traceback
import uuid

CALL_PREFIX = ${JSON.stringify(CALL_PREFIX)}
RESULT_PREFIX = ${JSON.stringify(RESULT_PREFIX)}
FINAL_PREFIX = ${JSON.stringify(FINAL_PREFIX)}

def _blocked(*args, **kwargs):
    raise RuntimeError("blocked")

# Basic runtime hardening (best-effort)
builtins.input = _blocked

def _bridge_call(fn, params):
    call_id = str(uuid.uuid4())
    payload = {"id": call_id, "fn": fn, "params": params}
    sys.stderr.write(CALL_PREFIX + json.dumps(payload, ensure_ascii=False) + "\\n")
    sys.stderr.flush()
    while True:
        line = sys.stdin.readline()
        if not line:
            raise RuntimeError("bridge EOF")
        if not line.startswith(RESULT_PREFIX):
            continue
        msg = json.loads(line[len(RESULT_PREFIX):])
        if msg.get("id") != call_id:
            continue
        if msg.get("ok"):
            return msg.get("result")
        raise RuntimeError(msg.get("error") or "bridge error")

def web_search(query, count=5, country=None, lang=None):
    return _bridge_call("web_search", {"query": query, "count": count, "country": country, "lang": lang})

def fetch(url, text=True, browser=False, timeout_ms=15000, max_length=5000, start_index=0):
    return _bridge_call("fetch", {"url": url, "text": text, "browser": browser, "timeout_ms": timeout_ms, "max_length": max_length, "start_index": start_index})

def peek(variable, operation, args=None):
    return _bridge_call("peek", {"variable": variable, "operation": operation, "args": args or []})

def load_var(variable, start_index=0, max_chars=10000):
    return _bridge_call("load_var", {"variable": variable, "start_index": start_index, "max_chars": max_chars})

def sub_llm(query, context, model=None, max_tokens=2048):
    return _bridge_call("sub_llm", {"query": query, "context": context, "model": model, "max_tokens": max_tokens})

vars_json = os.environ.get("MU_VARS_JSON") or "[]"
try:
    var_names = json.loads(vars_json)
except Exception:
    var_names = []

for name in var_names:
    if isinstance(name, str) and name.isidentifier():
        globals()[name] = name

code_path = os.environ.get("MU_CODE_PATH")
if not code_path:
    raise RuntimeError("MU_CODE_PATH not set")

with open(code_path, "r", encoding="utf-8") as f:
    user_code = f.read()

# Make return usable by wrapping the user code in a function.
indented = "\\n".join(["    " + line for line in user_code.splitlines()])
wrapped = "def __mu_user_main():\\n" + (indented if indented.strip() else "    pass") + "\\n"

try:
    exec(wrapped, globals(), globals())
    ret = __mu_user_main()
    # Return value is the preferred output (so callers can avoid printing intermediate stuff)
    try:
        payload = {"ok": True, "result": ret}
        sys.stderr.write(FINAL_PREFIX + json.dumps(payload, ensure_ascii=False) + "\\n")
        sys.stderr.flush()
    except Exception:
        payload = {"ok": True, "result": str(ret)}
        sys.stderr.write(FINAL_PREFIX + json.dumps(payload, ensure_ascii=False) + "\\n")
        sys.stderr.flush()
except SystemExit:
    raise
except Exception:
    traceback.print_exc(file=sys.stderr)
    payload = {"ok": False, "error": "exception"}
    sys.stderr.write(FINAL_PREFIX + json.dumps(payload, ensure_ascii=False) + "\\n")
    sys.stderr.flush()
`;
}

function splitLines(chunk: string, carry: string): { lines: string[]; carry: string } {
	const s = carry + chunk;
	const parts = s.split("\n");
	const nextCarry = parts.pop() ?? "";
	return { lines: parts, carry: nextCarry };
}

export class SubprocessBackend {
	readonly name = "subprocess";
	readonly isolation = "weak" as const;

	private sessions = new Map<string, SubprocessSession>();

	async createSession(sessionId: string, options: SessionOptions): Promise<BackendSession> {
		const session = new SubprocessSession(sessionId, options);
		this.sessions.set(sessionId, session);
		return session;
	}

	async destroySession(sessionId: string): Promise<void> {
		const s = this.sessions.get(sessionId);
		if (s) {
			await s.terminate();
			this.sessions.delete(sessionId);
		}
	}

	async healthCheck(sessionId: string): Promise<boolean> {
		return this.sessions.get(sessionId)?.isHealthy() ?? false;
	}
}

class SubprocessSession implements BackendSession {
	private healthy = true;
	private sessionId: string;
	private options: SessionOptions;

	constructor(sessionId: string, options: SessionOptions) {
		this.sessionId = sessionId;
		this.options = options;
	}

	async exec(code: string, options: ExecOptions = {}, signal?: AbortSignal): Promise<ExecResult> {
		const start = Date.now();
		const pre = preCheckCode(code);
		if (!pre.ok) {
			return {
				stdout: "",
				stderr: `Security violation:\n${pre.violations.join("\n")}`,
				exitCode: 1,
				ok: false,
				durationMs: Date.now() - start,
				bridgeCalls: [],
			};
		}

		const dir = mkdtempSync(join(tmpdir(), "mu-rlm-"));
		const codePath = join(dir, "code.py");
		writeFileSync(codePath, code, "utf-8");

		const runner = buildPythonRunner();
		const timeoutMs = options.timeoutMs ?? this.options.timeoutMs;
		const varNames = options.variableNames ?? [];
		const toolCallId = options.toolCallId;
		const handler = this.options.bridgeHandler;

		let child: ChildProcessWithoutNullStreams | null = null;
		let stdout = "";
		let stderrUser = "";
		const carryOut = "";
		let carryErr = "";
		let finalResult: unknown;
		let finalOk: boolean | undefined;
		const bridgeCalls: BridgeCall[] = [];

		const kill = () => {
			if (child && !child.killed) child.kill("SIGKILL");
		};

		return await new Promise<ExecResult>((resolve) => {
			const timer = setTimeout(() => {
				kill();
				stderrUser += `\nTimeout after ${timeoutMs}ms`;
			}, timeoutMs);

			child = spawn("python3", ["-I", "-S", "-u", "-c", runner], {
				env: {
					PYTHONIOENCODING: "utf-8",
					TZ: "UTC",
					MU_CODE_PATH: codePath,
					MU_VARS_JSON: JSON.stringify(varNames),
				},
			});

			signal?.addEventListener("abort", () => {
				stderrUser += "\nAborted by signal";
				kill();
			});

			child.stdout.on("data", (buf) => {
				stdout += buf.toString("utf-8");
			});

			child.stderr.on("data", async (buf) => {
				const { lines, carry } = splitLines(buf.toString("utf-8"), carryErr);
				carryErr = carry;
				for (const line of lines) {
					if (line.startsWith(CALL_PREFIX)) {
						if (!handler) {
							// No handler: reply with error
							const payload = { id: "", ok: false, error: "No bridge handler" };
							child?.stdin.write(RESULT_PREFIX + JSON.stringify(payload) + "\n");
							continue;
						}

						let req: BridgeRequest;
						try {
							req = JSON.parse(line.slice(CALL_PREFIX.length));
						} catch (e) {
							// Ignore malformed
							continue;
						}

						const t0 = Date.now();
						try {
							const res = await handler(
								{ fn: req.fn, params: req.params },
								{ sessionId: this.sessionId, toolCallId },
							);
							bridgeCalls.push({
								fn: req.fn,
								params: req.params,
								result: res.result,
								durationMs: Date.now() - t0,
								cost: res.cost,
							});
							child?.stdin.write(
								RESULT_PREFIX + JSON.stringify({ id: req.id, ok: true, result: res.result }) + "\n",
							);
						} catch (e) {
							const msg = e instanceof Error ? e.message : String(e);
							child?.stdin.write(RESULT_PREFIX + JSON.stringify({ id: req.id, ok: false, error: msg }) + "\n");
						}
						continue;
					}

					if (line.startsWith(FINAL_PREFIX)) {
						try {
							const msg = JSON.parse(line.slice(FINAL_PREFIX.length));
							if (msg && typeof msg.ok === "boolean") {
								finalOk = msg.ok;
								if (msg.ok) finalResult = msg.result;
							}
						} catch {
							// ignore
						}
						continue;
					}

					stderrUser += line + "\n";
				}
			});

			child.on("close", (exitCode) => {
				clearTimeout(timer);
				try {
					rmSync(dir, { recursive: true, force: true });
				} catch {
					// ignore
				}

				const ok = (exitCode ?? 1) === 0 && (finalOk ?? true);
				const finalExit = ok ? (exitCode ?? 0) : 1;
				resolve({
					stdout,
					stderr: stderrUser.trimEnd(),
					exitCode: finalExit,
					ok,
					durationMs: Date.now() - start,
					bridgeCalls,
					result: finalResult,
				});
			});

			child.on("error", (err) => {
				clearTimeout(timer);
				stderrUser += `\nProcess error: ${err.message}`;
				resolve({
					stdout,
					stderr: stderrUser.trimEnd(),
					exitCode: 1,
					ok: false,
					durationMs: Date.now() - start,
					bridgeCalls,
				});
			});
		});
	}

	async terminate(): Promise<void> {
		this.healthy = false;
	}

	isHealthy(): boolean {
		return this.healthy;
	}
}
