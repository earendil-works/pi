import type { AgentTool } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { spawn } from "child_process";
import { existsSync } from "fs";
import { getToolDescription } from "../prompts/index.js";

const MAX_OUTPUT_BYTES = 65536;

/**
 * Truncate output to MAX_OUTPUT_BYTES with a warning if exceeded
 */
function truncateOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf-8");
	if (byteLength <= MAX_OUTPUT_BYTES) {
		return output;
	}
	// Truncate by characters, then verify byte length
	// Start with a rough estimate based on ratio
	let truncated = output.slice(0, Math.floor((MAX_OUTPUT_BYTES / byteLength) * output.length));
	// Adjust if still over (can happen with multi-byte chars)
	while (Buffer.byteLength(truncated, "utf-8") > MAX_OUTPUT_BYTES && truncated.length > 0) {
		truncated = truncated.slice(0, -100);
	}
	return `${truncated}\n\n... (output truncated from ${byteLength} to ${MAX_OUTPUT_BYTES} bytes)`;
}

/**
 * Get shell configuration based on platform
 */
function getShellConfig(): { shell: string; args: string[] } {
	if (process.platform === "win32") {
		const paths: string[] = [];
		const programFiles = process.env.ProgramFiles;
		if (programFiles) {
			paths.push(`${programFiles}\\Git\\bin\\bash.exe`);
		}
		const programFilesX86 = process.env["ProgramFiles(x86)"];
		if (programFilesX86) {
			paths.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
		}

		for (const path of paths) {
			if (existsSync(path)) {
				return { shell: path, args: ["-c"] };
			}
		}

		throw new Error(
			`Git Bash not found. Please install Git for Windows from https://git-scm.com/download/win\n` +
				`Searched in:\n${paths.map((p) => `  ${p}`).join("\n")}`,
		);
	}
	return { shell: "sh", args: ["-c"] };
}

/**
 * Kill a process and all its children
 */
function killProcessTree(pid: number): void {
	if (process.platform === "win32") {
		// Use taskkill on Windows to kill process tree
		try {
			spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
				stdio: "ignore",
				detached: true,
			});
		} catch (e) {
			// Ignore errors if taskkill fails
		}
	} else {
		// Use SIGKILL on Unix/Linux/Mac
		try {
			process.kill(-pid, "SIGKILL");
		} catch (e) {
			// Fallback to killing just the child if process group kill fails
			try {
				process.kill(pid, "SIGKILL");
			} catch (e2) {
				// Process already dead
			}
		}
	}
}

const DEFAULT_TIMEOUT = 10 * 60; // 10 minutes in seconds

const bashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default: 600 seconds / 10 minutes)" })),
});

export const bashTool: AgentTool<typeof bashSchema> = {
	name: "bash",
	label: "bash",
	description: getToolDescription("bash"),
	parameters: bashSchema,
	execute: async (
		_toolCallId: string,
		{ command, timeout }: { command: string; timeout?: number },
		signal?: AbortSignal,
	) => {
		return new Promise((resolve, _reject) => {
			const { shell, args } = getShellConfig();
			const child = spawn(shell, [...args, command], {
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
			});

			let stdout = "";
			let stderr = "";
			let timedOut = false;

			child.on("error", (err) => {
				_reject(err instanceof Error ? err : new Error(String(err)));
			});

			const effectiveTimeout = timeout ?? DEFAULT_TIMEOUT;
			let timeoutHandle: NodeJS.Timeout | undefined;
			if (effectiveTimeout > 0) {
				timeoutHandle = setTimeout(() => {
					timedOut = true;
					onAbort();
				}, effectiveTimeout * 1000);
			}

			if (child.stdout) {
				child.stdout.on("data", (data) => {
					stdout += data.toString();
					if (stdout.length > 10 * 1024 * 1024) {
						stdout = stdout.slice(0, 10 * 1024 * 1024);
					}
				});
			}

			if (child.stderr) {
				child.stderr.on("data", (data) => {
					stderr += data.toString();
					if (stderr.length > 10 * 1024 * 1024) {
						stderr = stderr.slice(0, 10 * 1024 * 1024);
					}
				});
			}

			child.on("close", (code) => {
				if (timeoutHandle) {
					clearTimeout(timeoutHandle);
				}
				if (signal) {
					signal.removeEventListener("abort", onAbort);
				}

				if (signal?.aborted) {
					let output = "";
					if (stdout) output += stdout;
					if (stderr) {
						if (output) output += "\n";
						output += stderr;
					}
					if (output) output += "\n\n";
					output += "Command aborted";
					_reject(new Error(truncateOutput(output)));
					return;
				}

				if (timedOut) {
					let output = "";
					if (stdout) output += stdout;
					if (stderr) {
						if (output) output += "\n";
						output += stderr;
					}
					if (output) output += "\n\n";
					output += `Command timed out after ${effectiveTimeout} seconds`;
					_reject(new Error(truncateOutput(output)));
					return;
				}

				let output = "";
				if (stdout) output += stdout;
				if (stderr) {
					if (output) output += "\n";
					output += stderr;
				}

				if (code !== 0 && code !== null) {
					if (output) output += "\n\n";
					_reject(new Error(truncateOutput(`${output}Command exited with code ${code}`)));
				} else {
					resolve({
						content: [{ type: "text", text: truncateOutput(output) || "(no output)" }],
						details: undefined,
					});
				}
			});

			// Handle abort signal - kill entire process tree
			const onAbort = () => {
				if (child.pid) {
					killProcessTree(child.pid);
				}
			};

			if (signal) {
				if (signal.aborted) {
					onAbort();
				} else {
					signal.addEventListener("abort", onAbort, { once: true });
				}
			}
		});
	},
};
