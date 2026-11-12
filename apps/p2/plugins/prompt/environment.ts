import { join, type PlatformPath } from "node:path";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Observer } from "@p2/app/v1/node";
import { isLocalEnvironment } from "@p2/app/v1/worker";
import { agentsCandidates, type LoadedPrompt, loadPromptResources, type PromptFiles } from "./context-files.ts";

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const context = BACKGROUND_CONTEXT;
/** A load that takes longer (a slow or stalled remote) fails and is retried at the next change. */
const LOAD_TIMEOUT_MS = 60_000;
/** Skills directories are scanned without hidden entries and `node_modules`; the watch skips them too. */
const SKILL_EXCLUDES = { hidden: true, names: ["node_modules"] };

/** Project files read through a session's environment. */
export function envFiles(env: ExecutionEnv, paths: PlatformPath): PromptFiles {
	return {
		paths,
		local: isLocalEnvironment(env),
		async readText(path) {
			const result = await env.readTextFile(path, context);
			if (result.ok) return result.value;
			if (result.error.code === "not_found") return undefined;
			throw new Error(result.error.message);
		},
		async entries(path) {
			const result = await env.listDir(path, context);
			if (result.ok)
				return result.value.map((entry) => ({
					name: entry.name,
					kind: entry.kind === "file" ? "file" : entry.kind === "directory" ? "directory" : "other",
				}));
			if (result.error.code === "not_found") return undefined;
			throw new Error(result.error.message);
		},
	};
}

export type PromptSource = {
	/** The session's environment, local or remote. */
	env: ExecutionEnv;
	/** p2's data directory (local), for the global `AGENTS.md`. */
	directory: string;
	cwd: string;
	/** Path rules of the environment's system. */
	paths: () => Promise<PlatformPath>;
	/** The global skills directory in the environment: `<data>/skills` locally, `~/.pi/p2/skills` remotely. */
	skillsRoot: () => Promise<string>;
	/** The global prompt templates directory: `<data>/prompts` locally, `~/.pi/p2/prompts` remotely. */
	promptsRoot?: () => Promise<string>;
	/** The plugins' skills directories (on this machine only: `PluginSkills`), read when watching starts. */
	pluginSkills?: () => readonly string[];
	/** A remote env's name, for messages. */
	remote?: string;
	/** How often to load while the environment cannot be watched. */
	fallbackMs: number;
	/** A newly loaded valid state, or the error of a failed load (the last valid state stays). */
	apply: (prompt: LoadedPrompt | undefined, error?: string) => void;
	/** After every successful load. */
	onLoaded?: () => void;
};

/**
 * Prompt resources of a session (`AGENTS.md` files and skills), loaded through its environment and reloaded when a
 * watch reports a change instead of by polling. The global `AGENTS.md` stays local and is watched locally.
 */
export function promptObserver(source: PromptSource): Observer {
	const { env, directory, cwd } = source;
	const promptsRoot = source.promptsRoot ?? (async () => join(directory, "prompts"));
	return new Observer(
		[
			{
				env,
				targets: async () => {
					const paths = await source.paths();
					return [
						...agentsCandidates(paths, cwd).map((path) => ({ path })),
						{ path: await source.skillsRoot(), recursive: true, exclude: SKILL_EXCLUDES },
						{ path: paths.join(cwd, ".pi", "skills"), recursive: true, exclude: SKILL_EXCLUDES },
						// Prompt templates: `.md` files directly in these directories.
						{ path: await promptsRoot() },
						{ path: paths.join(cwd, ".pi", "prompts") },
						...(source.pluginSkills?.() ?? []).map((path) => ({
							path,
							recursive: true,
							exclude: SKILL_EXCLUDES,
						})),
					];
				},
			},
			{ env: new NodeExecutionEnv({ cwd: directory }), targets: () => [{ path: join(directory, "AGENTS.md") }] },
		],
		async (retrying) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				const prompt = await Promise.race([
					(async () =>
						loadPromptResources(
							directory,
							cwd,
							envFiles(env, await source.paths()),
							await source.skillsRoot(),
							await promptsRoot(),
							source.pluginSkills?.() ?? [],
						))(),
					new Promise<never>((_resolve, reject) => {
						timer = setTimeout(() => reject(new Error("Loading timed out")), LOAD_TIMEOUT_MS);
					}),
				]);
				source.apply(prompt);
				source.onLoaded?.();
				return false;
			} catch (error) {
				// Possibly a file caught half-written: read once more before reporting.
				if (!retrying) return true;
				source.apply(
					undefined,
					source.remote === undefined
						? "Could not load prompt resources; keeping last valid state"
						: `Could not load prompt resources from "${source.remote}": ${errorMessage(error)}; keeping last valid state`,
				);
				return false;
			} finally {
				clearTimeout(timer);
			}
		},
		source.fallbackMs,
	);
}
