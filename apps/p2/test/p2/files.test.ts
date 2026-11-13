// Uploads (POST /upload into the session's files, attached to messages by ID and materialized) and download snapshots
// (GET /download), owner and guests; the server's mirror of the session's file summaries.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { UserMessage } from "@earendil-works/pi-ai";
import type { ConversationView } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { DownloadStore, type Uploaded } from "../../plugins/files/contract.ts";
import { type Session, Sessions } from "../../plugins/sessions/contract.ts";
import { Sharing } from "../../plugins/sharing/contract.ts";
import type { RefIn } from "../../src/runtime/chord.ts";
import { type Fixture, holdIn, http, poll, startFixture, until } from "./helpers.ts";

const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
	"base64",
);
const TUNNEL = { Host: "share.test", Origin: "https://share.test" };
const userMessages = (view: ConversationView | null | undefined): UserMessage[] =>
	(view?.entries ?? []).flatMap((entry) => (entry.kind === "p2.input" ? [entry.model?.[0] as UserMessage] : []));

describe("files (fake provider)", () => {
	let fixture: Fixture;
	let session: Session;
	let other: Session;
	let chat: RefIn<typeof Chat, "participant">;
	let local: string;

	const upload = (
		id: string,
		name: string,
		body: Buffer | string,
		headers: Record<string, string> = { Origin: local },
	) =>
		fixture.http(`/upload?${new URLSearchParams({ session: id, name })}`, {
			method: "POST",
			headers,
			body,
		});
	const snapshot = (id: string, path: string, name?: string) =>
		fixture.server.host.root(
			async (ctx) => (await ctx.get(DownloadStore, {})).save({ session: id, path, ...(name ? { name } : {}) }, ctx),
			BACKGROUND_CONTEXT,
		);
	const guestCookie = async (mode: "view" | "full"): Promise<string> => {
		const sharing = fixture.browser().hold(Sharing, { session: session.id }, BACKGROUND_CONTEXT);
		await sharing.link({ mode }, BACKGROUND_CONTEXT);
		const links = await until(sharing.links, (value) => Boolean(value?.some((link) => link.mode === mode)));
		const token = links?.find((link) => link.mode === mode)?.token ?? "";
		const joined = await http(fixture.server.port, "/join", {
			method: "POST",
			headers: { ...TUNNEL, "Content-Type": "application/json" },
			body: JSON.stringify({ token, name: mode }),
		});
		assert.equal(joined.status, 200, joined.body);
		return String(joined.headers["set-cookie"] ?? "").split(";")[0] ?? "";
	};

	before(async () => {
		fixture = await startFixture({ allowedHosts: ["share.test"] });
		local = `http://127.0.0.1:${fixture.server.port}`;
		const owner = fixture.browser();
		const sessions = await holdIn(owner, Sessions, {}, "owner");
		session = await sessions.create({ cwd: fixture.workspace, title: "Files" }, BACKGROUND_CONTEXT);
		other = await sessions.create({ cwd: fixture.workspace, title: "Other" }, BACKGROUND_CONTEXT);
		chat = await holdIn(owner, Chat, { session: session.id, conversation: 1 }, "participant");
	});

	after(async () => {
		await fixture?.close();
	});

	it("stores uploads in the session's files, same-origin only", async () => {
		assert.equal((await upload(session.id, "a.txt", "x", {})).status, 403, "no Origin");
		assert.equal((await upload(session.id, "a.txt", "x", { Origin: "https://evil.test" })).status, 403);
		assert.equal((await upload("missing", "a.txt", "x")).status, 400);
		assert.equal((await upload(session.id, "", "x")).status, 400);
		const response = await upload(session.id, "../../evil notes.txt", "uploaded-sentinel\n");
		assert.equal(response.status, 200, response.body);
		const text = JSON.parse(response.body) as Uploaded;
		assert.deepEqual(text, { id: text.id, name: "evil_notes.txt", size: 18 });
		assert.deepEqual(await readdir(fixture.workspace), [], "nothing is written into the project");
	});

	it("attaches uploads to messages by ID, materialized on this machine: paths listed, images inline", async () => {
		const text = JSON.parse((await upload(session.id, "notes.txt", "hello")).body) as Uploaded;
		const image = JSON.parse((await upload(session.id, "dot.png", PNG)).body) as Uploaded;
		assert.equal(image.mimeType, "image/png");
		const foreign = JSON.parse((await upload(other.id, "private.txt", "private")).body) as Uploaded;
		await assert.rejects(
			chat.send({ text: "x", requestId: "bad", attachments: ["../../etc/passwd"] }, BACKGROUND_CONTEXT),
			/Unknown attachment/,
		);
		await assert.rejects(
			chat.send({ text: "x", requestId: "foreign", attachments: [foreign.id] }, BACKGROUND_CONTEXT),
			/Unknown attachment/,
			"another session's upload is not found",
		);
		await chat.send({ text: "", requestId: "files", attachments: [text.id, image.id] }, BACKGROUND_CONTEXT);
		const view = await until(chat.view, (value) => userMessages(value).length > 0);
		const content = userMessages(view)[0]?.content;
		assert(Array.isArray(content));
		// This machine's copies: under the data directory's `uploads/<session>/`, private, outside the project.
		const textPath = join(fixture.dataDir, "uploads", session.id, `${text.id}-notes.txt`);
		const imagePath = join(fixture.dataDir, "uploads", session.id, `${image.id}-dot.png`);
		const note = content.find((part) => part.type === "text" && part.text.includes("<attachments>"));
		assert(note?.type === "text" && note.text.includes(textPath) && note.text.includes(imagePath));
		assert.equal(await readFile(textPath, "utf8"), "hello");
		assert.equal((await stat(textPath)).mode & 0o777, 0o600);
		// The fake model accepts images, so the PNG is also inlined.
		const inline = content.find((part) => part.type === "image");
		assert(inline?.type === "image" && inline.mimeType === "image/png" && inline.data === PNG.toString("base64"));
	});

	it("serves download snapshots to the owner", async () => {
		const source = join(fixture.dataDir, "report.txt");
		await writeFile(source, "snapshot");
		const info = await snapshot(session.id, source, 'résumé"\r\n.txt');
		assert.equal(info.name, "résumé_.txt");
		await writeFile(source, "changed later");
		const path = `/download?session=${session.id}&id=${info.id}`;
		const downloaded = await fixture.http(path);
		assert.equal(downloaded.status, 200);
		assert.equal(downloaded.body, "snapshot");
		assert.match(String(downloaded.headers["content-disposition"]), /^attachment; filename="r_sum__\.txt"/);
		assert.equal(
			downloaded.headers["content-type"],
			"text/plain; charset=utf-8",
			"previewable types keep their type",
		);
		const head = await fixture.http(path, { method: "HEAD" });
		assert.equal(head.status, 200);
		assert.equal(head.body, "");
		assert.equal(
			(await fixture.http(path, { headers: { "Sec-Fetch-Site": "cross-site" } })).status,
			403,
			"a cross-site page never downloads with the owner's access",
		);
		assert.equal((await fixture.http(`/download?session=${other.id}&id=${info.id}`)).status, 404);
		assert.equal((await fixture.http(`/download?session=${session.id}&id=../x`)).status, 404);
		// Audio and video are seekable.
		const audio = join(fixture.dataDir, "clip.mp3");
		await writeFile(audio, "0123456789");
		const clip = await snapshot(session.id, audio);
		const clipPath = `/download?session=${session.id}&id=${clip.id}`;
		const partial = await fixture.http(clipPath, { headers: { Range: "bytes=2-4" } });
		assert.equal(partial.status, 206);
		assert.equal(partial.body, "234");
		assert.equal(partial.headers["content-range"], "bytes 2-4/10");
		assert.equal((await fixture.http(clipPath, { headers: { Range: "bytes=20-" } })).status, 416);
	});

	it("lets guests download from their session, and only read/write guests upload", async () => {
		const source = join(fixture.dataDir, "shared.txt");
		await writeFile(source, "shared");
		const shared = await snapshot(session.id, source);
		const hidden = await snapshot(other.id, source);
		const viewer = await guestCookie("view");
		const get = (path: string, cookie: string) =>
			http(fixture.server.port, path, { headers: { ...TUNNEL, Cookie: cookie } });
		const downloaded = await get(`/download?session=${session.id}&id=${shared.id}`, viewer);
		assert.equal(downloaded.status, 200);
		assert.equal(downloaded.body, "shared");
		assert.equal((await get(`/download?session=${other.id}&id=${hidden.id}`, viewer)).status, 403);
		assert.equal((await get(`/download?session=${session.id}&id=${shared.id}`, "")).status, 403, "not signed in");
		assert.equal((await upload(session.id, "a.txt", "x", { ...TUNNEL, Cookie: viewer })).status, 403, "read-only");
		const writer = await guestCookie("full");
		const uploaded = await upload(session.id, "guest.txt", "from guest", { ...TUNNEL, Cookie: writer });
		assert.equal(uploaded.status, 200, uploaded.body);
		assert.equal((await upload(other.id, "a.txt", "x", { ...TUNNEL, Cookie: writer })).status, 403);
	});

	it("answers at once for an archived or unknown session, never waiting for its worker", async () => {
		const sessions = await holdIn(fixture.browser(), Sessions, {}, "owner");
		const archived = await sessions.create({ cwd: fixture.workspace, title: "Archived" }, BACKGROUND_CONTEXT);
		const archivedChat = await holdIn(
			fixture.browser(),
			Chat,
			{ session: archived.id, conversation: 1 },
			"participant",
		);
		await archivedChat.send({ text: "artifact", requestId: "archived-artifact" }, BACKGROUND_CONTEXT);
		const artifact = `/artifact-frame?${new URLSearchParams({ session: archived.id, id: "demo", version: "1" })}`;
		await poll(async () => (await fixture.http(artifact)).status === 200, 30_000, "the artifact is saved");
		archivedChat.release();
		const source = join(fixture.dataDir, "archived.txt");
		await writeFile(source, "archived");
		const sent = await snapshot(archived.id, source);
		const download = `/download?session=${archived.id}&id=${sent.id}`;
		assert.equal((await fixture.http(download)).status, 200);
		await sessions.archive({ id: archived.id }, BACKGROUND_CONTEXT);
		await until(sessions.sessions, (rows) => rows?.find((row) => row.id === archived.id)?.archivedAt !== null);
		const started = Date.now();
		// Artifacts are the server's: an archived session's pages still show, without its worker.
		assert.equal((await fixture.http(artifact)).status, 200);
		assert.equal((await fixture.http(download)).status, 404);
		assert.equal((await fixture.http(download, { method: "HEAD" })).status, 404);
		assert.equal((await upload(archived.id, "late.txt", "x")).status, 409);
		const unknown = randomUUID();
		assert.equal((await fixture.http(`/download?session=${unknown}&id=${sent.id}`)).status, 404);
		assert.equal(
			(await fixture.http(`/artifact-frame?${new URLSearchParams({ session: unknown, id: "demo", version: "1" })}`))
				.status,
			404,
		);
		await assert.rejects(snapshot(archived.id, source), /archived/);
		// A worker start that is refused would take a minute per request.
		assert.ok(Date.now() - started < 5_000, `answered in ${Date.now() - started} ms`);
		await sessions.restore({ id: archived.id }, BACKGROUND_CONTEXT);
		await poll(async () => (await fixture.http(download)).status === 200, 30_000, "served again once restored");
	});
});
