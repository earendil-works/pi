// The MCP plugin's worker facet: the worker object holding the server's `Mcp` view. It sets the locations the session's
// conversations work at (the session's, active subagents' own), with the project `.pi/mcp.json` read at each through
// its environment, as its leases, again whenever they may have changed and whenever the view (re)activates, and offers
// the session's servers as one composing Durable extension (`mcp`, `tools.ts`) that follows the view's `servers`,
// `leases` and the code mode switch: each conversation sees the servers of its location's lease; as in pi, tools are
// for code mode scripts, and only without code mode does `tool_search` (installed by the worker's registry) load them
// for the model. No MCP process or credential is ever in a worker.

import { setTimeout as sleep } from "node:timers/promises";
import { type ConversationId, type Extension, type Harness, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import {
	type Context,
	type Ctx,
	contribute,
	defineFacet,
	expectVariant,
	isChordError,
	type Location,
	type Ref,
	type StoreSelf,
	sameLocation,
	signalOf,
	until,
	untilAborted,
	type Watchable,
	type Writable,
} from "@p2/app/v1";
import { durableContext } from "@p2/app/v1/node";
import {
	CommitSignal,
	type ExecutionEnvironments,
	ExtensionSwitches,
	Extensions,
	type HarnessParts,
	harnessOf,
	type WorkerParts,
	workerOf,
} from "@p2/app/v1/worker";
import { Subagents } from "../subagents/contract.worker.ts";
import { Mcp, PROJECT_FILE_MAX_CHARS, type ProjectFile } from "./contract.ts";
import {
	createMcpExtension,
	EMPTY_MCP_EXTENSION,
	MCP_EXTENSION,
	type McpCall,
	type McpLocate,
	type McpOffer,
	type McpReach,
	offeredInstances,
} from "./tools.ts";

/** How long to wait before setting the locations again after a failure. */
const RETRY_MS = 2000;

/** The code mode plugin's extension: its switch is on while the `codemode` setting is, absent without the plugin. */
const CODEMODE_EXTENSION = "codemode";

export default defineFacet((host) => {
	contribute(host, "p2.mcp-worker", mcpWorker);
});

/** The worker object: the view, the extension of the servers' tools, and the leases at the conversations' locations. */
function mcpWorker(self: StoreSelf): void {
	const harness = harnessOf(self);
	const worker = workerOf(self);
	const view = self.get(Mcp, {});
	const locate: McpLocate = (conversationId, read, context) =>
		harness().environments.locate(conversationId, context, read);
	const call: McpCall = (request, context) =>
		worker().root((ctx) => expectVariant(view, "worker").call(request, ctx), context);
	// Code mode switched off or not loaded: the tools would be unreachable, so `tool_search` loads them, as pi falls back.
	const reach = self.derive(
		[self.registry(ExtensionSwitches)],
		([switches]): McpReach => (switches.get(CODEMODE_EXTENSION) === true ? "codemode" : "tool_search"),
	);
	const extension = self.writable<Readonly<Record<string, Extension>>>({ [MCP_EXTENSION]: EMPTY_MCP_EXTENSION });
	self.contribute(Extensions, extension);
	self.onLive((ctx) =>
		offerTools(
			view,
			reach,
			extension,
			() => harness().environments.session,
			(offer) => createMcpExtension(offer, call, locate),
			ctx,
		),
	);
	leaseLocations(self, view, harness, worker);
}

/**
 * Follows the view's `servers` and `leases` and `reach` until `ctx` ends: a new instance, tool list, summary or
 * instructions, a lease's change or a new reach makes a new extension (not a status change). Where the session works
 * (`session`, whose variants keep the plain names) is read at each change: a move changes the leases too. `tool_search`,
 * which reaches the tools without code mode, is the worker's registry's (`durableRegistry`), shared with other plugins'
 * deferred tools.
 */
async function offerTools(
	view: Ref<typeof Mcp>,
	reach: Watchable<McpReach>,
	extension: Writable<Readonly<Record<string, Extension>>>,
	session: () => Location,
	create: (offer: McpOffer) => Extension,
	ctx: Ctx,
): Promise<void> {
	const members = expectVariant(view, "worker");
	const servers = await members.servers.watch(ctx);
	try {
		const leases = await members.leases.watch(ctx);
		try {
			const reaches = await reach.watch(ctx);
			try {
				let current = { servers: servers.value, leases: leases.value, reach: reaches.value };
				let offered = "";
				const offer = (): void => {
					const next: McpOffer = {
						instances: offeredInstances(current.servers),
						leases: current.leases,
						session: session(),
						reach: current.reach,
					};
					const key = JSON.stringify(next);
					if (key === offered) return;
					offered = key;
					extension.set({ [MCP_EXTENSION]: create(next) });
				};
				offer();
				servers.start(async (change) => {
					if (change.kind !== "value") return;
					current = { ...current, servers: change.value };
					offer();
				});
				leases.start(async (change) => {
					if (change.kind !== "value") return;
					current = { ...current, leases: change.value };
					offer();
				});
				reaches.start(async (change) => {
					if (change.kind !== "value") return;
					current = { ...current, reach: change.value };
					offer();
				});
				await untilAborted(ctx);
			} finally {
				await reaches.stop();
			}
		} finally {
			await leases.stop();
		}
	} finally {
		await servers.stop();
	}
}

/**
 * Sets the locations the conversations work at as the view's leases: once live, then after every subagent commit,
 * move and re-activation of the view; a failure is retried, a refusal (a newer worker runs) ends it.
 */
function leaseLocations(
	self: StoreSelf,
	view: Ref<typeof Mcp>,
	harness: () => HarnessParts,
	worker: () => WorkerParts,
) {
	// Subagents' own locations change through commits of their registry; the session's through moves.
	const commits = self.open(
		async () =>
			new CommitSignal(harness().durable, (publication) =>
				publication.changes.some(
					(change) => change.type === "document" && change.record.kind === Subagents.definition.kind,
				),
			),
		(signal) => signal.close(),
	);
	// Counts re-activations of the view (a new view object, a reload): its first activation is the loop's first send.
	const activated = self.writable(0);
	let previous: string | undefined;
	self.on(view.state, async ({ value }) => {
		if (value.kind === "live" && previous !== undefined && previous !== "live") activated.set(activated.value + 1);
		previous = value.kind;
	});
	const activations = self.derive([activated], ([count]) => count);
	self.onLive(async (ctx) => {
		const signal = commits.value;
		while (!signalOf(ctx).aborted) {
			const seen = { commits: signal.version, moves: worker().location.version, views: activated.value };
			try {
				const { environments, durable } = harness();
				const locations = await workLocations(durable, environments, durableContext(ctx));
				const projects = await projectFiles(locations, environments, durableContext(ctx));
				await expectVariant(view, "worker").setLocations({ locations, projects }, ctx);
			} catch (error) {
				if (signalOf(ctx).aborted) return;
				if (isChordError(error, "forbidden")) {
					console.error("p2 mcp: a newer worker of this session leases its MCP servers; this one stops:", error);
					return;
				}
				console.error("p2 mcp: setting the session's MCP locations failed, retrying:", error);
				await sleep(RETRY_MS, undefined, { signal: signalOf(ctx) }).catch(() => {});
				continue;
			}
			// A move or an activation while setting is not missed: its version is newer.
			if (worker().location.version !== seen.moves || activated.value !== seen.views) continue;
			await nextChange(
				[
					(stop) => signal.next(seen.commits, stop),
					(stop) => worker().location.next(stop),
					(stop) => until(activations, (count) => count !== seen.views, durableContext(stop)),
				],
				signalOf(ctx),
			);
		}
	});
}

/** Every distinct location the session's conversations work at: the main one's and active subagents'. */
async function workLocations(
	durable: Harness,
	environments: ExecutionEnvironments,
	context: Context,
): Promise<Location[]> {
	const registry = await durable.snapshot(Subagents, ROOT_CONVERSATION_ID, context);
	// Archived subagents rest until a send restores them (a commit); one-shot agents always follow the session.
	const ids: ConversationId[] = [
		ROOT_CONVERSATION_ID,
		...Object.values(registry?.agents ?? {})
			.filter((agent) => !agent.archived)
			.map((agent) => agent.conversationId),
	];
	const locations: Location[] = [];
	for (const id of ids) {
		const location = await environments.locate(id, context);
		if (!locations.some((known) => sameLocation(known, location))) locations.push(location);
	}
	return locations;
}

/**
 * The project configurations at `locations`: `<cwd>/.pi/mcp.json` read through each location's environment (the
 * manager checks them). A missing file is none; one too large or unreadable is reported as such.
 */
async function projectFiles(
	locations: readonly Location[],
	environments: ExecutionEnvironments,
	context: Context,
): Promise<ProjectFile[]> {
	const files: ProjectFile[] = [];
	for (const location of locations) {
		const env = await environments.at(location);
		const path = await env.joinPath([location.cwd, ".pi", "mcp.json"], context);
		const read = path.ok ? await env.readTextFile(path.value, context) : path;
		if (read.ok)
			files.push(
				read.value.length <= PROJECT_FILE_MAX_CHARS
					? { location, text: read.value }
					: { location, error: `larger than ${PROJECT_FILE_MAX_CHARS} characters` },
			);
		else if (read.error.code !== "not_found") files.push({ location, error: read.error.message.slice(0, 2000) });
	}
	return files;
}

/** Resolves after the first of `waits` (each given a signal that ends the others); an abort just ends the wait. */
async function nextChange(
	waits: readonly ((stop: AbortSignal) => Promise<unknown>)[],
	aborted: AbortSignal,
): Promise<void> {
	const done = new AbortController();
	const abort = (): void => done.abort();
	aborted.addEventListener("abort", abort, { once: true });
	try {
		await Promise.race(waits.map((wait) => wait(done.signal))).catch(() => {});
	} finally {
		done.abort();
		aborted.removeEventListener("abort", abort);
	}
}
