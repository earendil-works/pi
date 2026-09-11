import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { readFacetBundleManifest } from "@earendil-works/chord/node";
import { afterEach, describe, expect, test } from "vitest";
import {
	activateBuiltinClientServices,
	type ClientRuntime,
	openClientRuntime,
} from "../src/experimental/client-runtime.ts";
import { createPresentationFacetData, createPresentationFacetLoaders } from "../src/experimental/plugins/bundled.ts";
import { createServerPluginPackage, restoreServerPluginPackageProfile } from "../src/experimental/plugins/package.ts";
import { type RunningServer, startServer } from "../src/experimental/server.ts";
import { PresentationPlugins } from "../src/experimental/services/plugins.ts";

const runtimes = new Set<ClientRuntime>();
const runningServers = new Set<RunningServer>();
const directories = new Set<string>();

afterEach(async () => {
	await Promise.allSettled([...runtimes].map((runtime) => runtime.dispose()));
	await Promise.allSettled([...runningServers].map((server) => server.close()));
	await Promise.allSettled([...directories].map((directory) => rm(directory, { force: true, recursive: true })));
	runtimes.clear();
	runningServers.clear();
	directories.clear();
});

describe("server-selected presentation facets", () => {
	test("rejects local plugin paths for Radius servers", async () => {
		await expect(
			openClientRuntime({
				command: "client",
				connect: { transport: "radius", serverId: randomUUID() },
				pluginPackages: ["./local-plugin"],
			}),
		).rejects.toThrow("only be configured on a local Unix server");
	});

	test("restores plugin package selections for later server generations", async () => {
		const directory = await mkdtemp("/tmp/pi-presentation-profile-");
		directories.add(directory);
		const serverId = randomUUID();
		const packagePaths = [join(directory, "first-plugin"), join(directory, "second-plugin")];
		await expect(restoreServerPluginPackageProfile(directory, serverId, packagePaths)).resolves.toEqual(packagePaths);
		await expect(restoreServerPluginPackageProfile(directory, serverId)).resolves.toEqual(packagePaths);
		await expect(restoreServerPluginPackageProfile(directory, serverId, [])).resolves.toEqual([]);
		await expect(restoreServerPluginPackageProfile(directory, serverId)).resolves.toEqual([]);
	});

	test("builds conventional plugin entries into the server-owned plugin cache", async () => {
		const directory = await mkdtemp("/tmp/pi-presentation-package-");
		directories.add(directory);
		const serverId = randomUUID();
		const packagePath = join(directory, "pi-example-plugin");
		await mkdir(join(packagePath, "src"), { recursive: true });
		await writeFile(
			join(packagePath, "package.json"),
			`${JSON.stringify({
				name: "@earendil-works/test-plugin",
				version: "1.0.0",
				peerDependencies: {
					"@earendil-works/chord": "^0.84.4",
					"@earendil-works/pi-coding-agent": "^0.84.4",
				},
			})}\n`,
		);
		const sourcePath = join(packagePath, "src", "tui.ts");
		await writeFile(
			sourcePath,
			'import { defineFacet } from "@earendil-works/chord"; import { SlashCommands } from "@earendil-works/pi-coding-agent/experimental/plugin"; export default defineFacet({ id: "built-a", setup(env) { env.use(SlashCommands); } });\n',
		);
		const plugin = createServerPluginPackage(directory, serverId, packagePath);

		const first = await plugin.build();
		expect(first).toHaveLength(1);
		expect(plugin.manifestPath).toMatch(
			new RegExp(`/plugin-builds/${serverId}/pi-example-plugin-[a-f0-9]{12}/chord-facets\\.json$`, "u"),
		);
		expect(first[0]?.plugin).toEqual({ id: "@earendil-works/test-plugin", version: "1.0.0" });
		const firstLoaded = await createPresentationFacetLoaders(createPresentationFacetData(first))[0]!.load();
		expect(firstLoaded.facets.map(({ id }) => id)).toEqual(["built-a"]);
		await firstLoaded.dispose();

		await writeFile(
			sourcePath,
			'import { defineFacet } from "@earendil-works/chord"; import { SlashCommands } from "@earendil-works/pi-coding-agent/experimental/plugin"; export default defineFacet({ id: "built-b", setup(env) { env.use(SlashCommands); } });\n',
		);
		const second = await plugin.build();
		expect(second[0]?.source).not.toBe(first[0]?.source);
		const secondLoaded = await createPresentationFacetLoaders(createPresentationFacetData(second))[0]!.load();
		expect(secondLoaded.facets.map(({ id }) => id)).toEqual(["built-b"]);
		await secondLoaded.dispose();

		const secondPackagePath = join(directory, "second-plugin");
		await mkdir(join(secondPackagePath, "src"), { recursive: true });
		await Promise.all([
			writeFile(
				join(secondPackagePath, "package.json"),
				`${JSON.stringify({
					name: "@earendil-works/second-test-plugin",
					version: "1.0.0",
					peerDependencies: { "@earendil-works/chord": "^0.84.4" },
				})}\n`,
			),
			writeFile(
				join(secondPackagePath, "src", "tui.ts"),
				'import { defineFacet } from "@earendil-works/chord"; export default defineFacet({ id: "second-built", setup() {} });\n',
			),
		]);
		const running = await startServer({
			directory: join(directory, "server"),
			sessionDir: join(directory, "sessions"),
		});
		runningServers.add(running);
		const runtime = await openClientRuntime({
			command: "client",
			connect: { transport: "unix", path: running.socketPath },
			pluginPackages: [packagePath, secondPackagePath],
		});
		runtimes.add(runtime);
		const activated = await activateBuiltinClientServices(runtime.servers[0]!);
		const sessionId = randomUUID();
		await activated.management.create({ id: sessionId }, BACKGROUND_CONTEXT);
		const presentationPlugins = await activated.plugins.prepareSession(
			{ sessionId, packagePaths: [packagePath, secondPackagePath] },
			BACKGROUND_CONTEXT,
		);
		await expect(restoreServerPluginPackageProfile(join(directory, "server"), running.serverId)).resolves.toEqual([]);
		const serverLoaded = await Promise.all(
			createPresentationFacetLoaders(presentationPlugins).map((loader) => loader.load()),
		);
		expect(serverLoaded.flatMap(({ facets }) => facets.map(({ id }) => id))).toEqual(["built-b", "second-built"]);
		await Promise.all(serverLoaded.map((loaded) => loaded.dispose()));

		await writeFile(
			sourcePath,
			'import { defineFacet } from "@earendil-works/chord"; import { SlashCommands } from "@earendil-works/pi-coding-agent/experimental/plugin"; export default defineFacet({ id: "built-c", setup(env) { env.use(SlashCommands); } });\n',
		);
		const services = runtime.servers[0]!.server.open({
			services: [PresentationPlugins],
			assertAccess() {},
			onError() {},
		});
		try {
			await services.ready(BACKGROUND_CONTEXT);
			const data = await services.use(PresentationPlugins).reload(BACKGROUND_CONTEXT);
			const reloaded = await Promise.all(createPresentationFacetLoaders(data).map((loader) => loader.load()));
			expect(reloaded.flatMap(({ facets }) => facets.map(({ id }) => id))).toEqual(["built-c", "second-built"]);
			await Promise.all(reloaded.map((loaded) => loaded.dispose()));
		} finally {
			await services.dispose(BACKGROUND_CONTEXT);
		}
	});

	test("builds the example plugin package without a package-owned build script", async () => {
		const directory = await mkdtemp("/tmp/pi-example-plugin-");
		directories.add(directory);
		const serverId = randomUUID();
		const packagePath = fileURLToPath(new URL("../examples/plugins/pi-example-plugin", import.meta.url));
		const plugin = createServerPluginPackage(directory, serverId, packagePath);

		const artifacts = await plugin.build();
		const manifest = await readFacetBundleManifest(plugin.manifestPath);
		expect(manifest.plugin).toEqual({ id: "@earendil-works/pi-example-plugin", version: "1.0.0" });
		expect(Object.keys(manifest.entries)).toEqual(["session", "tui"]);
		const loaded = await createPresentationFacetLoaders(createPresentationFacetData(artifacts))[0]!.load();
		expect(loaded.facets.map(({ id }) => id)).toEqual(["@earendil-works/pi-example-plugin/tui"]);
		await loaded.dispose();
	});
});
