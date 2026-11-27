// The backup plugin end to end, on p3's real server: the default is stored, so it survives a restart and a reload of
// the plugin while the owner holds `Backups`.

import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context, until } from "@earendil-works/p3/v1";
import { testServer } from "@earendil-works/p3/v1/testing";
import { within } from "../../../test/until.ts";
import { Backups } from "../contract.ts";

describe("the default", () => {
	it("is kept across a restart", async () => {
		const first = await testServer({}, context);
		let t = first;
		try {
			const backups = async () => (await t.client(context)).get(Backups, {}, context);
			await (await backups()).setDefault(true, context);
			t = await first.restart(context);
			assert.equal((await backups()).defaultEnabled.value, true);
		} finally {
			await t.close(context);
		}
	});

	it("is kept through a reload of the plugin while the owner holds it", async () => {
		// A copy of the built-in plugins, so the test can edit the backup plugin as a person would.
		const dir = await mkdtemp(join(tmpdir(), "p3-backup-reload-"));
		const builtIn = join(dir, "built-in");
		await cp(fileURLToPath(new URL("../../", import.meta.url)), builtIn, { recursive: true });
		const t = await testServer({ builtIn }, context);
		try {
			const backups = await (await t.client(context)).get(Backups, {}, context);
			await backups.setDefault(true, context);
			const file = join(builtIn, "backup", "server.ts");
			await writeFile(file, `${await readFile(file, "utf8")}\n// edited\n`);
			await until(t.plugins, (marks) => marks.dirty.length > 0, within("the watcher's marks", context, 10_000));
			await t.apply(context);
			await until(backups.state, (state) => state.kind === "live", within("Backups live again", context));
			assert.equal(backups.defaultEnabled.value, true);
			// It still works after the reload.
			await backups.setDefault(false, context);
			assert.equal(backups.defaultEnabled.value, false);
			assert.deepEqual(t.errors, []);
		} finally {
			await t.close(context);
			await rm(dir, { recursive: true, force: true });
		}
	});
});
