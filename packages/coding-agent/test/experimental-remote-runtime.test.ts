import { lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Context, createFacetHost, defineFacet, defineService } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Client, ServerError as ClientServerError } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ExampleFacetService } from "../examples/plugins/pi-example-plugin/src/contract.ts";
import { runClient } from "../src/experimental/client.ts";
import { activateBuiltinClientServices, openClientRuntime } from "../src/experimental/client-runtime.ts";
import { createPresentationFacetLoaders } from "../src/experimental/plugins/bundled.ts";
import * as processRuntime from "../src/experimental/process.ts";
import { type RunningServer, startServer } from "../src/experimental/server.ts";
import { AgentController } from "../src/experimental/services/agent-controller.ts";
import { createSessionServiceSource, type SessionAttachmentState } from "../src/experimental/services/connection.ts";
import { Models } from "../src/experimental/services/models.ts";
import { PresentationPlugins, SessionPlugins } from "../src/experimental/services/plugins.ts";
import { SessionDirectory, SessionManagement } from "../src/experimental/services/sessions.ts";
import { Transcript } from "../src/experimental/services/transcript.ts";
import { createServerServiceBinding, createSessionServiceBinding } from "./experimental-service-binding.ts";
import {
	configureExperimentalWorkerModel,
	createExperimentalSessions,
	readExperimentalSessionState,
} from "./experimental-session-support.ts";
import { KeyedProbe } from "./fixtures/keyed-service.ts";

const servers = new Set<RunningServer>();
const clients = new Set<Client>();
const directories = new Set<string>();
const fauxWorkerEntryUrl = new URL("fixtures/faux-session-worker.ts", import.meta.url);
const realSpawnInternalProcess = processRuntime.spawnInternalProcess;
const sessionWorkerModel = { provider: "anthropic", model: "claude-sonnet-4-5" } as const;
const SecondPluginService = defineService<{ read(context: Context): Promise<string> }>("test.second-plugin");
let agentDir: string;

beforeEach(async () => {
	agentDir = await mkdtemp(join("/tmp", "pi-experimental-agent-"));
	directories.add(agentDir);
	await configureExperimentalWorkerModel(agentDir);
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	await createExperimentalSessions(join(agentDir, "experimental", "sessions"), ["demo-1", "demo-2"]);
});

async function makeServer(): Promise<{ directory: string; runtime: RunningServer }> {
	const directory = await mkdtemp(join("/tmp", "pes-"));
	directories.add(directory);
	const runtime = await startServer({ ...sessionWorkerModel, directory });
	servers.add(runtime);
	return { directory, runtime };
}

async function attachSession(client: Client, sessionId: string): Promise<void> {
	const services = createServerServiceBinding(client, { services: [SessionManagement] });
	try {
		await services.ready(BACKGROUND_CONTEXT);
		await services.use(SessionManagement).attach(sessionId, BACKGROUND_CONTEXT);
	} finally {
		await services.dispose(BACKGROUND_CONTEXT);
	}
}

async function attachClient(runtime: RunningServer, sessionId: string): Promise<Client> {
	const client = await Client.connect({
		serverId: runtime.serverId,
		transportFactory: createUnixTransportFactory({ path: runtime.socketPath }),
	});
	clients.add(client);
	await attachSession(client, sessionId);
	return client;
}

afterEach(async () => {
	await Promise.all([...clients].map((client) => client.dispose()));
	clients.clear();
	await Promise.all([...servers].map((server) => server.close()));
	servers.clear();
	vi.unstubAllEnvs();
	await Promise.all([...directories].map((directory) => rm(directory, { recursive: true, force: true })));
	directories.clear();
});

describe("experimental durable server composition", () => {
	test("uses PI_SERVER_DIR and PI_SERVER_ID", async () => {
		const directory = await mkdtemp(join("/tmp", "pi-server-dir-"));
		directories.add(directory);
		const serverId = "00000000-0000-4000-8000-000000000001";
		vi.stubEnv("PI_SERVER_DIR", directory);
		vi.stubEnv("PI_SERVER_ID", serverId);
		const runtime = await startServer();
		servers.add(runtime);

		expect(runtime.serverId).toBe(serverId);
		expect(runtime.socketPath).toBe(join(directory, `${serverId}.sock`));
		expect((await lstat(directory)).mode & 0o777).toBe(0o700);
		const publicSocket = await lstat(runtime.socketPath);
		const controlSocket = await lstat(join(directory, `control-${runtime.serverId}.sock`));
		expect(publicSocket.isSocket()).toBe(true);
		expect(publicSocket.mode & 0o777).toBe(0o600);
		expect(controlSocket.isSocket()).toBe(true);
		expect(controlSocket.mode & 0o777).toBe(0o600);
		const entries = await readdir(directory);
		expect(entries).toHaveLength(3);
		expect(entries.every((entry) => !entry.startsWith("."))).toBe(true);
		expect(entries).toContain(`${serverId}.sock`);
		expect(entries).toContain(`control-${serverId}.sock`);
		expect(entries).toContainEqual(expect.stringMatching(new RegExp(`^server-${serverId}-[0-9a-f]{12}\\.sock$`)));
		await expect(runClient({ command: "client" })).resolves.toMatchObject({
			kind: "list",
			sessions: [{ sessionId: "demo-1" }, { sessionId: "demo-2" }],
		});
	});

	test("rejects a provider without a model", async () => {
		const directory = await mkdtemp(join("/tmp", "pes-"));
		directories.add(directory);
		await expect(startServer({ directory, provider: "anthropic" })).rejects.toThrow("provider requires a model");
	});

	test("preserves an existing Session model when the server default changes", async () => {
		await writeFile(
			join(agentDir, "settings.json"),
			JSON.stringify({ defaultProvider: "anthropic", defaultModel: "claude-opus-4-6" }),
		);
		const directory = await mkdtemp(join("/tmp", "pes-"));
		directories.add(directory);
		const first = await startServer({ directory });
		servers.add(first);
		const firstClient = await attachClient(first, "demo-1");
		await firstClient.dispose();
		clients.delete(firstClient);
		await expect.poll(() => first.workerPids.has("demo-1")).toBe(false);
		await first.close();

		const second = await startServer({ ...sessionWorkerModel, directory });
		servers.add(second);
		const secondClient = await attachClient(second, "demo-1");
		await secondClient.dispose();
		clients.delete(secondClient);
		await expect.poll(() => second.workerPids.has("demo-1")).toBe(false);
		const state = await readExperimentalSessionState(second.sessionDir, "demo-1");
		expect(state.model).toEqual({ provider: "anthropic", modelId: "claude-opus-4-6" });
	});

	test("rejects model options when discovery selects an existing server", async () => {
		const { directory } = await makeServer();
		await expect(runClient({ command: "client", model: "anthropic/claude-opus-4-6" }, { directory })).rejects.toThrow(
			"Model selection is only valid when automatically activating a new server",
		);
	});

	test("rechecks an auto-discovered server after a version mismatch", async () => {
		const { directory, runtime } = await makeServer();
		const connect = Client.connect.bind(Client);
		vi.spyOn(Client, "connect")
			.mockRejectedValueOnce(new ClientServerError({ code: "version", message: "stale server" }))
			.mockImplementation((options) => connect(options));
		const clientRuntime = await openClientRuntime({ command: "client" }, { directory });
		try {
			expect(clientRuntime.servers.map(({ route }) => route.serverId)).toEqual([runtime.serverId]);
		} finally {
			await clientRuntime.dispose();
		}
	});

	test("serializes concurrent cold activation and retires after both clients leave", async () => {
		const directory = await mkdtemp(join("/tmp", "pi-auto-server-"));
		directories.add(directory);
		const serverId = "00000000-0000-4000-8000-000000000001";
		vi.stubEnv("PI_SERVER_DIR", directory);
		vi.stubEnv("PI_SERVER_ID", serverId);

		const results = await Promise.all([runClient({ command: "client" }), runClient({ command: "client" })]);
		expect(results).toEqual([
			{
				kind: "list",
				sessions: [
					{ serverId, sessionId: "demo-1" },
					{ serverId, sessionId: "demo-2" },
				],
			},
			{
				kind: "list",
				sessions: [
					{ serverId, sessionId: "demo-1" },
					{ serverId, sessionId: "demo-2" },
				],
			},
		]);
		expect(await pathExists(join(directory, `${serverId}.sock`))).toBe(true);
		await expect.poll(() => pathExists(join(directory, `${serverId}.sock`)), { timeout: 5_000 }).toBe(false);
		await expect.poll(() => pathExists(join(directory, `control-${serverId}.sock`)), { timeout: 5_000 }).toBe(false);
	});

	test("passes client plugin packages to a cold server and restores them for its next generation", async () => {
		const directory = await mkdtemp(join("/tmp", "pi-auto-plugin-"));
		directories.add(directory);
		const serverId = "00000000-0000-4000-8000-000000000001";
		const packagePath = fileURLToPath(new URL("../examples/plugins/pi-example-plugin", import.meta.url));
		vi.stubEnv("PI_SERVER_DIR", directory);
		vi.stubEnv("PI_SERVER_ID", serverId);

		const first = await openClientRuntime({ command: "client", ...sessionWorkerModel });
		try {
			const activated = await activateBuiltinClientServices(first.servers[0]!);
			const presentationPlugins = await activated.plugins.prepareSession(
				{ sessionId: "demo-1", packagePaths: [packagePath] },
				BACKGROUND_CONTEXT,
			);
			await activated.management.attach("demo-1", BACKGROUND_CONTEXT);
			const loaded = await createPresentationFacetLoaders(presentationPlugins)[0]!.load();
			expect(loaded.facets.map(({ id }) => id)).toEqual(["@earendil-works/pi-example-plugin/tui"]);
			await loaded.dispose();
		} finally {
			await first.dispose();
		}
		await expect.poll(() => pathExists(join(directory, `${serverId}.sock`)), { timeout: 5_000 }).toBe(false);

		const second = await openClientRuntime({ command: "client", ...sessionWorkerModel });
		try {
			const activated = await activateBuiltinClientServices(second.servers[0]!);
			const presentationPlugins = await activated.plugins.prepareSession(
				{ sessionId: "demo-1", packagePaths: null },
				BACKGROUND_CONTEXT,
			);
			await activated.management.attach("demo-1", BACKGROUND_CONTEXT);
			expect(createPresentationFacetLoaders(presentationPlugins)).toHaveLength(1);
		} finally {
			await second.dispose();
		}
	});

	test("retires a cold server after its only Session attachment disconnects", async () => {
		const directory = await mkdtemp(join("/tmp", "pi-auto-session-"));
		directories.add(directory);
		const serverId = "00000000-0000-4000-8000-000000000001";
		vi.stubEnv("PI_SERVER_DIR", directory);
		vi.stubEnv("PI_SERVER_ID", serverId);

		await expect(runClient({ command: "client", sessionId: "demo-1", ...sessionWorkerModel })).resolves.toEqual({
			kind: "attached",
			serverId,
			sessionId: "demo-1",
		});
		await expect.poll(() => pathExists(join(directory, `${serverId}.sock`)), { timeout: 5_000 }).toBe(false);
		await expect.poll(() => pathExists(join(directory, `control-${serverId}.sock`)), { timeout: 5_000 }).toBe(false);
	});

	test("runs and discovers multiple logical servers from one directory", async () => {
		const directory = await mkdtemp(join("/tmp", "pi-multi-server-"));
		directories.add(directory);
		const firstId = "00000000-0000-4000-8000-000000000001";
		const secondId = "00000000-0000-4000-8000-000000000002";
		const [first, second] = await Promise.all([
			startServer({ directory, serverId: firstId }),
			startServer({ directory, serverId: secondId }),
		]);
		servers.add(first);
		servers.add(second);

		expect((await lstat(join(directory, `control-${firstId}.sock`))).isSocket()).toBe(true);
		expect((await lstat(join(directory, `control-${secondId}.sock`))).isSocket()).toBe(true);
		await expect(runClient({ command: "client" }, { directory })).resolves.toEqual({
			kind: "list",
			sessions: [
				{ serverId: firstId, sessionId: "demo-1" },
				{ serverId: firstId, sessionId: "demo-2" },
				{ serverId: secondId, sessionId: "demo-1" },
				{ serverId: secondId, sessionId: "demo-2" },
			],
		});

		await first.close();
		await expect.poll(() => pathExists(first.socketPath)).toBe(false);
		await expect(runClient({ command: "client" }, { directory })).resolves.toEqual({
			kind: "list",
			sessions: [
				{ serverId: secondId, sessionId: "demo-1" },
				{ serverId: secondId, sessionId: "demo-2" },
			],
		});
	});

	test("hydrates and mutates server Session services across framed clients", async () => {
		const { runtime } = await makeServer();
		const firstClient = await Client.connect({
			serverId: runtime.serverId,
			transportFactory: createUnixTransportFactory({ path: runtime.socketPath }),
		});
		const secondClient = await Client.connect({
			serverId: runtime.serverId,
			transportFactory: createUnixTransportFactory({ path: runtime.socketPath }),
		});
		clients.add(firstClient);
		clients.add(secondClient);
		const errors: Error[] = [];
		const firstServices = createServerServiceBinding(firstClient, {
			services: [SessionDirectory, SessionManagement],
			onError: (error) => errors.push(error),
		});
		const secondServices = createServerServiceBinding(secondClient, {
			services: [SessionDirectory, SessionManagement],
			onError: (error) => errors.push(error),
		});
		expect(firstServices.connection.value).toMatchObject({ status: "connected" });
		expect(secondServices.connection.value).toMatchObject({ status: "connected" });
		await expect(firstServices.catalogue(BACKGROUND_CONTEXT)).resolves.toEqual([
			{ serviceId: SessionDirectory.id, mode: "singleton" },
			{ serviceId: SessionManagement.id, mode: "singleton" },
			{ serviceId: PresentationPlugins.id, mode: "singleton" },
		]);
		const firstDirectory = firstServices.use(SessionDirectory);
		const secondDirectory = secondServices.use(SessionDirectory);
		const firstManagement = firstServices.use(SessionManagement);
		const secondManagement = secondServices.use(SessionManagement);

		await Promise.all([firstServices.ready(BACKGROUND_CONTEXT), secondServices.ready(BACKGROUND_CONTEXT)]);
		expect(firstDirectory.state.value?.sessions.map(({ sessionId }) => sessionId)).toEqual(["demo-1", "demo-2"]);
		expect(secondDirectory.state.value).toEqual(firstDirectory.state.value);
		await firstManagement.create({ id: "demo-3" }, BACKGROUND_CONTEXT);
		await vi.waitFor(() => {
			expect(firstDirectory.state.value?.sessions.map(({ sessionId }) => sessionId)).toContain("demo-3");
			expect(secondDirectory.state.value).toEqual(firstDirectory.state.value);
		});

		await Promise.all([
			firstManagement.attach("demo-1", BACKGROUND_CONTEXT),
			secondManagement.attach("demo-1", BACKGROUND_CONTEXT),
		]);
		expect(firstClient.attachment?.sessionId).toBe("demo-1");
		expect(secondClient.attachment?.sessionId).toBe("demo-1");
		await firstManagement.remove("demo-1", BACKGROUND_CONTEXT);
		await vi.waitFor(() => {
			expect(firstClient.attachment).toBeUndefined();
			expect(secondClient.attachment).toBeUndefined();
			expect(firstDirectory.state.value?.sessions.map(({ sessionId }) => sessionId)).not.toContain("demo-1");
			expect(secondDirectory.state.value).toEqual(firstDirectory.state.value);
		});
		await secondManagement.detach(BACKGROUND_CONTEXT);
		expect(errors).toEqual([]);

		await Promise.all([firstServices.dispose(BACKGROUND_CONTEXT), secondServices.dispose(BACKGROUND_CONTEXT)]);
	});

	test("hydrates and updates the Models service across concurrent framed clients", async () => {
		const { runtime } = await makeServer();
		const firstClient = await attachClient(runtime, "demo-1");
		const workerPid = runtime.workerPids.get("demo-1");
		expect(workerPid).toEqual(expect.any(Number));
		const secondClient = await attachClient(runtime, "demo-1");
		expect(runtime.workerPids.get("demo-1")).toBe(workerPid);
		const errors: Error[] = [];
		const firstServices = createSessionServiceBinding(firstClient, {
			services: [Models],
			onError: (error) => errors.push(error),
		});
		const secondServices = createSessionServiceBinding(secondClient, {
			services: [Models],
			onError: (error) => errors.push(error),
		});
		const firstModels = firstServices.use(Models);
		const secondModels = secondServices.use(Models);

		await Promise.all([firstServices.ready(BACKGROUND_CONTEXT), secondServices.ready(BACKGROUND_CONTEXT)]);
		expect(firstServices.attachment.value).toEqual({ status: "attached", sessionId: "demo-1" });
		expect(secondServices.attachment.value).toEqual({ status: "attached", sessionId: "demo-1" });
		expect(firstModels.state.value?.configuration.model).toEqual({
			provider: "anthropic",
			modelId: "claude-sonnet-4-5",
		});
		expect(secondModels.state.value).toEqual(firstModels.state.value);
		const previousThinking = firstModels.state.value!.configuration.thinkingLevel;
		await firstModels.cycleThinking(BACKGROUND_CONTEXT);
		await vi.waitFor(() => {
			expect(firstModels.state.value!.configuration.thinkingLevel).not.toBe(previousThinking);
			expect(secondModels.state.value).toEqual(firstModels.state.value);
		});
		expect(errors).toEqual([]);

		await Promise.all([firstServices.dispose(BACKGROUND_CONTEXT), secondServices.dispose(BACKGROUND_CONTEXT)]);
	});

	test("loads conventional Session facets from multiple configured plugin packages", async () => {
		const directory = await mkdtemp(join("/tmp", "pes-plugin-"));
		directories.add(directory);
		const secondPackagePath = join(directory, "second-plugin");
		await mkdir(join(secondPackagePath, "src"), { recursive: true });
		await Promise.all([
			writeFile(
				join(secondPackagePath, "package.json"),
				`${JSON.stringify({
					name: "@earendil-works/second-session-plugin",
					version: "1.0.0",
					peerDependencies: { "@earendil-works/chord": "^0.84.4" },
				})}\n`,
			),
			writeFile(
				join(secondPackagePath, "src", "session.ts"),
				'import { defineFacet, defineService } from "@earendil-works/chord"; const Service = defineService("test.second-plugin"); export default defineFacet({ id: "second-session-plugin", setup(env) { env.provide(Service, { async read() { return "second"; } }); } });\n',
			),
		]);
		const runtime = await startServer({ ...sessionWorkerModel, directory });
		servers.add(runtime);
		const clientRuntime = await openClientRuntime({ command: "client" }, { directory });
		const activated = await activateBuiltinClientServices(clientRuntime.servers[0]!);
		await activated.plugins.prepareSession(
			{
				sessionId: "demo-1",
				packagePaths: [
					fileURLToPath(new URL("../examples/plugins/pi-example-plugin", import.meta.url)),
					secondPackagePath,
				],
			},
			BACKGROUND_CONTEXT,
		);
		await activated.management.attach("demo-1", BACKGROUND_CONTEXT);
		const services = createSessionServiceBinding(clientRuntime.servers[0]!.client, {
			services: [ExampleFacetService, SecondPluginService],
		});
		try {
			await services.ready(BACKGROUND_CONTEXT);
			await expect(
				services.use(ExampleFacetService).greet({ name: "Armin" }, BACKGROUND_CONTEXT),
			).resolves.toMatchObject({ workerActivations: 1 });
			await expect(services.use(SecondPluginService).read(BACKGROUND_CONTEXT)).resolves.toBe("second");
		} finally {
			await services.dispose(BACKGROUND_CONTEXT);
			await clientRuntime.dispose();
		}
	});

	test("uses the most recently selected model for a new Session", async () => {
		const directory = await mkdtemp(join("/tmp", "pes-model-default-"));
		directories.add(directory);
		const runtime = await startServer({ directory });
		servers.add(runtime);
		const firstClient = await attachClient(runtime, "demo-1");
		const firstServices = createSessionServiceBinding(firstClient, { services: [Models] });
		const firstModels = firstServices.use(Models);
		await firstServices.ready(BACKGROUND_CONTEXT);
		await firstModels.select({ provider: "anthropic", modelId: "claude-opus-4-6" }, BACKGROUND_CONTEXT);
		await firstServices.dispose(BACKGROUND_CONTEXT);
		await firstClient.dispose();
		clients.delete(firstClient);
		await expect.poll(() => runtime.workerPids.has("demo-1")).toBe(false);

		const secondClient = await attachClient(runtime, "demo-2");
		const secondServices = createSessionServiceBinding(secondClient, { services: [Models] });
		const secondModels = secondServices.use(Models);
		await secondServices.ready(BACKGROUND_CONTEXT);
		expect(secondModels.state.value?.configuration.model).toEqual({
			provider: "anthropic",
			modelId: "claude-opus-4-6",
		});
		await secondServices.dispose(BACKGROUND_CONTEXT);
	});

	test("composes management attachment with Session service hydration", async () => {
		const { runtime } = await makeServer();
		const clientRuntime = await openClientRuntime({
			command: "client",
			connect: { transport: "unix", path: runtime.socketPath },
		});
		try {
			const server = await activateBuiltinClientServices(clientRuntime.servers[0]!);
			await server.plugins.prepareSession({ sessionId: "demo-1", packagePaths: null }, BACKGROUND_CONTEXT);
			await server.management.attach("demo-1", BACKGROUND_CONTEXT);

			expect(server.session.attachment.value).toEqual({ status: "attached", sessionId: "demo-1" });
			expect(server.models.state.value?.configuration.model).toEqual({
				provider: "anthropic",
				modelId: "claude-sonnet-4-5",
			});
		} finally {
			await clientRuntime.dispose();
		}
	});

	test("fences superseded attachment hydration by attachment generation", async ({ onTestFinished }) => {
		const { runtime } = await makeServer();
		const client = await Client.connect({
			serverId: runtime.serverId,
			transportFactory: createUnixTransportFactory({ path: runtime.socketPath }),
		});
		clients.add(client);
		const errors: Error[] = [];
		const services = createSessionServiceBinding(client, {
			services: [Models],
			onError: (error) => errors.push(error),
		});
		const models = services.use(Models);
		await services.ready(BACKGROUND_CONTEXT);
		const states: SessionAttachmentState[] = [];
		const removeStateListener = services.attachment.subscribe((state) => states.push(state));
		let releaseDelay!: () => void;
		const delayed = new Promise<void>((resolve) => {
			releaseDelay = resolve;
		});
		const subscribeService = client.subscribeService.bind(client);
		const subscribe = vi
			.spyOn(client, "subscribeService")
			.mockImplementation(async (target, serviceId, mode, listener, signal) => {
				if ("sessionId" in target && target.sessionId === "demo-2" && serviceId === Models.id) {
					await delayed;
				}
				return subscribeService(target, serviceId, mode, listener, signal);
			});
		onTestFinished(() => subscribe.mockRestore());

		try {
			await attachSession(client, "demo-2");
			expect(services.attachment.value).toEqual({ status: "attaching", sessionId: "demo-2" });
			await attachSession(client, "demo-1");
			await services.whenAttached("demo-1", BACKGROUND_CONTEXT);
			expect(services.attachment.value).toEqual({ status: "attached", sessionId: "demo-1" });
			expect(models.state.value?.configuration.model).toEqual({
				provider: "anthropic",
				modelId: "claude-sonnet-4-5",
			});
		} finally {
			releaseDelay();
			removeStateListener();
			await services.dispose(BACKGROUND_CONTEXT);
		}

		const latestAttach = states
			.map((state) => state.status === "attaching" && state.sessionId === "demo-1")
			.lastIndexOf(true);
		expect(latestAttach).toBeGreaterThanOrEqual(0);
		expect(states.slice(latestAttach)).not.toContainEqual({ status: "attached", sessionId: "demo-2" });
		expect(states.slice(latestAttach)).not.toContainEqual({ status: "degraded", sessionId: "demo-2" });
		expect(errors).toEqual([]);
	});

	test("observes keyed service instances and fences replacement generations over framed transport", async ({
		onTestFinished,
	}) => {
		const spawn = vi
			.spyOn(processRuntime, "spawnInternalProcess")
			.mockImplementation((role, args, options) =>
				realSpawnInternalProcess(
					role,
					args,
					role === "session-worker" ? { ...options, entryUrl: fauxWorkerEntryUrl } : options,
				),
			);
		onTestFinished(() => spawn.mockRestore());
		const { runtime } = await makeServer();
		const client = await attachClient(runtime, "demo-1");
		const errors: Error[] = [];
		const services = createSessionServiceSource(client, {
			onError: (error) => errors.push(error),
		});
		await expect(services.catalogue(BACKGROUND_CONTEXT)).resolves.toContainEqual({
			serviceId: KeyedProbe.id,
			mode: "keyed",
		});
		const observed: { service: KeyedProbe; value: string | undefined }[] = [];
		const consumer = defineFacet({
			id: "@test/keyed-probe-consumer",
			setup(env) {
				env.observe(KeyedProbe, (service) => {
					observed.push({ service, value: service.state.value?.value });
				});
			},
		});
		const facetHost = await createFacetHost({ facets: [consumer], serviceSources: [services] });

		expect(services.attachment.value).toEqual({ status: "attached", sessionId: "demo-1" });
		await vi.waitFor(() => expect(observed).toHaveLength(1));
		expect(observed[0]!.value).toBe("first");
		const staleReplace = observed[0]!.service.replace;
		await expect(staleReplace("second", BACKGROUND_CONTEXT)).resolves.toBeUndefined();
		await vi.waitFor(() => expect(observed).toHaveLength(2));
		expect(observed[1]!.value).toBe("second");
		expect(() => staleReplace("late", BACKGROUND_CONTEXT)).toThrow("observation is closed");

		const replacedReplace = observed[1]!.service.replace;
		await expect(attachSession(client, "demo-2")).resolves.toBeUndefined();
		await services.whenAttached("demo-2", BACKGROUND_CONTEXT);
		expect(observed).toHaveLength(3);
		expect(services.attachment.value).toEqual({ status: "attached", sessionId: "demo-2" });
		expect(observed[2]!.value).toBe("first");
		expect(() => replacedReplace("late", BACKGROUND_CONTEXT)).toThrow("observation is closed");
		expect(errors).toEqual([]);

		await facetHost.dispose();
		await expect(services.dispose(BACKGROUND_CONTEXT)).resolves.toBeUndefined();
	});

	test("streams prompt events through the worker-owned service provider", async ({ onTestFinished }) => {
		const spawn = vi
			.spyOn(processRuntime, "spawnInternalProcess")
			.mockImplementation((role, args, options) =>
				realSpawnInternalProcess(
					role,
					args,
					role === "session-worker" ? { ...options, entryUrl: fauxWorkerEntryUrl } : options,
				),
			);
		onTestFinished(() => spawn.mockRestore());
		const { directory } = await makeServer();
		const eventTypes: string[] = [];

		const result = await runClient(
			{ command: "client", sessionId: "demo-1", prompt: "question" },
			{
				directory,
				onEvent(event) {
					eventTypes.push(event.type);
				},
			},
		);

		expect(result).toMatchObject({ kind: "prompted", text: "deterministic remote answer" });
		expect(eventTypes).toEqual(
			expect.arrayContaining([
				"run_start",
				"message_start",
				"message_update",
				"message_end",
				"entry_added",
				"run_end",
			]),
		);
	});

	test("replicates terminal operation state after consecutive prompts", async ({ onTestFinished }) => {
		const spawn = vi
			.spyOn(processRuntime, "spawnInternalProcess")
			.mockImplementation((role, args, options) =>
				realSpawnInternalProcess(
					role,
					args,
					role === "session-worker" ? { ...options, entryUrl: fauxWorkerEntryUrl } : options,
				),
			);
		onTestFinished(() => spawn.mockRestore());
		const { runtime } = await makeServer();
		const client = await attachClient(runtime, "demo-1");
		const services = createSessionServiceBinding(client, { services: [AgentController, SessionPlugins, Transcript] });
		const controller = services.use(AgentController);
		const transcript = services.use(Transcript);
		await services.ready(BACKGROUND_CONTEXT);
		await services.use(SessionPlugins).reload(BACKGROUND_CONTEXT);
		try {
			for (const message of ["first question", "second question"]) {
				const response = await controller.prompt({ message, images: null }, BACKGROUND_CONTEXT);
				expect(response).toMatchObject({ accepted: true, operationId: expect.any(String) });
				await vi.waitFor(() => {
					expect(transcript.state.value?.snapshot).toMatchObject({
						operation: null,
						lastResult: { operationId: response.operationId },
					});
				});
			}
		} finally {
			await services.dispose(BACKGROUND_CONTEXT);
		}
	});

	test("stops an idle Session worker after its client disconnects", async () => {
		const { runtime } = await makeServer();
		const client = await attachClient(runtime, "demo-1");
		const pid = runtime.workerPids.get("demo-1");
		expect(pid).toEqual(expect.any(Number));

		await client.dispose();
		clients.delete(client);
		await expect.poll(() => runtime.workerPids.has("demo-1")).toBe(false);
		expect(processExists(pid!)).toBe(false);
	});

	test("starts one process per attached session and stops them during shutdown", async () => {
		const { runtime } = await makeServer();
		await Promise.all([attachClient(runtime, "demo-1"), attachClient(runtime, "demo-2")]);

		const pids = [...runtime.workerPids.values()];
		expect(pids).toHaveLength(2);
		expect(new Set(pids).size).toBe(2);
		for (const pid of pids) expect(processExists(pid)).toBe(true);

		await runtime.close();
		expect(runtime.workerPids.size).toBe(0);
		await Promise.all(pids.map((pid) => expect.poll(() => processExists(pid)).toBe(false)));
	});

	test("server runtime replaces an exited worker on the next attach", async () => {
		const directory = await mkdtemp(join("/tmp", "pew-"));
		directories.add(directory);
		const runtime = await startServer({ ...sessionWorkerModel, directory });
		servers.add(runtime);
		const client = await attachClient(runtime, "demo-1");
		const firstPid = runtime.workerPids.get("demo-1");
		expect(firstPid).toEqual(expect.any(Number));

		process.kill(firstPid!, "SIGKILL");
		await expect.poll(() => runtime.workerPids.has("demo-1")).toBe(false);
		await attachSession(client, "demo-1");
		const replacementPid = runtime.workerPids.get("demo-1");
		expect(replacementPid).toEqual(expect.any(Number));
		expect(replacementPid).not.toBe(firstPid);
	});

	test("discovers workers after replacing the server", async () => {
		const firstDirectory = await mkdtemp(join("/tmp", "per-"));
		directories.add(firstDirectory);
		const first = await startServer({ ...sessionWorkerModel, directory: firstDirectory });
		servers.add(first);
		await attachClient(first, "demo-1");
		const firstWorkerPid = first.workerPids.get("demo-1");
		expect(firstWorkerPid).toEqual(expect.any(Number));

		const replacement = await startServer({ ...sessionWorkerModel, directory: firstDirectory });
		servers.add(replacement);
		await first.closed;

		expect(replacement.serverId).toBe(first.serverId);
		expect(replacement.workerPids.get("demo-1")).toBe(firstWorkerPid);
		await expect.poll(() => first.workerPids.size).toBe(0);
		expect(processExists(firstWorkerPid!)).toBe(true);

		await expect(runClient({ command: "client" }, { directory: firstDirectory })).resolves.toMatchObject({
			kind: "list",
			sessions: [
				{ serverId: first.serverId, sessionId: "demo-1" },
				{ serverId: first.serverId, sessionId: "demo-2" },
			],
		});
		await attachClient(replacement, "demo-1");
		expect(replacement.workerPids.get("demo-1")).toBe(firstWorkerPid);
		await attachClient(replacement, "demo-2");
		expect(replacement.workerPids.get("demo-2")).toEqual(expect.any(Number));
		expect(replacement.workerPids.get("demo-2")).not.toBe(firstWorkerPid);
	});

	test("retires an unclaimed idle worker after replacement demand expires", async () => {
		const directory = await mkdtemp(join("/tmp", "pi-orphan-worker-"));
		directories.add(directory);
		vi.stubEnv("__PI_SESSION_WORKER_ORPHAN_DEMAND_GRACE_MS", "50");
		const first = await startServer({ ...sessionWorkerModel, directory });
		servers.add(first);
		await attachClient(first, "demo-1");
		const workerPid = first.workerPids.get("demo-1");
		expect(workerPid).toEqual(expect.any(Number));

		const replacement = await startServer({ ...sessionWorkerModel, directory });
		servers.add(replacement);
		await first.closed;
		expect(replacement.workerPids.get("demo-1")).toBe(workerPid);

		await expect.poll(() => replacement.workerPids.has("demo-1"), { timeout: 5_000 }).toBe(false);
		expect(processExists(workerPid!)).toBe(false);
	});

	test("restores tracked sessions that are outside the replacement catalog", async () => {
		const directory = await mkdtemp(join("/tmp", "pet-"));
		const emptySessionDir = await mkdtemp(join("/tmp", "pet-sessions-"));
		directories.add(directory);
		directories.add(emptySessionDir);
		const first = await startServer({ ...sessionWorkerModel, directory });
		servers.add(first);
		await attachClient(first, "demo-1");
		const workerPid = first.workerPids.get("demo-1");

		const replacement = await startServer({
			...sessionWorkerModel,
			directory,
			sessionDir: emptySessionDir,
		});
		servers.add(replacement);
		await first.closed;

		await expect(runClient({ command: "client" }, { directory })).resolves.toEqual({
			kind: "list",
			sessions: [{ serverId: first.serverId, sessionId: "demo-1" }],
		});
		await attachClient(replacement, "demo-1");
		expect(replacement.workerPids.get("demo-1")).toBe(workerPid);
	});

	test("reports missing and ambiguous session selections", async () => {
		const sharedDirectory = await mkdtemp(join("/tmp", "ped-"));
		directories.add(sharedDirectory);
		const firstShared = await startServer({
			...sessionWorkerModel,
			directory: sharedDirectory,
			serverId: "00000000-0000-4000-8000-000000000001",
		});
		const secondShared = await startServer({
			...sessionWorkerModel,
			directory: sharedDirectory,
			serverId: "00000000-0000-4000-8000-000000000002",
		});
		servers.add(firstShared);
		servers.add(secondShared);

		await expect(
			runClient({ command: "client", sessionId: "missing" }, { directory: sharedDirectory }),
		).rejects.toThrow("No discovered server contains session missing");
		await expect(
			runClient({ command: "client", sessionId: "demo-1" }, { directory: sharedDirectory }),
		).rejects.toThrow("Session demo-1 is available from more than one server");
	});
	test("rejects a duplicate session ID within one durable repository", async () => {
		await createExperimentalSessions(
			join(agentDir, "experimental", "sessions"),
			["demo-1"],
			join(agentDir, "other-cwd"),
		);
		const { directory } = await makeServer();

		await expect(runClient({ command: "client", sessionId: "demo-1" }, { directory })).rejects.toMatchObject({
			code: "session_ambiguous",
		});
	});
});

async function pathExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}
