// The MCP manager and its views on a bare server host, with the stdio fixture server (test/fixtures/mcp-server.mjs), a
// small Streamable HTTP server and a stub of the workers' states: instances per session and location or shared, leases
// set per worker generation and released by the view's end, processes ending with their instances, edits of mcp.json,
// the generation and incarnation fences, placement refusals, projects' mcp.json, where sessions work, environments
// through a local pi-env daemon, a reload, guests. Reconnects: mcp-instances.test.ts.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Connection } from "@earendil-works/pi-env";
import { constant, follow, type Location, type P2Principal } from "@p2/app/v1";
import { Hosts, Server, type WorkerState } from "@p2/app/v1/server";
import type { EnvConfig } from "../../plugins/envs/config.ts";
import { EnvService } from "../../plugins/envs/contract.ts";
import { expandHostVariables, parseOwnerConfig } from "../../plugins/mcp/config.ts";
import { type Instance, Mcp, McpManager } from "../../plugins/mcp/contract.ts";
import type { ConnectEnv } from "../../plugins/mcp/environments.ts";
import { mcpServerFacet } from "../../plugins/mcp/server.ts";
import { Catalog, type Session } from "../../plugins/sessions/contract.ts";
import { type Child, ChildStore } from "../../plugins/subagents/contract.ts";
import { APP, type Cell, expectChord, failureOf, holdIn, poll, settled, TEST, testHost, until } from "./helpers.ts";

const FIXTURE = fileURLToPath(new URL("../fixtures/mcp-server.mjs", import.meta.url));
/** The pi-env daemon environments start servers through: `PI_ENV_DAEMON`, else the debug build of packages/env. */
const DAEMON =
	process.env.PI_ENV_DAEMON ??
	fileURLToPath(
		new URL(
			`../../../../packages/env/daemon/target/debug/pi-env${process.platform === "win32" ? ".exe" : ""}`,
			import.meta.url,
		),
	);
const OWNER: P2Principal = { kind: "owner", access: "local" };
const GUEST: P2Principal = {
	kind: "guest",
	id: "g1",
	name: "Guest",
	home: "s1",
	sessions: { s1: "full" },
	revision: 1,
};

type Paths = { readonly root: string; readonly log: string };

/** Views linger this long after their last reference here (30 s in p2). */
const LINGER_MS = 150;
/** Environments of envs.json: none unless a test configures them. */
const NO_ENVIRONMENTS: ConnectEnv = () => {
	throw new Error("no environments in this test");
};
const mcpServer = mcpServerFacet(LINGER_MS, () => NO_ENVIRONMENTS);

const UNUSED = (): never => {
	throw new Error("unused in these tests");
};

/** A catalog entry of session `id` working on `env` (null: this machine). */
const session = (id: string, env: string | null): Session => ({
	id,
	env,
	cwd: "/",
	title: id,
	createdAt: 0,
	updatedAt: 0,
	archivedAt: null,
	pinned: false,
	model: { provider: "faux", modelId: "faux-1" },
	thinkingLevel: "off",
	main: 1,
	branches: [],
});

/** The fixture server as a stdio entry; every start appends its pid to `log`. */
const stdio = ({ log }: Paths, extra: Record<string, unknown> = {}) => ({
	command: process.execPath,
	args: [FIXTURE],
	env: { MCP_FIXTURE_LOG: log },
	...extra,
});

/**
 * A server host with the MCP plugin and `mcp.json` holding `servers(paths)`, in a fresh data directory. Workers taken
 * with `worker` are published running in the stub of the workers' states first, their sessions in the stub of the
 * catalog. `options.envs` are envs.json's environments, reached through `options.facet`'s connector.
 */
async function mcpHost(
	t: { after(fn: () => unknown): void },
	servers: (paths: Paths) => Record<string, unknown>,
	options: { envs?: Record<string, EnvConfig>; facet?: typeof mcpServer } = {},
) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "p2-mcp-")));
	const dataDir = join(root, "data");
	const paths = { root, log: join(root, "starts.log") };
	mkdirSync(dataDir);
	const configure = (entries: Record<string, unknown>) =>
		writeFileSync(join(dataDir, "mcp.json"), JSON.stringify({ mcpServers: entries }));
	configure(servers(paths));
	let workerStates: Cell<Record<string, WorkerState>> | undefined;
	let sessions: Cell<Session[]> | undefined;
	let children: Cell<Record<string, Child[]>> | undefined;
	const fixture = await testHost({
		facets: [options.facet ?? mcpServer],
		stubs: [
			// What the manager reads of these: envs.json, sessions' and subagents' locations; their methods are unused.
			[
				EnvService,
				{
					configs: constant(options.envs ?? {}),
					tests: constant({}),
					failure: constant(null),
					test: UNUSED,
					reload: UNUSED,
				},
			],
			[
				Catalog,
				(_params, _principal, self) => {
					sessions = self.state<Session[]>([]);
					return { sessions, get: UNUSED, create: UNUSED, activity: UNUSED, update: UNUSED };
				},
			],
			[
				ChildStore,
				(_params, _principal, self) => {
					children = self.state<Record<string, Child[]>>({});
					return { children, report: UNUSED };
				},
			],
			[
				Server,
				{
					info: constant({ app: APP, dataDir, fake: true, allowedHosts: [], port: 0 }),
					revokeOwners: () => {},
					revokeGuests: () => {},
				},
			],
			[
				Hosts,
				(_params, _principal, self) => {
					workerStates = self.state<Record<string, WorkerState>>({});
					return { workers: workerStates, stop: () => {} };
				},
			],
		],
	});
	const manager = await fixture.host.get(McpManager, {}, TEST);
	const workers: { release(): void }[] = [];
	let closed = false;
	const shutdown = async () => {
		closed = true;
		await fixture.close();
	};
	t.after(async () => {
		if (!closed) {
			// Workers go first, as when their processes exit: their views release the leases while the manager lives.
			for (const ref of workers) ref.release();
			await until(manager.leases, (leases) => leases.length === 0);
			await shutdown();
		}
		rmSync(root, { recursive: true, force: true });
	});
	const running = (session: string, generation: number) =>
		workerStates!.change(TEST, (draft) => {
			draft[session] = { running: true, generation };
		});
	/** Records `id` in the catalog as working on `env`, unless it is there already. */
	const listed = (id: string, env: string | null) =>
		sessions!.value.some((entry) => entry.id === id)
			? Promise.resolve()
			: sessions!.change(TEST, (draft) => {
					draft.push(session(id, env));
				});
	return {
		fixture,
		manager,
		shutdown,
		/** Publishes `session`'s worker `generation` as running, the session in the catalog (on this machine) if new. */
		running: async (session: string, generation: number) => {
			await listed(session, null);
			await running(session, generation);
		},
		/** Moves session `id` to `env` in the catalog. */
		move: (id: string, env: string | null) =>
			sessions!.change(TEST, (draft) => {
				for (const entry of draft) if (entry.id === id) entry.env = env;
			}),
		/** Records `id`'s subagents (their own locations). */
		subagents: (id: string, list: Child[]) =>
			children!.change(TEST, (draft) => {
				draft[id] = list;
			}),
		configure: (next: (paths: Paths) => Record<string, unknown>) => configure(next(paths)),
		/** Writes `text` as mcp.json as it is (a save caught half-way). */
		write: (text: string) => writeFileSync(join(dataDir, "mcp.json"), text),
		/** A directory on this machine as a location. */
		at: (name: string): Location => {
			const cwd = join(root, name);
			mkdirSync(cwd, { recursive: true });
			return { env: null, cwd };
		},
		/** Fixture process starts so far. */
		starts: () => (existsSync(paths.log) ? readFileSync(paths.log, "utf8").trim().split("\n").filter(Boolean) : []),
		owner: () => holdIn(fixture.client(OWNER), Mcp, {}, "owner"),
		/**
		 * The view of `session`'s worker `generation` (published as the session's running worker unless `stale`), the
		 * session working on `env` (default this machine) unless the catalog lists it already.
		 */
		worker: async (session: string, generation = 1, options: { stale?: boolean; env?: string | null } = {}) => {
			await listed(session, options.env ?? null);
			if (!options.stale) await running(session, generation);
			const ref = await holdIn(fixture.client({ kind: "worker", session, generation }), Mcp, {}, "worker");
			workers.push(ref);
			return ref;
		},
	};
}

type WorkerView = Awaited<ReturnType<Awaited<ReturnType<typeof mcpHost>>["worker"]>>;

const textOf = (result: { content: readonly { type: string; text?: string }[] }) => result.content[0]?.text ?? "";
const status = (instances: readonly Instance[], server: string) =>
	instances.filter((instance) => instance.server === server).map((instance) => instance.status);
const isUp =
	(server: string, count = 1) =>
	(instances: readonly Instance[]) =>
		status(instances, server).filter((value) => value === "connected").length === count;
/** The fixture's own report: its pid, its parent's, cwd, the client's roots and its `MCP_FIXTURE_*` variables. */
const whoami = async (view: WorkerView, location: Location, server: string) =>
	JSON.parse(textOf(await view.call({ location, server, tool: "whoami", args: {} }, TEST))) as {
		pid: number;
		ppid: number;
		cwd: string;
		roots: { uri: string }[] | null;
		vars: Record<string, string>;
	};
const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
const exited = (pid: number) => poll(() => !alive(pid), 10_000, `process ${pid} to exit`);

test("owner config defaults: stdio per session at the location, shared on the host, HTTP shared", () => {
	const { servers, errors } = parseOwnerConfig(
		JSON.stringify({
			mcpServers: {
				files: { command: "npx", args: ["server"] },
				browser: { command: "npx", shared: true },
				gpu: { command: "/opt/tool", runOn: { env: "gpu" } },
				docs: { url: "https://example.com/mcp" },
				mine: { url: "https://example.com/mcp", shared: false },
				"a-b": { command: "x" },
				a_b: { command: "y" },
			},
		}),
	);
	assert.deepEqual(
		servers.map((server) => [server.name, server.shared, server.kind === "stdio" ? server.runOn : "http"]),
		[
			["files", false, "location"],
			["browser", true, "host"],
			["gpu", false, { env: "gpu" }],
			["docs", true, "http"],
			["mine", false, "http"],
			["a-b", false, "location"],
		],
	);
	assert.deepEqual(errors, ['server "a_b": its tools would be named like those of "a-b"']);
	assert.throws(() => parseOwnerConfig("{"), /Invalid mcp.json syntax/);
	process.env.P2_MCP_TEST_VALUE = "v";
	assert.equal(expandHostVariables(`a \${P2_MCP_TEST_VALUE} $HOME`), "a v $HOME");
	delete process.env.P2_MCP_TEST_VALUE;
	assert.throws(() => expandHostVariables(`\${P2_MCP_TEST_VALUE}`), /P2_MCP_TEST_VALUE is not set/);
});

test("owner config: valid servers load, invalid entries are reported and skipped", async (t) => {
	const host = await mcpHost(t, (paths) => ({
		good: stdio(paths),
		"bad name!": { command: "x" },
		nothing: {},
		cimd: { url: "https://example.com/mcp", oauth: { clientRegistration: "cimd" } },
		runOnHttp: { url: "https://example.com/mcp", runOn: "host" },
		sharedHere: { command: "x", shared: true, runOn: "location" },
		off: { command: "x", enabled: false },
	}));
	const owner = await host.owner();
	const errors = (await until(owner.errors, (value) => value.length > 0)).join("\n");
	assert.equal(owner.errors.value.length, 5, errors);
	assert.match(errors, /invalid server name/);
	assert.match(errors, /needs either "command"/);
	assert.match(errors, /cimd/);
	assert.match(errors, /runOn is for stdio servers/);
	assert.match(errors, /shared server cannot run where each conversation works/);
	// Nothing runs before a session leases it; then only the valid, enabled server.
	assert.deepEqual(owner.instances.value, []);
	const s1 = await host.worker("s1");
	await s1.setLocations({ locations: [host.at("one")] }, TEST);
	const servers = await until(s1.servers, isUp("good"));
	assert.deepEqual(
		servers.map((instance) => instance.server),
		["good"],
	);
});

test("unshared servers run per session and location, shared ones once; roots and calls", async (t) => {
	const host = await mcpHost(t, (paths) => ({ files: stdio(paths), browser: stdio(paths, { shared: true }) }));
	const one = host.at("one");
	const two = host.at("two");
	const s1 = await host.worker("s1");
	const s2 = await host.worker("s2");
	await s1.setLocations({ locations: [one] }, TEST);
	await s2.setLocations({ locations: [two] }, TEST);
	await until(s1.servers, (value) => isUp("files")(value) && isUp("browser")(value));
	const owner = await host.owner();
	const all = await until(owner.instances, (value) => isUp("files", 2)(value) && isUp("browser")(value));
	assert.equal(all.length, 3);
	assert.equal(host.starts().length, 3);
	const files = all.find((instance) => instance.server === "files" && instance.location?.cwd === one.cwd)!;
	assert.deepEqual(files.runsOn, "host");
	assert.deepEqual(
		files.tools.map((tool) => tool.name),
		["echo", "whoami", "crash", "grow"],
	);
	assert.equal(all.find((instance) => instance.server === "browser")!.location, null);
	// Each session's own process, at its location with its cwd as the root; the shared one has no roots.
	const first = await whoami(s1, one, "files");
	assert.notEqual(first.pid, (await whoami(s2, two, "files")).pid);
	assert.equal(first.cwd, one.cwd);
	assert.deepEqual(first.roots, [{ uri: pathToFileURL(one.cwd).href }]);
	assert.equal((await whoami(s1, one, "browser")).pid, (await whoami(s2, two, "browser")).pid);
	assert.equal((await whoami(s1, one, "browser")).roots, null);
	assert.equal(
		textOf(await s1.call({ location: one, server: "files", tool: "echo", args: { text: "hi" } }, TEST)),
		"echo: hi",
	);
	// Another session's location is not leased by this worker.
	await assert.rejects(s1.call({ location: two, server: "files", tool: "echo", args: {} }, TEST), /No MCP servers/);
});

test("processes end with their instances: a location left out, the view's end, the host's shutdown", async (t) => {
	const host = await mcpHost(t, (paths) => ({ files: stdio(paths), browser: stdio(paths, { shared: true }) }));
	const one = host.at("one");
	const two = host.at("two");
	const owner = await host.owner();
	const s1 = await host.worker("s1");
	await s1.setLocations({ locations: [one, two] }, TEST);
	await until(owner.instances, (value) => isUp("files", 2)(value) && isUp("browser")(value));
	const atOne = (await whoami(s1, one, "files")).pid;
	const atTwo = (await whoami(s1, two, "files")).pid;
	const shared = (await whoami(s1, one, "browser")).pid;
	await s1.setLocations({ locations: [one] }, TEST);
	await until(owner.instances, (value) => status(value, "files").length === 1);
	await exited(atTwo);
	// The worker's reference goes (its link closed): the view ends and releases its leases.
	s1.release();
	const left = await until(owner.instances, (value) => status(value, "files").length === 0);
	assert.deepEqual(status(left, "browser"), ["connected"]);
	await exited(atOne);
	assert.equal(alive(shared), true);
	await host.shutdown();
	await exited(shared);
});

test("editing mcp.json restarts a changed server and closes a removed one", async (t) => {
	const host = await mcpHost(t, (paths) => ({ files: stdio(paths), docs: stdio(paths) }));
	const one = host.at("one");
	const s1 = await host.worker("s1");
	await s1.setLocations({ locations: [one] }, TEST);
	const before = await until(s1.servers, (value) => isUp("files")(value) && isUp("docs")(value));
	const files = (await whoami(s1, one, "files")).pid;
	const docs = (await whoami(s1, one, "docs")).pid;
	host.configure((paths) => ({ files: stdio(paths, { timeout: 30 }) }));
	const after = await until(
		s1.servers,
		(value) =>
			value.length === 1 && isUp("files")(value) && value[0]!.id !== before.find((i) => i.server === "files")!.id,
	);
	assert.equal(after[0]!.server, "files");
	await exited(files);
	await exited(docs);
	assert.notEqual((await whoami(s1, one, "files")).pid, files);
});

test("generations: only the running current one sets and calls; an older view's end leaves the newer lease", async (t) => {
	const host = await mcpHost(t, (paths) => ({ files: stdio(paths) }));
	const one = host.at("one");
	const older = await host.worker("s1", 1);
	await older.setLocations({ locations: [one] }, TEST);
	const [instance] = await until(older.servers, isUp("files"));
	const pid = (await whoami(older, one, "files")).pid;
	// The session's worker restarts: generation 2 runs now.
	const newer = await host.worker("s1", 2);
	await expectChord(older.setLocations({ locations: [one] }, TEST), "forbidden");
	await expectChord(older.call({ location: one, server: "files", tool: "echo", args: {} }, TEST), "forbidden");
	await newer.setLocations({ locations: [one] }, TEST);
	assert.equal((await until(newer.servers, isUp("files")))[0]!.id, instance!.id);
	assert.equal((await whoami(newer, one, "files")).pid, pid);
	// The older view really ends (another principal: its own object), and releases only its own generation's leases.
	older.release();
	await until(
		host.fixture.host.references(Mcp),
		(references) => !references.some((ref) => ref.principal?.kind === "worker" && ref.principal.generation === 1),
	);
	const leases = await settled(host.manager.leases);
	assert.deepEqual(
		leases.map((lease) => [lease.session, lease.location.cwd]),
		[["s1", one.cwd]],
	);
	assert.equal(alive(pid), true);
	assert.equal(host.starts().length, 1);
	// The manager's own rule, decided on its line: of two generations' concurrent calls, the newer one's leases stay.
	const caller = (generation: number) => ({ session: "s9", generation, incarnation: `i${generation}` });
	await Promise.allSettled([
		host.manager.setLocations({ ...caller(4), locations: [one] }, TEST),
		host.manager.setLocations({ ...caller(3), locations: [host.at("three")] }, TEST),
	]);
	assert.deepEqual(
		host.manager.leases.value.filter((lease) => lease.session === "s9").map((lease) => lease.location.cwd),
		[one.cwd],
	);
	await expectChord(host.manager.setLocations({ ...caller(3), locations: [one] }, TEST), "forbidden");
	await host.manager.setLocations({ ...caller(4), locations: [] }, TEST);
});

test("a worker asking before its start is published waits: then it sets, or a newer generation refuses it", async (t) => {
	const host = await mcpHost(t, (paths) => ({ files: stdio(paths) }));
	const one = host.at("one");
	const early = await host.worker("s1", 1, { stale: true });
	let settledFirst = false;
	const first = early.setLocations({ locations: [one] }, TEST).finally(() => {
		settledFirst = true;
	});
	await settled(host.manager.leases);
	assert.equal(settledFirst, false);
	await host.running("s1", 1);
	await first;
	await until(early.servers, isUp("files"));
	// Another session's worker waits, and the generation published instead is newer.
	const late = await host.worker("s2", 1, { stale: true });
	const refused = late.setLocations({ locations: [one] }, TEST);
	await host.running("s2", 2);
	await expectChord(refused, "forbidden");
	// Releasing the reference ends a waiting call.
	const gone = await host.worker("s3", 1, { stale: true });
	const waiting = gone.setLocations({ locations: [one] }, TEST);
	gone.release();
	await assert.rejects(waiting);
	assert.deepEqual(
		(await settled(host.manager.leases)).map((lease) => lease.session),
		["s1"],
	);
});

test("an invalid mcp.json keeps the last valid servers, also across a reload", async (t) => {
	const host = await mcpHost(t, (paths) => ({ files: stdio(paths) }));
	const one = host.at("one");
	const s1 = await host.worker("s1");
	await s1.setLocations({ locations: [one] }, TEST);
	const [instance] = await until(s1.servers, isUp("files"));
	const pid = (await whoami(s1, one, "files")).pid;
	host.write("{ half saved");
	const owner = await host.owner();
	await until(owner.errors, (errors) => errors.some((error) => /keeping the last valid servers/.test(error)));
	await host.fixture.reload([{ ...mcpServer }]);
	const [after] = await until(s1.servers, (value) => isUp("files")(value) && host.starts().length === 2);
	assert.equal(after!.id, instance!.id);
	assert.equal(alive(pid), false);
	// The restarted reader reads the half-saved file once more before it reports it.
	await until(owner.errors, (errors) =>
		/Invalid mcp.json syntax; keeping the last valid servers/.test(errors.join("\n")),
	);
});

test("a view outlives its last reference by the linger: a worker re-taking it keeps its processes", async (t) => {
	const host = await mcpHost(t, (paths) => ({ files: stdio(paths) }));
	const one = host.at("one");
	await host.running("s1", 1);
	// One worker host (one incarnation) whose object lets go of the view and takes it again.
	const worker = host.fixture.client({ kind: "worker", session: "s1", generation: 1 });
	const first = await holdIn(worker, Mcp, {}, "worker");
	await first.setLocations({ locations: [one] }, TEST);
	await until(first.servers, isUp("files"));
	const pid = (await whoami(first, one, "files")).pid;
	first.release();
	const again = await holdIn(worker, Mcp, {}, "worker");
	assert.equal((await whoami(again, one, "files")).pid, pid);
	assert.equal(host.starts().length, 1);
	again.release();
});

test("another incarnation of the same generation takes the lease; the first one's calls are refused", async (t) => {
	const host = await mcpHost(t, (paths) => ({ files: stdio(paths) }));
	const one = host.at("one");
	// Two hosts with one principal: two incarnations of one worker generation (one view object).
	const first = await host.worker("s1", 2);
	await first.setLocations({ locations: [one] }, TEST);
	await until(first.servers, isUp("files"));
	const second = await host.worker("s1", 2);
	await second.setLocations({ locations: [one] }, TEST);
	await expectChord(
		first.call({ location: one, server: "files", tool: "echo", args: { text: "x" } }, TEST),
		"forbidden",
	);
	assert.equal(
		textOf(await second.call({ location: one, server: "files", tool: "echo", args: { text: "x" } }, TEST)),
		"echo: x",
	);
});

test("placement: environments not in envs.json fail; HTTP servers connect with host variables, per session when unshared, or ask to sign in", async (t) => {
	const authorizations: (string | undefined)[] = [];
	const sessions = new Set<string>();
	const http = createServer((request, response) => {
		if (request.url === "/locked") return void response.writeHead(401).end();
		if (request.method !== "POST") return void response.writeHead(405).end();
		authorizations.push(request.headers.authorization);
		let body = "";
		request.on("data", (chunk: Buffer) => {
			body += chunk.toString();
		});
		request.on("end", () => {
			const message = JSON.parse(body) as { id?: number; method: string };
			if (message.id === undefined) return void response.writeHead(202).end();
			const result =
				message.method === "initialize"
					? {
							protocolVersion: "2025-06-18",
							capabilities: { tools: {} },
							serverInfo: { name: "http-fixture", version: "1.0.0" },
						}
					: message.method === "tools/list"
						? { tools: [{ name: "lookup", inputSchema: { type: "object" } }] }
						: { content: [{ type: "text", text: "found" }] };
			// Each `initialize` opens one MCP session: one per connection of the client.
			const session = message.method === "initialize" ? `m${sessions.size}` : undefined;
			if (session !== undefined) sessions.add(`${request.url}:${session}`);
			response.writeHead(200, {
				"content-type": "application/json",
				...(session === undefined ? {} : { "mcp-session-id": session }),
			});
			response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
		});
	});
	await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise((resolve) => http.close(resolve)));
	const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
	process.env.P2_MCP_TEST_TOKEN = "secret-token";
	t.after(() => delete process.env.P2_MCP_TEST_TOKEN);
	const host = await mcpHost(t, (paths) => ({
		here: stdio(paths),
		gpu: stdio(paths, { runOn: { env: "gpu" } }),
		docs: { url: `${base}/mcp`, headers: { Authorization: `Bearer \${P2_MCP_TEST_TOKEN}` } },
		mine: { url: `${base}/mine`, shared: false },
		locked: { url: `${base}/locked` },
	}));
	const remote = { env: "remote", cwd: "/work" };
	const s1 = await host.worker("s1", 1, { env: "remote" });
	const s2 = await host.worker("s2");
	await s1.setLocations({ locations: [remote] }, TEST);
	await s2.setLocations({ locations: [host.at("two")] }, TEST);
	const servers = await until(
		s1.servers,
		(value) =>
			value.length === 5 && isUp("docs")(value) && isUp("mine")(value) && status(value, "locked")[0] === "sign-in",
	);
	for (const server of ["here", "gpu"]) {
		const instance = servers.find((candidate) => candidate.server === server)!;
		assert.equal(instance.status, "failed");
		// The worker's view leaves the owner's error out.
		assert.equal(instance.error, undefined);
	}
	assert.deepEqual(servers.find((instance) => instance.server === "here")!.runsOn, { env: "remote" });
	assert.deepEqual(servers.find((instance) => instance.server === "gpu")!.runsOn, { env: "gpu" });
	const owner = await host.owner();
	const all = await until(owner.instances, (value) => isUp("mine", 2)(value) && isUp("docs")(value));
	assert.deepEqual(
		all.filter((instance) => instance.server === "here" && instance.location?.env === "remote").map((i) => i.error),
		['environment "remote" is not in envs.json'],
	);
	// One shared docs connection for both sessions, one unshared one per session.
	assert.equal(status(all, "docs").length, 1);
	assert.equal([...sessions].filter((session) => session.startsWith("/mine:")).length, 2);
	// Only s2's own stdio server runs on this machine; s1's are on environments.
	await until(s2.servers, isUp("here"));
	assert.equal(host.starts().length, 1);
	assert.ok(authorizations.includes("Bearer secret-token"));
	assert.equal(textOf(await s1.call({ location: remote, server: "docs", tool: "lookup", args: {} }, TEST)), "found");
	// A call of a server waiting for a sign-in tells the model where the user signs in.
	await assert.rejects(
		s1.call({ location: remote, server: "locked", tool: "lookup", args: {} }, TEST),
		/needs a sign-in: ask the user to sign in from the MCP panel in p2's sidebar \(or at \/mcp\/sign-in\/locked on p2\)/,
	);
});

test("a project's mcp.json: its servers run at its location for its session, it turns the owner's on and off there, refusals are reported", async (t) => {
	const host = await mcpHost(t, (paths) => ({ files: stdio(paths), off: stdio(paths, { enabled: false }) }));
	const one = host.at("one");
	const two = host.at("two");
	const project = {
		location: one,
		text: JSON.stringify({
			mcpServers: {
				lint: { command: process.execPath, args: [FIXTURE], env: { MCP_FIXTURE_RAW: `\${HOME}` } },
				files: { enabled: false },
				off: { enabled: true },
				remote: { url: "https://example.com/mcp" },
			},
		}),
	};
	const s1 = await host.worker("s1");
	const s2 = await host.worker("s2");
	await s1.setLocations(
		{ locations: [one, two], projects: [project, { location: two, error: "permission denied" }] },
		TEST,
	);
	await s2.setLocations({ locations: [one] }, TEST);
	const servers = await until(
		s1.servers,
		(value) => value.length === 3 && value.every((i) => i.status === "connected"),
	);
	assert.deepEqual(
		servers.map((instance) => [instance.server, instance.source, instance.location?.cwd, instance.runsOn]),
		[
			["files", "owner", two.cwd, "host"],
			["lint", "project", one.cwd, "host"],
			["off", "owner", one.cwd, "host"],
		],
	);
	// The project's server runs at its location, its variables as written.
	const lint = await whoami(s1, one, "lint");
	assert.equal(lint.cwd, one.cwd);
	assert.equal(lint.vars.MCP_FIXTURE_RAW, `\${HOME}`);
	await assert.rejects(
		s1.call({ location: one, server: "files", tool: "echo", args: {} }, TEST),
		/MCP server "files" is not configured at/,
	);
	const errors = s1.errors.value.join("\n");
	assert.equal(s1.errors.value.length, 2, errors);
	assert.match(errors, /: \.pi\/mcp\.json: server "remote": HTTP servers are for the owner's mcp\.json/);
	assert.match(errors, /: \.pi\/mcp\.json: permission denied/);
	// Another session at the same location without a project: the owner's servers only; the owner sees every error.
	assert.deepEqual(
		(await until(s2.servers, isUp("files"))).map((instance) => instance.server),
		["files"],
	);
	const owner = await host.owner();
	assert.deepEqual(
		(await until(owner.errors, (value) => value.length === 2)).map((error) => error.startsWith("session s1: ")),
		[true, true],
	);
	// The project file gone: its server ends, the owner's servers are as configured again.
	await s1.setLocations({ locations: [one] }, TEST);
	await until(s1.servers, (value) => value.length === 1 && isUp("files")(value));
	await exited(lint.pid);
	assert.deepEqual(await until(s1.errors, (value) => value.length === 0), []);
});

test("a lease gets servers only on environments its session works on: its own, its subagents' own locations'", async (t) => {
	const host = await mcpHost(t, (paths) => ({ files: stdio(paths) }));
	const one = host.at("one");
	const gpu = { env: "gpu", cwd: "/work" };
	const s1 = await host.worker("s1");
	await s1.setLocations({ locations: [one, gpu] }, TEST);
	const [here] = await until(s1.servers, isUp("files"));
	assert.equal(here!.location?.cwd, one.cwd);
	assert.deepEqual(s1.errors.value, ["gpu:/work: not where this session works"]);
	// A subagent working on gpu in its own location: the lease there gets its servers (gpu is not in envs.json).
	const child = {
		name: "own",
		conversationId: 2,
		model: "faux",
		thinkingLevel: "off",
		tools: [],
		location: { env: "gpu", cwd: "/elsewhere" },
		lastEntryId: 0,
	};
	await host.subagents("s1", [child]);
	const both = await until(s1.servers, (value) => value.length === 2);
	assert.deepEqual(both.map((instance) => [instance.location?.env ?? "this machine", instance.status]).sort(), [
		["gpu", "failed"],
		["this machine", "connected"],
	]);
	assert.deepEqual(await until(s1.errors, (value) => value.length === 0), []);
	// The subagent gone and the session moved to gpu: this machine is no longer where it works.
	await host.subagents("s1", []);
	await host.move("s1", "gpu");
	const moved = await until(s1.servers, (value) => value.length === 1 && value[0]!.location?.env === "gpu");
	assert.equal(moved[0]!.status, "failed");
	assert.deepEqual(s1.errors.value, [`${one.cwd}: not where this session works`]);
});

test(
	"environments: servers start through the environment's pi-env daemon, on one connection that closes with the last instance",
	{ skip: existsSync(DAEMON) ? false : `no pi-env daemon at ${DAEMON} (npm run build:daemon in packages/env)` },
	async (t) => {
		// The "environment" is this machine through a local daemon: no SSH, the same operations.
		const connections: Connection[] = [];
		const facet = mcpServerFacet(LINGER_MS, () => () => {
			const connection = new Connection({ command: [DAEMON] });
			connections.push(connection);
			return connection;
		});
		const host = await mcpHost(
			t,
			(paths) => ({ files: stdio(paths), tools: stdio(paths, { runOn: { env: "box" }, cwd: "~" }) }),
			{ envs: { box: { type: "ssh", host: "box.invalid" } }, facet },
		);
		const there = { env: "box", cwd: host.at("work").cwd };
		const s1 = await host.worker("s1", 1, { env: "box" });
		await s1.setLocations({ locations: [there] }, TEST);
		const servers = await until(s1.servers, (value) => isUp("files")(value) && isUp("tools")(value));
		assert.deepEqual(
			servers.map((instance) => [instance.server, instance.runsOn]),
			[
				["files", { env: "box" }],
				["tools", { env: "box" }],
			],
		);
		assert.equal(connections.length, 1);
		const daemon = (await connections[0]!.info()).pid;
		// Both run under the one daemon with the location as their root: `files` at the location, `tools` at its cwd `~`,
		// the environment's home.
		const files = await whoami(s1, there, "files");
		const tools = await whoami(s1, there, "tools");
		assert.deepEqual([files.ppid, tools.ppid], [daemon, daemon]);
		assert.equal(files.cwd, there.cwd);
		assert.deepEqual(files.roots, [{ uri: pathToFileURL(there.cwd).href }]);
		assert.equal(tools.cwd, homedir());
		assert.deepEqual(tools.roots, files.roots);
		assert.equal(
			textOf(await s1.call({ location: there, server: "files", tool: "echo", args: { text: "far" } }, TEST)),
			"echo: far",
		);
		// The last instance there closes the connection: the daemon ends, and the servers with it.
		await s1.setLocations({ locations: [] }, TEST);
		await exited(files.pid);
		await exited(tools.pid);
		await exited(daemon);
		assert.equal(connections.length, 1);
	},
);

test("a reload of the plugin keeps the leases and the tools: the new supervisor starts what they use", async (t) => {
	const host = await mcpHost(t, (paths) => ({ files: stdio(paths) }));
	const one = host.at("one");
	const s1 = await host.worker("s1");
	await s1.setLocations({ locations: [one] }, TEST);
	const [before] = await until(s1.servers, isUp("files"));
	let fewest = before!.tools.length;
	const stop = follow(s1.servers, (servers) => {
		fewest = Math.min(fewest, servers[0]?.tools.length ?? 0);
	});
	// The manager's memento of the listed tools is written a moment after the list changed: let it catch up.
	await settled(host.manager.instances);
	// A new facet value: a reload, not the same code again.
	await host.fixture.reload([{ ...mcpServer }]);
	const [after] = await until(s1.servers, (value) => isUp("files")(value) && host.starts().length === 2);
	stop();
	assert.equal(after!.id, before!.id);
	assert.equal(fewest, 4);
	assert.equal(
		textOf(await s1.call({ location: one, server: "files", tool: "echo", args: { text: "again" } }, TEST)),
		"echo: again",
	);
});

test("guests get no MCP servers", async (t) => {
	const host = await mcpHost(t, (paths) => ({ files: stdio(paths) }));
	const error = await failureOf(host.fixture.client(GUEST).hold(Mcp, {}, TEST));
	assert.equal(error.code, "forbidden");
});
