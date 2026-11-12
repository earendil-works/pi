// A data directory p2 wrote just before per-host stores (test/fixtures/pre-files-data: made by p2 at d9af3d73a with the
// fake provider: sessions with history, a subagent, artifacts with versions, uploads attached to messages, a download
// snapshot, a fork, a clone, an archived session, the server's store) is migrated (`npm run migrate-data`) and opens on
// this p2: the data report reads the same, every conversation's newest entry shows through `Chat`, downloads and
// attachments resolve, the copies' too, each migrated file keeps its time (old artifacts too, which stay in the files
// unused), and new artifacts, forks and uploads work on top. The fixture is never written: the test works on a copy.

import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Artifacts } from "../../plugins/artifacts/contract.ts";
import { Chat } from "../../plugins/chat/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { SessionStatus } from "../../plugins/status/contract.ts";
import { Subagents } from "../../plugins/subagents/contract.ts";
import { type DataReport, dataReport } from "../../scripts/data-report.ts";
import { migrateData } from "../../scripts/migrate-data.ts";
import { verifySessions } from "../../scripts/verify-sessions.ts";
import { startServer } from "../../src/hosts/server.ts";
import { clientHost, holdIn, http, localOwner, until } from "./helpers.ts";

const fixture = new URL("../fixtures/pre-files-data/", import.meta.url);
const expected = JSON.parse(readFileSync(new URL("report.json", fixture), "utf8")) as DataReport;
const ids = JSON.parse(readFileSync(new URL("ids.json", fixture), "utf8")) as Record<
	"alpha" | "beta" | "fork" | "clone" | "photo" | "text" | "memo",
	string
>;

test(
	"a data directory from before per-host stores migrates and opens with everything in it",
	{ timeout: 240_000 },
	async (t) => {
		const root = mkdtempSync(join(tmpdir(), "p2-pre-files-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const dataDir = join(root, "data");
		cpSync(new URL("data/", fixture), dataDir, { recursive: true });
		assert.deepEqual(dataReport(dataDir), expected);
		// Times the old files were made (their modification times, the only ones the old layout kept), apart from now.
		const downloads = join(dataDir, "downloads", ids.alpha);
		const made: Record<string, readonly [string, number]> = {
			demo1: [join(dataDir, "artifacts", ids.alpha, "demo", "1", "version.json"), 1_700_000_000_000],
			demo2: [join(dataDir, "artifacts", ids.alpha, "demo", "2", "version.json"), 1_700_000_100_000],
			upload: [join(dataDir, "uploads", ids.alpha, `${ids.text}-notes.txt`), 1_700_000_200_000],
			download: [join(downloads, readdirSync(downloads)[0]!, "metadata.json"), 1_700_000_300_000],
		};
		for (const [path, time] of Object.values(made)) utimesSync(path, new Date(time), new Date(time));

		const summary = await migrateData({ dataDir, dryRun: false });
		assert.deepEqual(summary.sessions.failed, []);
		assert.equal(summary.server, "migrated");
		assert.deepEqual(summary.sessions.migrated, Object.keys(expected.sessions).sort());
		// Artifacts 3 per Alpha copy, uploads 2 per copy and Beta's memo, a download per copy.
		assert.equal(summary.files, 3 * 3 + 2 * 3 + 1 + 3);
		assert.ok(existsSync(join(dataDir, "server", "store.sqlite")));
		assert.ok(existsSync(join(dataDir, "pre-files-backup", "server.sqlite")));
		for (const id of Object.keys(expected.sessions)) {
			assert.ok(existsSync(join(dataDir, "sessions", id, "store.sqlite")));
			assert.ok(existsSync(join(dataDir, "pre-files-backup", "sessions", `${id}.sqlite`)));
		}
		assert.deepEqual(dataReport(dataDir), expected);
		// Each migrated file keeps its time.
		const db = new DatabaseSync(join(dataDir, "sessions", ids.alpha, "store.sqlite"), { readOnly: true });
		const created = (where: string, ...values: (string | number)[]) =>
			(
				db.prepare(`SELECT created FROM "chord.app.files:files" WHERE ${where}`).get(...values) as {
					created: number;
				}
			).created;
		const versionOf = "space = 'artifacts' AND path = 'demo' AND version = ?";
		assert.equal(created(versionOf, 1), made.demo1![1]);
		assert.equal(created(versionOf, 2), made.demo2![1]);
		assert.equal(created("key = ?", ids.text), made.upload![1]);
		assert.equal(
			created("key = ?", readdirSync(join(dataDir, "pre-files-backup", "downloads", ids.alpha))[0]!),
			made.download![1],
		);
		db.close();

		const server = await startServer({ dataDir, port: 0, fake: true, web: false });
		try {
			const url = `http://127.0.0.1:${server.port}`;
			assert.deepEqual(await verifySessions(url, expected, dataDir), []);
			const local = await localOwner(server);
			const headers = { Cookie: local.cookie };
			const owner = clientHost(local);
			t.after(() => owner.close(BACKGROUND_CONTEXT));
			// The download snapshot, by its old id.
			const [download] = readdirSync(join(dataDir, "pre-files-backup", "downloads", ids.alpha));
			const sent = await http(
				server.port,
				`/download?${new URLSearchParams({ session: ids.alpha, id: download! })}`,
				{ headers },
			);
			assert.equal(sent.status, 200);
			assert.equal(sent.body, "before\n");

			// The subagent.
			const children = await holdIn(owner, Subagents, {}, "reader");
			assert.equal(
				(await until(children.children, (value) => Boolean(value?.[ids.alpha]?.length)))?.[ids.alpha]?.[0]?.name,
				"helper",
			);

			// Old uploads attach by their ids, in the session and in its fork (its own copy of them).
			const status = await holdIn(owner, SessionStatus, {}, "reader");
			for (const session of [ids.alpha, ids.fork]) {
				const chat = await holdIn(owner, Chat, { session, conversation: 1 }, "participant");
				await chat.send(
					{ text: "again", requestId: `again-${session}`, attachments: [ids.text, ids.photo] },
					BACKGROUND_CONTEXT,
				);
				const path = join(dataDir, "uploads", session, `${ids.text}-notes.txt`);
				await until(chat.view, (view) => JSON.stringify(view?.entries ?? []).includes(path));
				assert.equal(readFileSync(path, "utf8"), "uploaded before the migration\n");
				await until(status.statuses, (value) => value?.[session]?.tasks === 0);
				chat.release();
			}

			// A new artifact (the artifacts plugin's own store; the old ones stay in the files unused); a new fork copies
			// it along with the migrated files.
			const chat = await holdIn(owner, Chat, { session: ids.alpha, conversation: 1 }, "participant");
			const list = await holdIn(owner, Artifacts, { session: ids.alpha }, "editor");
			await chat.send({ text: "artifact", requestId: "after-migration" }, BACKGROUND_CONTEXT);
			await until(list.artifacts, (value) => Boolean(value?.some((info) => info.id === "demo")));
			await until(status.statuses, (value) => value?.[ids.alpha]?.tasks === 0);
			const view = await until(chat.view, (value) =>
				Boolean(value?.entries.some((entry) => entry.kind === "p2.input")),
			);
			const first = view!.entries.find((entry) => entry.kind === "p2.input")!;
			const sessions = await holdIn(owner, Sessions, {}, "owner");
			const second = view!.entries.filter((entry) => entry.kind === "p2.input").at(-1)!;
			const fork = await sessions.fork({ id: ids.alpha, conversation: 1, before: second.id }, BACKGROUND_CONTEXT);
			await until(sessions.operations, (operations) => !(operations ?? []).some((each) => each.target === fork.id));
			const forked = await holdIn(owner, Artifacts, { session: fork.id }, "editor");
			await until(forked.artifacts, (value) => Boolean(value?.some((info) => info.id === "demo")));
			forked.release();
			assert.ok(first.id < second.id);
			chat.release();
			list.release();
		} finally {
			await server.close();
		}
	},
);
