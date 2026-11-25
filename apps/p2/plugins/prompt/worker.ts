// Prompt resources of a session: the app guide, AGENTS.md files (global and the project's) and skills, watched and
// reloaded without restarting the worker.
import * as nodePath from "node:path";
import { join } from "node:path";
import {
	type ConversationId,
	type DocumentReader,
	defineExtension,
	type PromptInput,
	section,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { RemoteExecutionEnv } from "@earendil-works/pi-env";
import { num, obj, opt, str } from "@earendil-works/pi-schema";
import {
	BACKGROUND_CONTEXT,
	type Context,
	canSend,
	defineFacet,
	defineRegistry,
	deriveTyped,
	forbidden,
	local,
	method,
	nativeOf,
	type Subscribable,
	serveKeyed,
	serveNative,
	signalOf,
	untilAborted,
} from "@p2/app/v1";
import { remotePaths } from "@p2/app/v1/node";
import {
	Extensions,
	harnessOf,
	InputGates,
	type Location,
	PluginSkills,
	type SessionLocation,
	sameLocation,
	sessionLock,
	workerOf,
} from "@p2/app/v1/worker";
import type { LoadedPrompt } from "./context-files.ts";
import { PromptResources, type SkillInfo, type TemplateInfo } from "./contract.ts";
import { envFiles, promptObserver } from "./environment.ts";
import { expandPrompt } from "./templates.ts";

/**
 * What the agent should know about the app it runs in, and where its private data lives (Pi Mobile's app guide,
 * adapted). `app` is p2's own directory (`WorkerInit.app`): its documentation and source, for questions about p2
 * itself. A remote session loads its skills from its environment's `~/.pi/p2/skills`.
 */
export function appGuide(app: string, dataDir: string, env?: string | null): string {
	const skills = env
		? `${JSON.stringify("~/.pi/p2/skills")} on the remote environment "${env}"`
		: JSON.stringify(join(dataDir, "skills"));
	return `You are running inside Pi (p2, the plugin-based Pi Mobile).
Application source and documentation: ${JSON.stringify(app)} (not the session cwd). For app changes, first read docs/handoff.md and docs/p2-notes.md there; plugins live in plugins/<name>/. Read them only when working on the app itself.
Private configuration/data: ${JSON.stringify(dataDir)}. Models: ${JSON.stringify(join(dataDir, "models.json"))}; settings: ${JSON.stringify(join(dataDir, "settings.json"))}; global instructions: ${JSON.stringify(join(dataDir, "AGENTS.md"))}; skills: ${skills}. Before editing, read ${JSON.stringify(join(app, "README.md"))}'s Configuration section and plugins/models/model-config.ts or src/runtime/settings.ts under the app directory. Valid configuration changes hot-reload; in-flight requests keep their captured configuration.
Keep auth.json, owner keys/tokens and session data private. Never print, publish or commit credentials.`;
}

type Loaded = { readonly prompt?: LoadedPrompt; readonly error?: string };
const EMPTY: LoadedPrompt = { agents: "", skills: "", fingerprint: "", skillFiles: [], templates: [] };

/** The prompt resources of one location: watched and loaded through its environment. */
type PromptLoads = {
	/** The latest valid load (empty before the first). */
	current: () => LoadedPrompt;
	/** Resolves after the first load (or its failure). */
	started: () => Promise<void>;
	/** Each load (or failure) is an event; a new subscriber gets the latest first. */
	loads: Subscribable<Loaded>;
	/** The environment its files are read through (skills, when invoked). */
	env: () => Promise<ExecutionEnv>;
	/** Watches and loads anew (the plugins' skills directories changed); only on this machine, which lists them. */
	rewatch: () => Promise<void>;
	close: () => Promise<void>;
};

/** Where conversations find their prompt resources: the session's (following its moves) or their own location's. */
type PromptFiles = {
	readonly session: MovingPromptLoads;
	/** Every open load watches and loads anew (the plugins' skills directories changed). */
	rewatch: () => Promise<unknown>;
	of: (id: ConversationId, context: Context, read?: DocumentReader) => Promise<PromptLoads>;
};

/**
 * Watches the files at `at` (through `environment`) and loads them; on this machine with the plugins' skills
 * (`pluginSkills`, read at each watch's start).
 */
function promptLoads(
	dataDir: string,
	at: Location,
	environment: Promise<ExecutionEnv>,
	pluginSkills: () => readonly string[],
): PromptLoads {
	let current = EMPTY;
	let closed = false;
	const listeners = new Set<(loaded: Loaded) => void>();
	let latest: Loaded | undefined;
	const publish = (loaded: Loaded): void => {
		latest = loaded;
		if (loaded.prompt) current = loaded.prompt;
		for (const listener of [...listeners]) listener(loaded);
	};
	const remote = at.env;
	const watch = () =>
		environment.then((env) =>
			promptObserver({
				env,
				directory: dataDir,
				cwd: at.cwd,
				paths: async () => (env instanceof RemoteExecutionEnv ? remotePaths(env.connection) : nodePath),
				skillsRoot: async () =>
					remote
						? await env.absolutePath("~/.pi/p2/skills", BACKGROUND_CONTEXT).then((result) => {
								if (!result.ok) throw new Error(result.error.message);
								return result.value;
							})
						: join(dataDir, "skills"),
				promptsRoot: async () =>
					remote
						? await env.absolutePath("~/.pi/p2/prompts", BACKGROUND_CONTEXT).then((result) => {
								if (!result.ok) throw new Error(result.error.message);
								return result.value;
							})
						: join(dataDir, "prompts"),
				...(remote ? { remote } : { pluginSkills }),
				fallbackMs: remote ? 30_000 : 2000,
				apply: (prompt, error) => publish({ ...(prompt ? { prompt } : {}), ...(error ? { error } : {}) }),
			}),
		);
	const begin = (next: ReturnType<typeof watch>) =>
		next
			.then((value) => (closed ? undefined : value.start()))
			.catch((error: unknown) => {
				publish({ error: `Could not watch prompt resources (${error instanceof Error ? error.message : error})` });
			});
	let observer = watch();
	// Not awaited by the resource: the object (and its registrations) go live at once; input waits on the gate.
	const started = begin(observer);
	return {
		started: () => started,
		current: () => current,
		env: () => environment,
		rewatch: async () => {
			if (remote || closed) return;
			const previous = observer;
			observer = watch();
			await (await previous.catch(() => undefined))?.close();
			await begin(observer);
		},
		loads: {
			subscribe: (listener) => {
				listeners.add(listener);
				if (latest !== undefined) listener(latest);
				return () => listeners.delete(listener);
			},
		},
		close: async () => {
			closed = true;
			await (await observer.catch(() => undefined))?.close();
		},
	};
}

/** The session's prompt resources, which move with the session (`move`, from the `Prompt` object's routine). */
type MovingPromptLoads = PromptLoads & {
	/**
	 * Loads them anew at `at` (from the new cwd, on the new machine) when `version` is a newer move; resolves once the
	 * old location's watches closed.
	 */
	move(at: Location, version: number): Promise<void>;
};

/**
 * The prompt resources of the session's current location: loaded for the location it is at, and loaded anew after
 * each move. `loads` follows the current location's loads.
 */
function movingPromptLoads(location: SessionLocation, open: (at: Location) => PromptLoads): MovingPromptLoads {
	const listeners = new Set<(loaded: Loaded) => void>();
	let latest: Loaded | undefined;
	const forward = (loaded: Loaded): void => {
		latest = loaded;
		for (const listener of [...listeners]) listener(loaded);
	};
	// Only the current loads publish: a superseded observer may still report (a reload on the old machine's connection,
	// which the move closes after this) while it closes.
	const follow = (loads: PromptLoads) =>
		loads.loads.subscribe((loaded) => {
			if (inner === loads) forward(loaded);
		});
	let version = location.version;
	let inner = open(location.value);
	let unsubscribe = follow(inner);
	return {
		current: () => inner.current(),
		started: () => inner.started(),
		env: () => inner.env(),
		rewatch: () => inner.rewatch(),
		loads: {
			subscribe: (listener) => {
				listeners.add(listener);
				if (latest !== undefined) listener(latest);
				return () => listeners.delete(listener);
			},
		},
		move: async (at, moved) => {
			if (moved <= version) return;
			version = moved;
			const previous = inner;
			unsubscribe();
			inner = open(at);
			unsubscribe = follow(inner);
			await previous.close().catch((error: unknown) => console.error("p2 prompt: closing old watches:", error));
		},
		close: async () => {
			unsubscribe();
			await inner.close();
		},
	};
}

/** The session's prompt resources by location (worker, host-internal); its files are the `PromptFilesNative`. */
const Prompt = local("p2.prompt", {
	// 4: the files are a native.
	version: 4,
	params: {},
	members: {
		/** Expands `/template args` and `/skill:name args` where `conversation` works (see `PromptResources.expand`). */
		expand: method(obj({ text: str(), conversation: num() }), obj({ text: str(), skill: opt(obj({ name: str() })) })),
	},
});

/** The open `Prompt`'s files (the native it contributes), for `PromptResources`. */
const PromptFilesNative = defineRegistry<PromptFiles, PromptFiles | undefined>("p2.prompt-files", { version: 1 });

/** The templates and skills of a load, as `PromptResources` shows them. */
function listedOf(loaded: LoadedPrompt): { templates: TemplateInfo[]; skills: SkillInfo[] } {
	return {
		templates: loaded.templates.map(({ name, description, argumentHint, source }) => ({
			name,
			description,
			...(argumentHint ? { argumentHint } : {}),
			source,
		})),
		skills: loaded.skillFiles.map(({ name, description }) => ({ name, description })),
	};
}

export default defineFacet((host) => {
	serveNative(host, PromptFilesNative);
	serveKeyed(host, PluginSkills);
	host.serve(Prompt, (_params, self) => {
		const worker = workerOf(self);
		const harness = harnessOf(self);
		const skills = self.registry(PluginSkills);
		const pluginSkills = () => [...skills.value.values()].map((entry) => entry.dir).sort();
		const filesResource = self.open(
			async () => {
				const environments = harness().environments;
				const dataDir = worker().init.dataDir;
				const open = (at: Location): PromptLoads => promptLoads(dataDir, at, environments.at(at), pluginSkills);
				const session = movingPromptLoads(worker().location, open);
				const own = new Map<string, PromptLoads>();
				const files: PromptFiles = {
					session,
					rewatch: () => Promise.all([session, ...own.values()].map((loads) => loads.rewatch())),
					of: async (id, context, read) => {
						const at = await environments.locate(id, context, read);
						if (sameLocation(at, environments.session)) return session;
						const key = JSON.stringify([at.env, at.cwd]);
						let loads = own.get(key);
						if (!loads) {
							loads = open(at);
							own.set(key, loads);
						}
						return loads;
					},
				};
				return {
					files,
					close: async () => {
						await Promise.all([session.close(), ...[...own.values()].map((loads) => loads.close())]);
					},
				};
			},
			(value) => value.close(),
		);
		// The session's resources follow its moves (one committed while the files opened included).
		self.onLive(async (ctx) => {
			const location = worker().location;
			const session = filesResource.value.files.session;
			for (;;) {
				// Listening before moving: a move committed while the old watches close is not missed.
				const moved = location.next(signalOf(ctx));
				moved.catch(() => {}); // The abort ends this routine below.
				await session.move(location.value, location.version);
				await moved;
			}
		});
		// A plugin's skills come and go with its reloads: this machine's loads watch and list the new directories.
		self.onLive(async (ctx) => {
			const watch = await skills.watch(ctx);
			let listed = JSON.stringify(pluginSkills());
			let chain = Promise.resolve();
			watch.start(async (call) => {
				if (call.kind !== "value" || JSON.stringify(pluginSkills()) === listed) return;
				listed = JSON.stringify(pluginSkills());
				chain = chain
					.then(() => filesResource.value.files.rewatch())
					.then(
						() => {},
						(error: unknown) => console.error("p2 prompt: watching plugins' skills:", error),
					);
			});
			try {
				await untilAborted(ctx);
			} finally {
				await watch.stop();
			}
		});
		// Load failures of the session's resources go to the worker's log (they also leave the last good load in use).
		self.onLive(async (ctx) => {
			const stop = filesResource.value.files.session.loads.subscribe(({ error }) => {
				if (error !== undefined) console.error(`p2 prompt: ${error}`);
			});
			try {
				await untilAborted(ctx);
			} finally {
				stop();
			}
		});
		self.contribute(PromptFilesNative, {
			get session() {
				return filesResource.value.files.session;
			},
			of: (id, context, read) => filesResource.value.files.of(id, context, read),
			rewatch: () => filesResource.value.files.rewatch(),
		});
		/**
		 * The latest load where the conversation works. On this machine its first load is awaited (the session's is
		 * the input gate's); a remote one loads in the background, so an offline host does not block a turn.
		 */
		const loaded = async (input: PromptInput, context: Context): Promise<LoadedPrompt> => {
			const loads = await filesResource.value.files.of(input.conversationId, context, input.read);
			if (!(await harness().environments.locate(input.conversationId, context, input.read)).env)
				await loads.started();
			return loads.current();
		};
		/** What the conversation's prompt shows: a locked session gets the global instructions only when picked. */
		const visible = async (input: PromptInput, context: Context) => {
			const current = await loaded(input, context);
			const lock = await sessionLock(input.read, context);
			return lock && !lock.instructions ? (current.project ?? current) : current;
		};
		// Sections are rendered for every generation, for the conversation's location: they read its latest load.
		const extension = defineExtension({
			name: "p2-prompt",
			sections: [
				section("app", async (input, context) =>
					appGuide(
						worker().init.app,
						worker().init.dataDir,
						(await harness().environments.locate(input.conversationId, context, input.read)).env,
					),
				),
				section("agents-md", async (input, context) => (await visible(input, context)).agents || undefined, {
					tag: false,
				}),
				section("skills", async (input, context) => (await visible(input, context)).skills || undefined, {
					tag: false,
				}),
			],
		});
		self.contribute(Extensions, { [extension.name]: extension });
		// A session's first message waits for its instructions (the first load).
		self.contribute(InputGates, {
			prompt: () => (worker().location.value.env ? Promise.resolve() : filesResource.value.files.session.started()),
		});
		return {
			// Skill files are read when invoked, through the conversation's environment (local or remote).
			expand: async ({ text, conversation }, ctx) => {
				const loads = await filesResource.value.files.of(conversation as ConversationId, ctx);
				const current = loads.current();
				const environment = await loads.env();
				const paths =
					environment instanceof RemoteExecutionEnv ? await remotePaths(environment.connection) : nodePath;
				const files = envFiles(environment, paths);
				const expanded = await expandPrompt(text, current.templates, current.skillFiles, (skill) =>
					files.readText(skill.path),
				);
				return expanded.skill
					? { text: expanded.text, skill: { name: expanded.skill.name } }
					: { text: expanded.text };
			},
		};
	});

	// Participants see the templates and skills where the conversation works and expand with them (viewers cannot send).
	host.serve(PromptResources, ({ session, conversation }, principal, self) => {
		if (!canSend(principal, session)) throw forbidden("participants only");
		const prompt = self.get(Prompt, {});
		const files = nativeOf(self, PromptFilesNative, "The prompt files");
		// The loads where the conversation works, followed: each new load (a changed fingerprint) is the next value.
		const listed = self.follow(async (observer, ctx) => {
			const loads = await files().of(conversation as ConversationId, ctx);
			let fingerprint = loads.current().fingerprint;
			const stop = loads.loads.subscribe(({ prompt: loaded }) => {
				if (!loaded || loaded.fingerprint === fingerprint) return;
				fingerprint = loaded.fingerprint;
				const value = listedOf(loaded);
				observer.advance({ kind: "value", value, ops: [["r", value]], retired: false }, BACKGROUND_CONTEXT);
			});
			return { value: listedOf(loads.current()), detach: stop };
		});
		return {
			variant: "participant",
			members: {
				templates: deriveTyped(self, [listed], ([value]) => value.templates),
				skills: deriveTyped(self, [listed], ([value]) => value.skills),
				expand: ({ text }, ctx) => prompt.expand({ text, conversation }, ctx),
			},
		};
	});
});
