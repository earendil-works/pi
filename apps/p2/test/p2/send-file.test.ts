import assert from "node:assert/strict";
import { mkdir, open, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { ConversationView } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT, whenLive } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import type { DownloadInfo } from "../../plugins/files/contract.ts";
import { SentFiles } from "../../plugins/send-file/contract.ts";
import { previewText } from "../../plugins/send-file/worker.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import type { RefIn } from "../../src/runtime/chord.ts";
import { type Fixture, holdIn, startFixture, until } from "./helpers.ts";

const results = (view: ConversationView | null | undefined): ToolResultMessage[] =>
	(view?.entries ?? []).flatMap((entry) =>
		(entry.model ?? []).filter(
			(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "send_file",
		),
	);

describe("send_file (fake provider)", () => {
	let fixture: Fixture;
	let chat: RefIn<typeof Chat, "participant">;
	let session: string;
	let path: string;
	let count = 0;
	before(async () => {
		fixture = await startFixture();
		const owner = fixture.browser();
		session = (
			await (await holdIn(owner, Sessions, {}, "owner")).create({ cwd: fixture.workspace }, BACKGROUND_CONTEXT)
		).id;
		chat = await holdIn(owner, Chat, { session, conversation: 1 }, "participant");
		path = join(fixture.workspace, "created.txt");
	});
	after(async () => {
		await fixture?.close();
	});
	const send = async (): Promise<ToolResultMessage> => {
		await chat.send({ text: "send-file", requestId: `file-${++count}` }, BACKGROUND_CONTEXT);
		const view = await until(
			chat.view,
			(view) => results(view).length === count && !(view?.docs["pi.live"] as { run?: unknown })?.run,
		);
		return results(view).at(-1)!;
	};

	it("snapshots a cwd-relative file and serves the original after deletion/reload", async () => {
		await writeFile(path, "immutable sentinel");
		const result = await send();
		assert.equal(result.isError, false);
		const info = result.details as DownloadInfo;
		assert.equal(info.name, "created.txt");
		assert.equal(info.size, 18);
		await rm(path);
		await fixture.server.reload(["send-file"]);
		const response = await fixture.http(`/download?session=${session}&id=${info.id}`);
		assert.equal(response.status, 200);
		assert.equal(response.body, "immutable sentinel");
		assert.match(String(response.headers["content-disposition"]), /attachment/);
	});

	it("previews sent text for viewers that have no cookie (the TUI), and refuses binary text", async () => {
		const owner = fixture.browser();
		const files = owner.hold(SentFiles, { session }, BACKGROUND_CONTEXT);
		await whenLive(files);
		assert.equal(files.variant, "reader");
		if (files.variant !== "reader") return;
		await writeFile(path, "line one\nline two");
		const text = await send();
		const shown = await files.preview({ id: (text.details as DownloadInfo).id }, BACKGROUND_CONTEXT);
		assert.deepEqual(shown, { name: "created.txt", size: 17, text: "line one\nline two", truncated: false });
		await writeFile(path, Buffer.from([0x50, 0x4b, 0x00, 0x01]));
		const binary = await send();
		const refused = await files.preview({ id: (binary.details as DownloadInfo).id }, BACKGROUND_CONTEXT);
		assert.equal(refused.text, null);
		assert.equal(refused.size, 4);
		await assert.rejects(
			files.preview({ id: "00000000-0000-0000-0000-000000000000" }, BACKGROUND_CONTEXT),
			/not found/i,
		);
		files.release();
		await rm(path);
	});

	it("previewText keeps UTF-8 text, drops a code point cut by a partial read, refuses NUL", () => {
		assert.equal(previewText(Buffer.from("héllo"), false), "héllo");
		const cut = Buffer.from("ab€").subarray(0, 4);
		assert.equal(previewText(cut, true), "ab");
		assert.equal(previewText(cut, false), null);
		assert.equal(previewText(Buffer.from([0x61, 0x00]), false), null);
	});

	it("rejects directories and oversized files", async () => {
		await mkdir(path);
		assert.equal((await send()).isError, true);
		await rm(path, { recursive: true });
		const file = await open(path, "w");
		try {
			await file.truncate(25 * 1024 * 1024 + 1);
		} finally {
			await file.close();
		}
		const result = await send();
		assert.equal(result.isError, true);
		assert.match(JSON.stringify(result.content), /25 MiB/);
	});
});
