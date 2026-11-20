// Tests of `startServer`: the layout and the start-data object, start and close, the server's record, one server per
// data directory, the directory made private, directories the kit must not tighten, the owner link's address, a
// failing root, a port in use, and the Pi's own port.

import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, mkdir, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { type AddressInfo, createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { local, str } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { readConfig } from "../../src/kit/config.ts";
import { AppInfo } from "../../src/kit/info.ts";
import { holder } from "../../src/kit/running.ts";
import { ListenFailed } from "../../src/kit/start-server.ts";
import { kitApp, rejection, send, tempDir, writePlugin } from "./support.ts";

/** The echo plugin's object (`ECHO_SERVER`), declared again for the tests (contracts are data). */
const Echo = local("test.echo", { version: 1, params: {}, members: { text: str() } });

/** A plugin's server facet serving `Echo` through p3's API. */
const ECHO_SERVER = [
	'import { constant, defineFacet, local, str } from "@earendil-works/p3/v1";',
	'const Echo = local("test.echo", { version: 1, params: {}, members: { text: str() } });',
	'export default defineFacet((host) => host.serve(Echo, () => ({ text: constant("echo") })));',
].join("\n");

describe("starting and closing", () => {
	it("lays out the data directory, serves AppInfo and the root's plugins, and closes everything", async () => {
		const { app, dataDir, port } = await kitApp({ plugins: { echo: { "server.ts": ECHO_SERVER } } });
		const files = ["cache", "logs", "owner-token", "pi.json", "server", "server.json", "workers"];
		assert.deepEqual((await readdir(dataDir)).sort(), files);
		// Its record: believed while it runs, gone with it.
		const { id } = (await readConfig(join(dataDir, "pi.json")))!;
		const found = await holder(dataDir, "server", context);
		assert.ok(found.kind === "claimed");
		const { record } = found;
		assert.deepEqual([record.pi, record.pid, record.port, record.version], [id, process.pid, port, "0.0.0-test"]);
		assert.ok(Math.abs(Date.now() - record.startedAt) < 5000);
		assert.equal(app.port(), port);
		const server = (await readdir(join(dataDir, "server"))).filter((name) => !name.startsWith("."));
		assert.ok(["cookie-secret", "store.sqlite"].every((name) => server.includes(name)));
		const info = await app.host.get(AppInfo, {}, context);
		assert.deepEqual([info.dataDir.value, info.name.value, info.version.value], [dataDir, "p3", "v1"]);
		assert.equal((await app.host.get(Echo, {}, context)).text.value, "echo");
		assert.match(app.ownerLink(), new RegExp(`^http://127\\.0\\.0\\.1:${port}/_p3/owner#[A-Za-z0-9_-]{43}$`));
		await app.close(context);
		// HTTP closed first: the port answers nothing any more; a second close is the same close.
		await assert.rejects(send(port, "GET", "/"));
		await app.close(context);
		assert.deepEqual(
			[await holder(dataDir, "server", context), await readdir(dataDir)],
			[{ kind: "free" }, files.filter((name) => name !== "server.json")],
		);
	});

	it("refuses a second server on the same data directory while the first runs, also through a symbolic link", async () => {
		const first = await kitApp();
		const link = join(await tempDir(), "link");
		await symlink(first.dataDir, link);
		// Both at once: each waits a second for the lock.
		const [second, linked] = await Promise.all(
			[first.dataDir, link].map((dataDir) => rejection(kitApp({ dataDir, root: first.root }))),
		);
		assert.ok(String(second).includes(`another server runs on ${first.dataDir}`));
		assert.ok(String(linked).includes(`another server runs on ${first.dataDir}`));
		await first.app.close(context);
		await kitApp({ dataDir: first.dataDir, root: first.root });
	});

	it("makes the data directory private at every start, also when it existed looser", async () => {
		const dataDir = join(await tempDir(), "data");
		await mkdir(join(dataDir, "server"), { recursive: true, mode: 0o775 });
		await chmod(dataDir, 0o755);
		await chmod(join(dataDir, "server"), 0o775);
		const { app } = await kitApp({ dataDir });
		const mode = async (path: string) => (await stat(join(dataDir, path))).mode & 0o777;
		const directories = [".", "server", "workers", "cache", "cache/worker", "cache/node", "logs"];
		const files = ["server/store.sqlite", "server/cookie-secret", "owner-token", "pi.json", "server.json"];
		assert.deepEqual(
			await Promise.all(directories.map(mode)),
			directories.map(() => 0o700),
		);
		assert.deepEqual(
			await Promise.all(files.map(mode)),
			files.map(() => 0o600),
		);
		await app.close(context);
		await chmod(join(dataDir, "server", "store.sqlite"), 0o644);
		await chmod(join(dataDir, "owner-token"), 0o644);
		await kitApp({ dataDir });
		assert.deepEqual([await mode("server/store.sqlite"), await mode("owner-token")], [0o600, 0o600]);
	});

	it("refuses a data directory the kit must not tighten: home, root, another user's, also through a link", async () => {
		const homeMode = (await stat(homedir())).mode & 0o777;
		assert.ok(String(await rejection(kitApp({ dataDir: homedir() }))).includes("is the home directory"));
		assert.ok(String(await rejection(kitApp({ dataDir: "/" }))).includes("is a file system's root"));
		const link = join(await tempDir(), "home-link");
		await symlink(homedir(), link);
		assert.ok(String(await rejection(kitApp({ dataDir: link }))).includes("is the home directory"));
		assert.equal((await stat(homedir())).mode & 0o777, homeMode);
		if (process.getuid?.() !== 0) {
			// `/tmp`'s owner is root.
			assert.ok(String(await rejection(kitApp({ dataDir: "/tmp" }))).includes("belongs to another user"));
		}
	});

	it("names the address listened on in the owner link: an IPv6 address in brackets, loopback for a wildcard", async () => {
		const linkOf = async (host: string) => (await kitApp({ listen: { host, port: 0 } })).app.ownerLink();
		assert.match(await linkOf("::1"), /^http:\/\/\[::1\]:\d+\/_p3\/owner#/);
		assert.match(await linkOf("0.0.0.0"), /^http:\/\/127\.0\.0\.1:\d+\/_p3\/owner#/);
		assert.match(await linkOf("::"), /^http:\/\/\[::1\]:\d+\/_p3\/owner#/);
	});

	it("leaves no record and frees the lock when the start fails right after it took the lock", async () => {
		const dataDir = join(await tempDir(), "data");
		await mkdir(dataDir);
		// Its config is read after the record says `starting`.
		await writeFile(join(dataDir, "pi.json"), JSON.stringify({ id: "not hex" }));
		assert.match(String(await rejection(kitApp({ dataDir }))), /"id" must be 16 hex digits/);
		assert.ok(!(await readdir(dataDir)).includes("server.json"));
		assert.deepEqual(await holder(dataDir, "server", context), { kind: "free" });
	});

	it("rejects when a plugin of the root fails, with everything closed", async () => {
		const base = await tempDir();
		const root = join(base, "plugins");
		await writePlugin(root, "broken", { "server.ts": "export default {" });
		const dataDir = join(base, "data");
		const error = await rejection(kitApp({ root, dataDir }));
		assert.equal((error as Error).name, "PluginError");
		assert.ok(String(error).includes('"@test/broken"'));
		// Closed: the data directory's lock is free again (a second start fails only on the same plugin).
		assert.equal(((await rejection(kitApp({ root, dataDir }))) as Error).name, "PluginError");
	});
});

describe("listening", () => {
	it("fails the start at once when the port is in use, with everything closed", { timeout: 20_000 }, async () => {
		const taken = createServer().listen(0, "127.0.0.1");
		await once(taken, "listening");
		const { port } = taken.address() as AddressInfo;
		const dataDir = join(await tempDir(), "data");
		const started = performance.now();
		const error = await rejection(kitApp({ dataDir, listen: { host: "127.0.0.1", port } }));
		assert.ok(error instanceof ListenFailed);
		assert.deepEqual([error.code, error.address], ["EADDRINUSE", { host: "127.0.0.1", port }]);
		assert.equal(error.message, `startServer: cannot listen on 127.0.0.1:${port}: the port is in use`);
		// No wait for the port, no record of a server, and the data directory is free for the next start.
		assert.ok(performance.now() - started < 3000);
		assert.ok(!(await readdir(dataDir)).includes("server.json"));
		assert.deepEqual(await holder(dataDir, "server", context), { kind: "free" });
		taken.close();
		await kitApp({ dataDir });
	});

	it("listens on the Pi's own port: the first start's, kept in its config; a port named for one start is not kept", async () => {
		const dataDir = join(await tempDir(), "data");
		const config = () => readConfig(join(dataDir, "pi.json"));
		const named = await kitApp({ dataDir });
		assert.equal((await config())?.port, undefined);
		await named.app.close(context);
		const first = await kitApp({ dataDir, listen: { host: "127.0.0.1", firstPort: 0 } });
		assert.deepEqual(await config(), { id: (await config())!.id, port: first.port });
		await first.app.close(context);
		const second = await kitApp({ dataDir, listen: { host: "127.0.0.1", firstPort: 1 } });
		assert.equal(second.port, first.port);
	});
});
