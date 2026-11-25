// Tests of a Pi's config (`pi.json`): made once with a random id, kept, private, and refused when it is not a config.

import assert from "node:assert/strict";
import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { openConfig, readConfig, writeConfig } from "../../src/kit/config.ts";
import { rejection, tempDir } from "./support.ts";

describe("a Pi's config", () => {
	it("is made at the first open with a random id and mode 0600, and kept from then on", async () => {
		const path = join(await tempDir(), "pi.json");
		assert.equal(await readConfig(path), undefined);
		const made = await openConfig(path);
		assert.match(made.id, /^[0-9a-f]{16}$/);
		assert.deepEqual(Object.keys(made), ["id"]);
		assert.equal((await stat(path)).mode & 0o777, 0o600);
		assert.deepEqual(await openConfig(path), made);
		const other = await openConfig(join(await tempDir(), "pi.json"));
		assert.notEqual(other.id, made.id);
	});

	it("keeps the port written to it", async () => {
		const path = join(await tempDir(), "pi.json");
		const { id } = await openConfig(path);
		await writeConfig(path, { id, port: 4567 });
		assert.deepEqual(await openConfig(path), { id, port: 4567 });
	});

	it("refuses an id that is no cookie name's part, and a port that is none", async () => {
		const path = join(await tempDir(), "pi.json");
		const refused = async (config: unknown) => {
			await writeFile(path, JSON.stringify(config));
			return String(await rejection(readConfig(path)));
		};
		for (const id of ["a=b; Path", "ABCDEF0123456789", "0123", 7]) {
			assert.ok((await refused({ id })).includes('"id" must be 16 hex digits'), String(id));
		}
		for (const port of [0, 70000, 1.5, "8789"]) {
			assert.ok((await refused({ id: "0123456789abcdef", port })).includes('"port" must be a port number'));
		}
	});
});
