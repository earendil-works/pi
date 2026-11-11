// Own each bounded reader process and any Chromium process group it explicitly reports.
import { spawn } from "node:child_process";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { getReaderInvocation } from "../../config.ts";
import { killProcessTree, trackDetachedChildPid, untrackDetachedChildPid } from "../../utils/shell.ts";
import { type ReaderRequest, ReaderResponseSchema, type ReaderResult } from "./protocol.ts";

const responseValidator = Compile(ReaderResponseSchema);
const browserEventValidator = Compile(
	Type.Object(
		{
			event: Type.Union([Type.Literal("browser"), Type.Literal("browser-closed")]),
			pid: Type.Integer({ minimum: 1 }),
		},
		{ additionalProperties: false },
	),
);

/** Run one reader with a 30-second deadline and process-tree cleanup on completion or cancellation. */
export async function runReader(
	kind: "pdf" | "web" | "sqlite",
	input: Omit<ReaderRequest, "pdfiumWasmPath">,
	signal?: AbortSignal,
): Promise<ReaderResult> {
	signal?.throwIfAborted();
	const invocation = getReaderInvocation(kind);
	return new Promise((resolve, reject) => {
		const child = spawn(invocation.executable, invocation.args, {
			detached: true,
			windowsHide: true,
			stdio: ["ignore", "ignore", "pipe", "ipc"],
			serialization: "advanced",
			env: invocation.bunBinary ? { ...process.env, BUN_BE_BUN: "1" } : process.env,
		});
		const browserPids = new Set<number>();
		if (child.pid) trackDetachedChildPid(child.pid);
		let settled = false;
		let stopping: Error | undefined;
		let forced: ReturnType<typeof setTimeout> | undefined;
		let diagnostic = "";
		child.stderr?.on("data", (chunk: Buffer) => {
			if (diagnostic.length < 8192) diagnostic += chunk.toString("utf8").slice(0, 8192 - diagnostic.length);
		});
		const finish = (error?: Error, result?: ReaderResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(deadline);
			clearTimeout(forced);
			signal?.removeEventListener("abort", abort);
			for (const pid of browserPids) {
				killProcessTree(pid);
				untrackDetachedChildPid(pid);
			}
			if (child.pid) {
				killProcessTree(child.pid);
				untrackDetachedChildPid(child.pid);
			}
			if (error) reject(error);
			else resolve(result!);
		};
		const stop = (error: Error) => {
			if (settled || stopping) return;
			stopping = error;
			// Playwright installs SIGTERM cleanup before launching Chromium. Give it time to
			// remove its temporary profile, including cancellation during browser startup.
			if (kind === "web" && input.strategy === "browser") {
				child.kill("SIGTERM");
				forced = setTimeout(() => finish(error), 5000);
			} else finish(error);
		};
		const abort = () => stop(new Error("Read operation aborted"));
		const deadline = setTimeout(
			() => stop(new Error("Reader exceeded its 30-second deadline; narrow the document pages or SQL query")),
			30_000,
		);
		signal?.addEventListener("abort", abort, { once: true });
		child.once("error", (error) => finish(error));
		child.once("exit", (code, exitSignal) =>
			finish(
				stopping ??
					new Error(
						`Reader exited before returning a result (${exitSignal ?? code})${diagnostic.trim() ? `: ${diagnostic.trim()}` : ""}`,
					),
			),
		);
		child.on("message", (message: unknown) => {
			// Child IPC is a wire boundary, including separately detached browser process IDs.
			if (browserEventValidator.Check(message)) {
				if (settled) {
					if (message.event === "browser") killProcessTree(message.pid);
					return;
				}
				if (message.event === "browser") {
					browserPids.add(message.pid);
					trackDetachedChildPid(message.pid);
				} else {
					browserPids.delete(message.pid);
					untrackDetachedChildPid(message.pid);
				}
				return;
			}
			if (stopping || settled) return;
			if (!responseValidator.Check(message)) {
				stop(new Error("Invalid reader response"));
				return;
			}
			if (message.ok) finish(undefined, message.result);
			else finish(new Error(message.error));
		});
		child.send({ ...input, pdfiumWasmPath: invocation.wasmPath }, (error) => {
			if (error) finish(error);
		});
		if (signal?.aborted) abort();
	});
}
