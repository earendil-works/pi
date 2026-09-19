import { spawn } from "node:child_process";
import { Type } from "typebox";
import type { ToolDeclaration, ToolResult } from "./types.ts";

const parameters = Type.Object({ command: Type.String(), cwd: Type.Optional(Type.String()) });

/** Run a shell command. Output is piped to the kernel; bounds come from `output`. */
export function bashTool(output: ToolDeclaration["output"] = {}): ToolDeclaration<typeof parameters> {
	return {
		name: "bash",
		description: "Run a shell command",
		parameters,
		replay: "unsafe",
		output,
		async execute({ command, cwd }, api, ctx): Promise<ToolResult> {
			const started = Date.now();
			const child = spawn("bash", ["-c", command], { cwd, stdio: ["ignore", "pipe", "pipe"] });
			const onAbort = () => child.kill("SIGKILL");
			ctx.abortSignal?.addEventListener("abort", onAbort);
			child.stdout.on("data", (c: Uint8Array) => api.stream(c));
			child.stderr.on("data", (c: Uint8Array) => api.stream(c));
			const { code, signal } = await new Promise<{ code: number | null; signal: string | null }>((r) =>
				child.on("close", (code, signal) => r({ code, signal })),
			);
			ctx.abortSignal?.removeEventListener("abort", onAbort);
			return { isError: code !== 0, details: { exitCode: code, signal, ms: Date.now() - started } };
		},
	};
}
