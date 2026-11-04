// The file index from the environment's own listing (pi-env's `listFiles`, p2-tui-port.md section 8.3 item 2), with
// the workspace's private-path exclusion, and its fallback to the workspace's git/walk index.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { type ExecutionEnv, err, FileError } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { Connection, LocalExecutionEnv, localDaemon } from "@earendil-works/pi-env";
import { BACKGROUND_CONTEXT, whenLive } from "@p2/app/v1";
import { listIndex } from "../../plugins/file-index/listing.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { FileIndex } from "../../src/runtime/file-index.ts";
import { holdIn, startFixture } from "./helpers.ts";

const context = BACKGROUND_CONTEXT;
/** The development build (`npm run build:daemon` in packages/env), which has `listFiles`. */
const devDaemon = resolve(import.meta.dirname, "../../../../packages/env/daemon/target/debug/pi-env");

/** Whether the daemon at `path` lists files (`hello.features`). */
async function listsFiles(path: string): Promise<boolean> {
	if (!existsSync(path)) return false;
	const connection = new Connection({ command: [path] });
	try {
		return (await connection.info()).features?.includes("listFiles") === true;
	} catch {
		return false;
	} finally {
		connection.close();
	}
}

function tree(files: readonly string[]): string {
	const root = mkdtempSync(join(tmpdir(), "p2-file-index-"));
	for (const file of files) {
		if (file.endsWith("/")) mkdirSync(join(root, file), { recursive: true });
		else {
			mkdirSync(join(root, file, ".."), { recursive: true });
			writeFileSync(join(root, file), "");
		}
	}
	return root;
}

test("environments without listFiles, or with a daemon released before it, fall back", async () => {
	const root = tree(["a.txt"]);
	try {
		assert.equal(await listIndex(new NodeExecutionEnv({ cwd: root }), root, [], context), undefined);
		const old = {
			listFiles: async () => err(new FileError("not_supported", "The pi-env daemon does not list files", root)),
		} as unknown as ExecutionEnv;
		assert.equal(await listIndex(old, root, [], context), undefined);
		const failing = { listFiles: async () => err(new FileError("unknown", "lost", root)) } as unknown as ExecutionEnv;
		await assert.rejects(listIndex(failing, root, [], context), /lost/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the daemon's listing has empty and hidden directories, skips node_modules, ignored and private paths", async (t) => {
	if (!(await listsFiles(devDaemon))) return t.skip(`no pi-env build with listFiles at ${devDaemon}`);
	const root = tree([
		"src/app.ts",
		"empty/",
		".config/x.json",
		"node_modules/m/index.js",
		"dist/out.js",
		"data/sessions/s.sqlite",
		".git/HEAD",
	]);
	writeFileSync(join(root, ".gitignore"), "dist/\n");
	const connection = new Connection({ command: [devDaemon] });
	try {
		const env = new LocalExecutionEnv({ cwd: root, connection });
		const listed = await listIndex(env, root, [join(root, "data")], context);
		assert.deepEqual(listed, {
			items: [
				{ path: ".config", dir: true },
				{ path: ".config/x.json", dir: false },
				{ path: ".gitignore", dir: false },
				{ path: "empty", dir: true },
				{ path: "src", dir: true },
				{ path: "src/app.ts", dir: false },
			],
			truncated: false,
		});
	} finally {
		connection.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("a local session's index leaves out p2's data directory, from either source", { timeout: 60_000 }, async (t) => {
	const fixture = await startFixture();
	t.after(() => fixture.close());
	// The session works in the directory that holds p2's data directory (fixture: <root>/data next to <root>/workspace).
	const root = resolve(fixture.workspace, "..");
	mkdirSync(join(fixture.workspace, "src"), { recursive: true });
	writeFileSync(join(fixture.workspace, "src", "parser.ts"), "");
	mkdirSync(join(fixture.workspace, "emptydir"));
	const owner = fixture.browser();
	const session = (await (await holdIn(owner, Sessions, {}, "owner")).create({ cwd: root }, BACKGROUND_CONTEXT)).id;
	const index = owner.hold(FileIndex, { session, conversation: 1 }, BACKGROUND_CONTEXT);
	await whenLive(index);
	const found = await index.complete({ query: "parser", limit: 10 }, BACKGROUND_CONTEXT);
	assert.deepEqual(found.items[0], { path: "workspace/src/parser.ts", dir: false });
	const all = await index.complete({ query: "", limit: 100 }, BACKGROUND_CONTEXT);
	assert(all.items.length > 0);
	assert(
		!all.items.some((item) => item.path === "data" || item.path.startsWith("data/")),
		"the data directory is private",
	);
	// Empty directories come only from the daemon's listing: a local session uses it where pi-env ships a daemon with it.
	let daemon = false;
	try {
		daemon = await listsFiles(localDaemon());
	} catch {
		// No daemon for this system: the workspace's index.
	}
	const empty = await index.complete({ query: "emptydir", limit: 10 }, BACKGROUND_CONTEXT);
	assert.equal(
		empty.items.some((item) => item.path === "workspace/emptydir"),
		daemon,
	);
});
