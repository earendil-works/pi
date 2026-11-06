import { Worker } from "node:worker_threads";
import type { SessionInfo } from "../../../core/session-manager.ts";
import type { SortMode } from "./session-selector-search.ts";

// Evaluated in a disposable Node worker: a pathological pattern can hang this
// worker, but never the terminal input/rendering thread. No external file path
// is required, including when the coding-agent is bundled into one executable.
const REGEX_WORKER_CODE = String.raw`
"use strict";
const { parentPort } = require("node:worker_threads");
parentPort.on("message", ({ pattern, sessions }) => {
  try {
    const regex = new RegExp(pattern, "i");
    const scores = sessions.map(({ name, id, text, cwd }) => {
      if (name && regex.test(name)) return 0;
      return regex.test(id) || regex.test(text) || regex.test(cwd) ? 1 : -1;
    });
    parentPort.postMessage({ scores });
  } catch (error) {
    parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
});
`;

const SEARCH_BUDGET_MS = 500;
const BATCH_SIZE = 16;
const MAX_PATTERN_LENGTH = 2048;
type SearchResponse = { scores?: number[]; error?: string };

/**
 * Search full session texts off the UI thread. Serial batches bound the size
 * of each structured-clone transfer; a global budget terminates ReDoS work.
 */
export async function filterSessionsByRegexInWorker(
	sessions: readonly SessionInfo[],
	pattern: string,
	sortMode: SortMode,
	signal?: AbortSignal,
): Promise<SessionInfo[]> {
	if (!pattern || pattern.length > MAX_PATTERN_LENGTH) throw new Error("Invalid regex search length");
	if (signal?.aborted) throw new Error("Regex search cancelled");
	if (sessions.length === 0) return [];

	const worker = new Worker(REGEX_WORKER_CODE, { eval: true });
	let rejectActive: ((error: Error) => void) | undefined;
	const reject = (error: Error) => {
		rejectActive?.(error);
		rejectActive = undefined;
	};
	const onAbort = () => reject(new Error("Regex search cancelled"));
	const onError = (error: Error) => reject(error);
	const onExit = (code: number) => {
		if (code !== 0) reject(new Error(`Regex worker exited (${code})`));
	};
	worker.on("error", onError);
	worker.on("exit", onExit);
	signal?.addEventListener("abort", onAbort, { once: true });
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const resetIdleTimeout = () => {
		if (timeout !== undefined) clearTimeout(timeout);
		timeout = setTimeout(() => reject(new Error("Regex search timed out")), SEARCH_BUDGET_MS);
	};
	resetIdleTimeout();

	const matched: { session: SessionInfo; score: number }[] = [];
	try {
		for (let start = 0; start < sessions.length; start += BATCH_SIZE) {
			if (signal?.aborted) throw new Error("Regex search cancelled");
			const batch = sessions.slice(start, start + BATCH_SIZE);
			const scores = await new Promise<number[]>((resolve, rejectRequest) => {
				const onMessage = ({ scores, error }: SearchResponse) => {
					resetIdleTimeout();
					worker.off("message", onMessage);
					rejectActive = undefined;
					if (error) rejectRequest(new Error(error));
					else if (!scores) rejectRequest(new Error("Regex worker returned no results"));
					else resolve(scores);
				};
				rejectActive = (error: Error) => {
					worker.off("message", onMessage);
					rejectRequest(error);
				};
				worker.on("message", onMessage);
				try {
					worker.postMessage({
						pattern,
						sessions: batch.map((session) => ({
							name: session.name,
							id: session.id,
							text: session.allMessagesText,
							cwd: session.cwd,
						})),
					});
				} catch (error) {
					worker.off("message", onMessage);
					rejectActive = undefined;
					rejectRequest(error);
				}
			});
			for (let index = 0; index < scores.length; index++) {
				const score = scores[index]!;
				if (score >= 0) matched.push({ session: batch[index]!, score });
			}
		}
		if (sortMode !== "recent") {
			matched.sort((left, right) => left.score - right.score || right.session.modified.getTime() - left.session.modified.getTime());
		}
		return matched.map(({ session }) => session);
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
		signal?.removeEventListener("abort", onAbort);
		worker.off("error", onError);
		worker.off("exit", onExit);
		await worker.terminate();
	}
}
