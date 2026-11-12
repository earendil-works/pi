// Own bounded extraction helpers; the project broker, not a one-shot reader, owns persistent Chromium.
import { spawn } from "node:child_process";
import { Compile } from "typebox/compile";
import { getReaderInvocation } from "../../config.ts";
import { killProcessTree, trackDetachedChildPid, untrackDetachedChildPid } from "../../utils/shell.ts";
import { borrowProjectBrowser } from "./browser-client.ts";
import { type ReaderRequest, ReaderResponseSchema, type ReaderResult } from "./protocol.ts";

const responseValidator = Compile(ReaderResponseSchema);

/** Run one read with a shared 30-second deadline, including project-browser startup and tab acquisition. */
export async function runReader(
	kind: "pdf" | "web" | "sqlite",
	input: Omit<ReaderRequest, "pdfiumWasmPath">,
	signal?: AbortSignal,
): Promise<ReaderResult> {
	signal?.throwIfAborted();
	const deadline = AbortSignal.timeout(30_000);
	const operation = signal ? AbortSignal.any([signal, deadline]) : deadline;
	const timeoutMessage = "Reader exceeded its 30-second deadline; narrow the document pages or SQL query";
	let tab: Awaited<ReturnType<typeof borrowProjectBrowser>> | undefined;
	try {
		if (kind === "web" && input.strategy === "browser") {
			if (input.pages || input.format === "images")
				throw new Error("Browser strategy extracts HTML; use auto for PDF URLs");
			tab = await borrowProjectBrowser(
				input.browserProjectDir ?? process.cwd(),
				input.browserExecutablePath,
				operation,
			);
		}
		operation.throwIfAborted();
		return await runReaderProcess(kind, { ...input, browserConnection: tab?.connection }, operation, () =>
			deadline.aborted ? new Error(timeoutMessage) : new Error("Read operation aborted"),
		);
	} catch (error) {
		if (deadline.aborted) throw new Error(timeoutMessage);
		throw error;
	} finally {
		tab?.release();
	}
}

function runReaderProcess(
	kind: "pdf" | "web" | "sqlite",
	input: Omit<ReaderRequest, "pdfiumWasmPath">,
	signal: AbortSignal,
	abortError: () => Error,
): Promise<ReaderResult> {
	const invocation = getReaderInvocation(kind);
	return new Promise((resolve, reject) => {
		const child = spawn(invocation.executable, invocation.args, {
			detached: true,
			windowsHide: true,
			stdio: ["ignore", "ignore", "pipe", "ipc"],
			serialization: "advanced",
			env: invocation.bunBinary ? { ...process.env, BUN_BE_BUN: "1" } : process.env,
		});
		if (child.pid) trackDetachedChildPid(child.pid);
		let settled = false;
		let diagnostic = "";
		child.stderr?.on("data", (chunk: Buffer) => {
			if (diagnostic.length < 8192) diagnostic += chunk.toString("utf8").slice(0, 8192 - diagnostic.length);
		});
		const finish = (error?: Error, result?: ReaderResult) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", abort);
			if (child.pid) {
				killProcessTree(child.pid);
				untrackDetachedChildPid(child.pid);
			}
			if (error) reject(error);
			else resolve(result!);
		};
		const abort = () => finish(abortError());
		signal.addEventListener("abort", abort, { once: true });
		child.once("error", (error) => finish(error));
		child.once("exit", (code, exitSignal) =>
			finish(
				new Error(
					`Reader exited before returning a result (${exitSignal ?? code})${diagnostic.trim() ? `: ${diagnostic.trim()}` : ""}`,
				),
			),
		);
		child.on("message", (message: unknown) => {
			if (settled) return;
			// The isolated helper's IPC response is a wire boundary.
			if (!responseValidator.Check(message)) {
				finish(new Error("Invalid reader response"));
				return;
			}
			if (message.ok) finish(undefined, message.result);
			else finish(new Error(message.error));
		});
		child.send({ ...input, pdfiumWasmPath: invocation.wasmPath }, (error) => {
			if (error) finish(error);
		});
		if (signal.aborted) abort();
	});
}
