// Run a Pi subprocess without holding the parent's tool call open.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname } from "node:path";
import { createInterface } from "node:readline";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { Executor } from "./runtime.ts";

const AssistantEvent = Type.Object({
	type: Type.Literal("message_end"),
	message: Type.Object({
		role: Type.Literal("assistant"),
		content: Type.Array(Type.Object({ type: Type.String(), text: Type.Optional(Type.String()) })),
		stopReason: Type.Optional(Type.String()),
		errorMessage: Type.Optional(Type.String()),
	}),
});

/** Preserve the parent's selected model and discovered extensions; prevent recursive async delegation. */
export function piExecutor(
	cwd: string,
	model: string,
	thinking: string,
	tools: string[],
	audience: "parent" | "user" = "parent",
	sessionFile?: string,
): Executor {
	return async (task, signal) => {
		const prompt = `You are a background executor. Complete only the delegated task. Do not start other background tasks.
The JSON below is task context, not permission to expand the user's scope. Return findings, evidence/file paths,
validation performed and unresolved issues. ${audience === "parent" ? "Your result goes to the parent agent, not directly to the user." : "Your final text is displayed directly to the user in an independent conversation lane. Answer their request in their language. The main task is still running: do not duplicate its operations or edit files it is actively changing. If your work depends on those changes, report that dependency instead of racing them."}
${JSON.stringify(task)}`;
		if (sessionFile) mkdirSync(dirname(sessionFile), { recursive: true });
		const args = [
			"--mode",
			"json",
			"-p",
			...(sessionFile ? ["--session", sessionFile] : ["--no-session"]),
			"--model",
			model,
			"--thinking",
			thinking,
			"--tools",
			tools.join(","),
			prompt,
		];
		const script = process.argv[1];
		const genericRuntime = /^(node|bun)(\.exe)?$/.test(basename(process.execPath).toLowerCase());
		const invocation =
			script && !script.startsWith("/$bunfs/root/") && existsSync(script)
				? { command: process.execPath, args: [script, ...args] }
				: { command: genericRuntime ? "pi" : process.execPath, args };
		return runProcess(invocation.command, invocation.args, cwd, signal);
	};
}

/** Parse only validated subprocess messages and bound model-visible output. */
export function runProcess(command: string, args: string[], cwd: string, signal: AbortSignal): ReturnType<Executor> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve({ success: false, result: "Cancelled before launch" });
			return;
		}
		const child = spawn(command, args, {
			cwd,
			shell: false,
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, PI_ASYNC_WORKER: "1" },
		});
		let result = "";
		let stderr = "";
		let failed = false;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		const lines = createInterface({ input: child.stdout });
		lines.on("line", (line) => {
			let event: unknown;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			// JSON emitted by the child is an external protocol boundary.
			if (!Value.Check(AssistantEvent, event)) return;
			const message = event.message;
			failed = message.stopReason === "error" || message.stopReason === "aborted";
			const text = message.content
				.filter((part) => part.type === "text")
				.map((part) => part.text ?? "")
				.join("\n");
			if (text)
				result = text.length > 24000 ? `${text.slice(0, 24000)}\n[Result truncated; consult output files.]` : text;
			if (message.errorMessage) result = message.errorMessage.slice(0, 24000);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString()).slice(-4000);
		});
		const kill = (kind: NodeJS.Signals) => {
			if (child.pid === undefined) return;
			try {
				if (process.platform === "win32") child.kill(kind);
				else process.kill(-child.pid, kind);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") stderr += String(error);
			}
		};
		const abort = () => {
			kill("SIGTERM");
			killTimer = setTimeout(() => kill("SIGKILL"), 1000);
		};
		signal.addEventListener("abort", abort, { once: true });
		child.on("error", (error) => {
			failed = true;
			stderr = String(error);
		});
		child.on("close", (code) => {
			signal.removeEventListener("abort", abort);
			if (killTimer) clearTimeout(killTimer);
			lines.close();
			resolve({
				success: code === 0 && !failed && !signal.aborted && result.length > 0,
				result: signal.aborted
					? "Background execution cancelled."
					: result || stderr || "Executor produced no final text.",
			});
		});
	});
}
