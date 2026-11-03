import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT, type Held, statusOf, whenLive } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { type Session, Sessions } from "../../plugins/sessions/contract.ts";
import { Sharing } from "../../plugins/sharing/contract.ts";
import { Workspace, WorkspaceTransfer } from "../../plugins/workspace/contract.ts";
import { Hosts } from "../../src/runtime/server.ts";
import { expectChord, type Fixture, failureOf, holdIn, http, startFixture, until } from "./helpers.ts";

const TUNNEL = { Host: "share.test", Origin: "https://share.test" };

describe("workspace plugin (fake provider, temporary git repository)", () => {
	let fixture: Fixture;
	let session: Session;
	let other: Session;
	let workspace: Held<typeof Workspace>;
	let origin: string;
	let hash: string;
	const url = (path: string, id = session.id) =>
		`/workspace-file?${new URLSearchParams({ session: id, conversation: "1", path })}`;
	const upload = (
		name: string,
		body: string | Buffer,
		path = "",
		headers: Record<string, string> = { Origin: origin },
		id = session.id,
	) =>
		http(
			fixture.server.port,
			`/workspace-upload?${new URLSearchParams({ session: id, conversation: "1", path, name })}`,
			{ method: "POST", headers, body },
		);
	const joinGuest = async (mode: "view" | "full") => {
		const share = fixture.browser().hold(Sharing, { session: session.id }, BACKGROUND_CONTEXT);
		await share.link({ mode }, BACKGROUND_CONTEXT);
		const links = await until(share.links, (value) => Boolean(value?.some((entry) => entry.mode === mode)));
		const token = links?.find((entry) => entry.mode === mode)?.token;
		const response = await http(fixture.server.port, "/join", {
			method: "POST",
			headers: { ...TUNNEL, "Content-Type": "application/json" },
			body: JSON.stringify({ token, name: `Workspace ${mode}` }),
		});
		assert.equal(response.status, 200);
		return String(response.headers["set-cookie"]).split(";")[0]!;
	};
	before(async () => {
		fixture = await startFixture({ allowedHosts: ["share.test"] });
		origin = `http://127.0.0.1:${fixture.server.port}`;
		await mkdir(join(fixture.workspace, "src"));
		await writeFile(join(fixture.workspace, "src/hello.ts"), "const hello = 'before';\n");
		await writeFile(join(fixture.workspace, ".gitignore"), "ignored.txt\n");
		const git = (args: string[]) =>
			execFileSync("git", args, {
				cwd: fixture.workspace,
				encoding: "utf8",
				env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
			});
		git(["init", "-q"]);
		git(["add", "src/hello.ts", ".gitignore"]);
		git([
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.invalid",
			"-c",
			"commit.gpgsign=false",
			"-c",
			"core.hooksPath=/dev/null",
			"commit",
			"-qm",
			"Initial",
		]);
		hash = git(["rev-parse", "HEAD"]).trim();
		await writeFile(join(fixture.workspace, "src/hello.ts"), "const hello = 'after';\n");
		await writeFile(join(fixture.workspace, "new.md"), "# Untracked hello\n");
		await writeFile(join(fixture.workspace, "ignored.txt"), "hello ignored\n");
		await writeFile(join(fixture.workspace, "clip.mp3"), "0123456789");
		await symlink(fixture.dataDir, join(fixture.workspace, "private"));
		const browser = fixture.browser();
		const sessions = await holdIn(browser, Sessions, {}, "owner");
		session = await sessions.create({ cwd: fixture.workspace, title: "Workspace" }, BACKGROUND_CONTEXT);
		other = await sessions.create({ cwd: fixture.workspace, title: "Other" }, BACKGROUND_CONTEXT);
		workspace = browser.hold(Workspace, { session: session.id, conversation: 1 }, BACKGROUND_CONTEXT);
		await whenLive(workspace);
	});
	after(async () => {
		await fixture?.close();
	});

	it("lists folders, ignored annotations, all filenames, text, changes, search and history", async () => {
		const list = await workspace.query({ kind: "list", path: "" }, BACKGROUND_CONTEXT);
		assert.equal(list.kind, "list");
		if (list.kind !== "list") return;
		assert(!list.entries.some((entry) => entry.name === ".git"));
		assert.equal(list.entries.find((entry) => entry.name === "ignored.txt")?.ignored, true);
		const files = await workspace.query({ kind: "files" }, BACKGROUND_CONTEXT);
		assert(files.kind === "files" && files.paths.includes("src/hello.ts") && !files.paths.includes("ignored.txt"));
		const file = await workspace.query({ kind: "file", path: "src/hello.ts" }, BACKGROUND_CONTEXT);
		assert(file.kind === "file" && file.text?.includes("after"));
		const status = await workspace.query({ kind: "status" }, BACKGROUND_CONTEXT);
		assert(
			status.kind === "status" && status.repo && status.changes.some((change) => change.path === "src/hello.ts"),
		);
		const diff = await workspace.query({ kind: "diff", path: "src/hello.ts", full: true }, BACKGROUND_CONTEXT);
		assert(diff.kind === "diff" && diff.patch.includes("+const hello = 'after'"));
		const added = await workspace.query({ kind: "diff", path: "new.md" }, BACKGROUND_CONTEXT);
		assert(added.kind === "diff" && added.patch.includes("+# Untracked hello"));
		const search = await workspace.query(
			{
				kind: "search",
				path: "",
				text: "hello",
				include: "*.{ts,md}",
				exclude: "new.md",
			},
			BACKGROUND_CONTEXT,
		);
		assert(search.kind === "search" && search.matches.length === 1 && search.matches[0]?.path === "src/hello.ts");
		const log = await workspace.query({ kind: "log", skip: 0, limit: 30 }, BACKGROUND_CONTEXT);
		assert(log.kind === "log" && log.commits[0]?.hash === hash);
		const commit = await workspace.query({ kind: "commit", commit: hash }, BACKGROUND_CONTEXT);
		assert(
			commit.kind === "commit" &&
				commit.message === "Initial" &&
				commit.changes.some((entry) => entry.path === "src/hello.ts"),
		);
		const old = await workspace.query({ kind: "file", path: "src/hello.ts", commit: hash }, BACKGROUND_CONTEXT);
		assert(old.kind === "file" && old.text?.includes("before"));
		await assert.rejects(
			workspace.query({ kind: "file", path: "../data/settings.json" }, BACKGROUND_CONTEXT),
			/Invalid/,
		);
		await assert.rejects(workspace.query({ kind: "file", path: ".git/config" }, BACKGROUND_CONTEXT), /Invalid/);
		await assert.rejects(workspace.query({ kind: "list", path: "private" }, BACKGROUND_CONTEXT), /private|leaves/);
		await assert.rejects(workspace.query({ kind: "log", skip: -1, limit: 1000 }, BACKGROUND_CONTEXT));
	});

	it("rejects unknown conversations and sessions rooted in private application data", async () => {
		const browser = fixture.browser();
		const unknown = browser.hold(Workspace, { session: session.id, conversation: 99999 }, BACKGROUND_CONTEXT);
		// A failed open leaves its holders waiting (it would heal): the failure names the cause.
		assert.match((await failureOf(unknown)).message, /Unknown conversation/);
		unknown.release();
		const privateSession = await (await holdIn(browser, Sessions, {}, "owner")).create(
			{
				cwd: fixture.dataDir,
				title: "Private",
			},
			BACKGROUND_CONTEXT,
		);
		const privateWorkspace = browser.hold(
			Workspace,
			{ session: privateSession.id, conversation: 1 },
			BACKGROUND_CONTEXT,
		);
		assert.match((await failureOf(privateWorkspace)).message, /private/);
		privateWorkspace.release();
	});

	it("answers where it is open, without a waiting or failed move", async () => {
		const place = await workspace.query({ kind: "place" }, BACKGROUND_CONTEXT);
		assert.deepEqual(place, { kind: "place", location: { env: null, cwd: fixture.workspace } });
	});

	it("publishes changes while held, and keeps the same watch across reload", async () => {
		const initial = await until(workspace.changes, (value) => value !== undefined);
		await writeFile(join(fixture.workspace, "watched.txt"), "one");
		await until(workspace.changes, (value) => value !== undefined && value > initial!);
		const report = await fixture.server.reload(["workspace"]);
		assert.equal(report.stopped, undefined);
		const revision = await until(workspace.changes, (value) => value !== undefined);
		await writeFile(join(fixture.workspace, "watched.txt"), "two");
		await until(workspace.changes, (value) => value !== undefined && value > revision!);
	});

	it("streams bytes, HEAD and media ranges; denies private paths and cross-site reads", async () => {
		const bytes = await http(fixture.server.port, url("src/hello.ts"));
		assert.equal(bytes.status, 200, bytes.body);
		assert.equal(bytes.body, "const hello = 'after';\n");
		// As Pi Mobile: only media keeps its type; anything else is an opaque download.
		assert.equal(bytes.headers["content-type"], "application/octet-stream");
		const head = await http(fixture.server.port, url("clip.mp3"), { method: "HEAD" });
		assert.equal(head.status, 200);
		assert.equal(head.headers["content-type"], "audio/mpeg");
		assert.equal(head.headers["content-length"], "10");
		assert.equal(head.body, "");
		for (const [range, expected] of [
			["bytes=2-4", "234"],
			["bytes=-3", "789"],
			["bytes=7-", "789"],
		]) {
			const response = await http(fixture.server.port, url("clip.mp3"), { headers: { Range: range! } });
			assert.equal(response.status, 206, response.body);
			assert.equal(response.body, expected);
		}
		assert.equal((await http(fixture.server.port, url("clip.mp3"), { headers: { Range: "bytes=20-" } })).status, 416);
		assert.equal(
			(await http(fixture.server.port, url("src/hello.ts"), { headers: { "Sec-Fetch-Site": "cross-site" } })).status,
			403,
		);
		// A whole file over 25 MiB is refused (Pi Mobile's limit); a sparse file keeps the fixture small on disk.
		await writeFile(join(fixture.workspace, "huge.bin"), "");
		await truncate(join(fixture.workspace, "huge.bin"), 25 * 1024 * 1024 + 1);
		const huge = await http(fixture.server.port, url("huge.bin"));
		assert.equal(huge.status, 413);
		assert.equal(huge.body, "File too large");
		await rm(join(fixture.workspace, "huge.bin"));
		assert.equal((await http(fixture.server.port, url(".git/config"))).status, 404);
		assert.equal((await http(fixture.server.port, url("private/settings.json"))).status, 404);
		const transfer = fixture
			.browser()
			.hold(WorkspaceTransfer, { session: session.id, conversation: 1 }, BACKGROUND_CONTEXT);
		await expectChord(whenLive(transfer), "forbidden");
	});

	it("streams bounded uploads into a folder, including empty files, without overwriting", async () => {
		const payload = Buffer.alloc(2 * 1024 * 1024 + 11, "x");
		const response = await upload("large.txt", payload, "src");
		assert.equal(response.status, 200, response.body);
		assert.deepEqual(await readFile(join(fixture.workspace, "src/large.txt")), payload);
		const streamed = await http(fixture.server.port, url("src/large.txt"));
		assert.equal(streamed.status, 200);
		assert.equal(streamed.body, payload.toString("utf8"));
		const capped = await workspace.query({ kind: "file", path: "src/large.txt" }, BACKGROUND_CONTEXT);
		assert(capped.kind === "file" && capped.truncated && capped.text?.length === 1024 * 1024);
		assert.equal((await upload("large.txt", "overwrite", "src")).status, 400);
		assert.deepEqual(await readFile(join(fixture.workspace, "src/large.txt")), payload);
		const racing = await Promise.all([upload("racing.txt", "first", "src"), upload("racing.txt", "second", "src")]);
		assert.deepEqual(racing.map((entry) => entry.status).sort(), [200, 400]);
		assert.equal(
			await readFile(join(fixture.workspace, "src/racing.txt"), "utf8"),
			racing[0]?.status === 200 ? "first" : "second",
		);
		assert.equal((await upload("empty.txt", "", "src")).status, 200);
		assert.equal((await readFile(join(fixture.workspace, "src/empty.txt"))).length, 0);
		assert.equal((await upload("bad.txt", "x", "private")).status, 400);
		assert.equal((await upload("../bad.txt", "x")).status, 400);
		assert.equal((await upload("bad.txt", "x", "", {})).status, 403);
		assert.equal((await upload("oversized.txt", Buffer.alloc(25 * 1024 * 1024 + 1))).status, 400);
		assert(!(await readdir(fixture.workspace)).some((name) => name.startsWith(".pi-upload-")));
	});

	it("only owner and read/write guests access their workspace; HTTP reauthorizes after removal", async () => {
		const viewer = await joinGuest("view");
		const reader = fixture
			.client({ ...TUNNEL, Cookie: viewer })
			.host.hold(Workspace, { session: session.id, conversation: 1 }, BACKGROUND_CONTEXT);
		await expectChord(whenLive(reader), "forbidden");
		assert.equal(
			(await http(fixture.server.port, url("new.md"), { headers: { ...TUNNEL, Cookie: viewer } })).status,
			403,
		);
		const writer = await joinGuest("full");
		const browser = fixture.client({ ...TUNNEL, Cookie: writer }).host;
		const full = browser.hold(Workspace, { session: session.id, conversation: 1 }, BACKGROUND_CONTEXT);
		const file = await full.query({ kind: "file", path: "new.md" }, BACKGROUND_CONTEXT);
		assert(file.kind === "file" && file.text?.includes("hello"));
		assert.equal(
			(await http(fixture.server.port, url("new.md"), { headers: { ...TUNNEL, Cookie: writer } })).status,
			200,
		);
		assert.equal((await upload("guest.txt", "guest", "", { ...TUNNEL, Cookie: writer })).status, 200);
		assert.equal(
			(await http(fixture.server.port, url("new.md", other.id), { headers: { ...TUNNEL, Cookie: writer } })).status,
			403,
		);
		assert.equal((await upload("guest.txt", "x", "", { ...TUNNEL, Cookie: writer }, other.id)).status, 403);
		const share = fixture.browser().hold(Sharing, { session: session.id }, BACKGROUND_CONTEXT);
		await share.link({ mode: "full", reset: true }, BACKGROUND_CONTEXT);
		assert.equal(
			(await http(fixture.server.port, url("new.md"), { headers: { ...TUNNEL, Cookie: writer } })).status,
			403,
		);
	});

	it("sends quoted browser review drafts as an ordinary attributed prompt", async () => {
		const chat = await holdIn(fixture.browser(), Chat, { session: session.id, conversation: 1 }, "participant");
		const text = `Review comments:\n\nsrc/hello.ts:1 @${hash.slice(0, 8)}\n> const hello = 'after';\nPlease use a clearer name`;
		await chat.send({ text, requestId: "review" }, BACKGROUND_CONTEXT);
		const view = await until(chat.view, (value) =>
			Boolean(
				value?.entries.some(
					(entry) => entry.kind === "pi.assistant" && JSON.stringify(entry).includes("clearer name"),
				),
			),
		);
		assert(JSON.stringify(view).includes("Review comments:"));
		assert(text.includes(`src/hello.ts:1 @${hash.slice(0, 8)}`));
		chat.release();
	});
});

it("workspace holds keep an idle worker alive, and releasing the last hold releases the watch", async () => {
	const fixture = await startFixture({ idleMs: 100 });
	try {
		const browser = fixture.browser();
		const session = await (await holdIn(browser, Sessions, {}, "owner")).create(
			{
				cwd: fixture.workspace,
				title: "Watch lease",
			},
			BACKGROUND_CONTEXT,
		);
		const workspace = browser.hold(Workspace, { session: session.id, conversation: 1 }, BACKGROUND_CONTEXT);
		await whenLive(workspace);
		await workspace.query({ kind: "list", path: "" }, BACKGROUND_CONTEXT);
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.equal(statusOf(workspace), "live");
		const hosts = fixture.server.host.hold(Hosts, {}, BACKGROUND_CONTEXT);
		workspace.release();
		await until(hosts.workers, (value) => value?.[session.id]?.running === false);
	} finally {
		await fixture.close();
	}
});
