// The base's files (`src/files.ts`): which Pi a command line names, the port a Pi takes at its first start, the
// data directory and its stores made private (also when they existed looser), what is refused as a data directory (its
// parent included), and a config people edit. `HOME` is this file's own: the test runner gives every file a process.

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
	DEFAULT_PORT,
	dataDirOf,
	existingDataDir,
	isPiName,
	keepPort,
	keptPort,
	openDataDir,
	openPrivateStore,
	pis,
	readConfig,
	writePrivate,
} from "../src/files.ts";
import { MAX_SOCKET_PATH_BYTES } from "../src/local-socket.ts";

let home: string;

before(async () => {
	home = await realpath(await mkdtemp(join(tmpdir(), "p3-files-")));
	process.env.HOME = home;
});

after(async () => {
	await rm(home, { recursive: true, force: true });
});

/** The permission bits of `path`. */
async function modeOf(path: string): Promise<number> {
	return (await stat(path)).mode & 0o777;
}

describe("a Pi", () => {
	it("is the default one in ~/.pi/p3/default, a named one beside it, or any directory", () => {
		assert.equal(dataDirOf({}), join(home, ".pi", "p3", "default"));
		assert.equal(dataDirOf({ pi: "work" }), join(home, ".pi", "p3", "work"));
		assert.equal(dataDirOf({ dir: "/somewhere/else" }), "/somewhere/else");
		assert.equal(dataDirOf({ dir: "relative" }), join(process.cwd(), "relative"));
	});

	it("is named by lower case letters, digits, - and _, at most 32, and never by a path", () => {
		for (const name of ["a", "work", "pi-2", "my_pi", "0", "a".repeat(32)]) assert.ok(isPiName(name), name);
		for (const name of ["", "A", "a b", "../x", "a/b", ".", "-a", "_a", "a".repeat(33), "ä"]) {
			assert.ok(!isPiName(name), name);
		}
	});

	it("are listed by name: the directories of ~/.pi/p3 that can name one", async () => {
		const root = join(home, ".pi", "p3");
		for (const name of ["work", "b", "Not A Name"]) await mkdir(join(root, name), { recursive: true });
		await writeFile(join(root, "file"), "");
		const names = (await pis()).map(({ name, dataDir }) => [name, dataDir]);
		assert.deepEqual(
			names.filter(([name]) => name !== "default"),
			[
				["b", join(root, "b")],
				["work", join(root, "work")],
			],
		);
	});

	it("takes 8789 at its first start when it is the default one, else a free one, then keeps its own", async () => {
		const defaultDir = await openDataDir(dataDirOf({}));
		const work = await openDataDir(dataDirOf({ pi: "work" }));
		assert.equal(DEFAULT_PORT, 8789);
		assert.deepEqual(await keptPort(defaultDir), { port: 8789, kept: false });
		assert.deepEqual(await keptPort(work), { port: 0, kept: false });
		await keepPort(work, 41_000);
		assert.deepEqual(await keptPort(work), { port: 41_000, kept: true });
	});

	// Opus (N1) and Fable (S10), review round 2: with `HOME` reached through a link, the default Pi was not known
	// and took a free port at its first start, kept for ever.
	it("is the default one by its real path, also when HOME is a link", async () => {
		const linked = join(await realpath(await mkdtemp(join(tmpdir(), "p3-link-"))), "home");
		await symlink(home, linked);
		process.env.HOME = linked;
		try {
			const dataDir = await openDataDir(dataDirOf({}));
			assert.equal(dataDir, join(home, ".pi", "p3", "default"));
			assert.deepEqual(await keptPort(dataDir), { port: DEFAULT_PORT, kept: false });
		} finally {
			process.env.HOME = home;
		}
	});

	it("refuses a config whose port is no port number", async () => {
		const dataDir = await openDataDir(join(home, "config"));
		for (const port of ["0", "65536", "1.5", '"80"', "null"]) {
			await writeFile(join(dataDir, "pi.json"), `{ "port": ${port} }`);
			await assert.rejects(readConfig(dataDir), /"port" must be a port number/, port);
		}
		await writeFile(join(dataDir, "pi.json"), "{}");
		assert.deepEqual(await readConfig(dataDir), {});
	});
});

describe("a data directory", () => {
	// Opus (B1, M8) and Fable (B1), review round 2: nothing failed when the data directory was not made private, the
	// premise of the command's socket (D1).
	it("is made private at every open, also when it existed looser", async () => {
		const path = join(home, "loose");
		await mkdir(path, { mode: 0o755 });
		await chmod(path, 0o755);
		assert.equal(await openDataDir(path), path);
		assert.equal(await modeOf(path), 0o700);
		const fresh = await openDataDir(join(home, "fresh", "pi"));
		assert.equal(await modeOf(fresh), 0o700);
	});

	// Opus, review round 2 (B1, M10).
	it("refuses the home directory, a file system's root and another user's directory, also through a link", async () => {
		await assert.rejects(openDataDir(home), /must be a directory of p3's own/);
		await assert.rejects(openDataDir("/"), /must be a directory of p3's own/);
		const link = join(home, "home-link");
		await symlink(home, link);
		await assert.rejects(openDataDir(link), /must be a directory of p3's own/);
		if (process.getuid?.() !== 0) await assert.rejects(openDataDir("/usr"), /belongs to another user/);
	});

	// Sol, Astra, Opus and Fable, review round 2 (D12).
	it("refuses a path too long for its sockets, naming the limit", async () => {
		// `/supervisor.sock`, the longest socket, is 16 bytes: this directory's is one byte too long.
		const deep = join(home, "d".repeat(MAX_SOCKET_PATH_BYTES - home.length - 16));
		await assert.rejects(
			openDataDir(deep),
			new RegExp(`longer than the ${MAX_SOCKET_PATH_BYTES} this system allows`),
		);
	});

	// Opus, review round 3 (N5): a `--dir` in a directory others may write to could be renamed away after the checks
	// and replaced by one of another user's, where the sockets would then be made.
	it("refuses a directory whose parent other users may change, unless its sticky bit is set", async () => {
		const parent = join(home, "shared");
		await mkdir(parent);
		await chmod(parent, 0o777);
		await assert.rejects(openDataDir(join(parent, "pi")), /which other users may change/);
		await chmod(parent, 0o1777);
		assert.equal(await openDataDir(join(parent, "pi")), join(parent, "pi"));
	});

	// Opus (N10) and Astra (S6), review round 2: `stop` and `status` asked the sockets of a directory they had not
	// checked, and signalled the pids its answers named.
	it("is checked as an open checks it before a command asks its sockets; one that is not there is none", async () => {
		assert.equal(await existingDataDir(join(home, "missing")), undefined);
		const path = await openDataDir(join(home, "asked"));
		assert.equal(await existingDataDir(path), path);
		await chmod(path, 0o755);
		await assert.rejects(existingDataDir(path), /is not private \(mode 755/);
		await assert.rejects(existingDataDir(home), /must be a directory of p3's own/);
		if (process.getuid?.() !== 0) await assert.rejects(existingDataDir("/usr"), /belongs to another user/);
	});
});

describe("a store and a private file", () => {
	// Opus, review round 2 (B1, M9): nothing failed when a store was created readable by others.
	it("are private: a new store and its journal files 0600, an existing looser one made 0600", async () => {
		const dataDir = await openDataDir(join(home, "stores"));
		const file = join(dataDir, "store.sqlite");
		const store = await openPrivateStore(file, context);
		await store.close(context);
		assert.equal(await modeOf(file), 0o600);
		await chmod(file, 0o644);
		await writeFile(`${file}-wal`, "");
		await chmod(`${file}-wal`, 0o644);
		const again = await openPrivateStore(file, context);
		assert.deepEqual([await modeOf(file), await modeOf(`${file}-wal`)], [0o600, 0o600]);
		await again.close(context);
	});

	it("is written in one step with mode 0600, replacing what was there", async () => {
		const path = join(await openDataDir(join(home, "written")), "secret");
		await writeFile(path, "old", { mode: 0o644 });
		await writePrivate(path, "new");
		assert.deepEqual([await readFile(path, "utf8"), await modeOf(path)], ["new", 0o600]);
	});
});
