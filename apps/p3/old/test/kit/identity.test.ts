// Tests of a server's identity (`GET /_p3/identity`): its run id, pid and Pi's id, and the proof that it holds the
// owner token for the nonce asked, which nothing without the token can give.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { readConfig } from "../../src/kit/config.ts";
import { proofOf, proves } from "../../src/kit/identity.ts";
import { kitApp, send } from "./support.ts";

describe("a server's identity", () => {
	it("answers anyone its run id, pid and Pi, with the proof for the nonce asked; a nonce that is none gets 400", async () => {
		const { app, dataDir, port } = await kitApp();
		const token = (await readFile(app.ownerTokenFile, "utf8")).trim();
		const record = JSON.parse(await readFile(join(dataDir, "server.json"), "utf8")) as { run: string };
		const { id } = (await readConfig(join(dataDir, "pi.json")))!;
		const nonce = "0123456789abcdef0123456789abcdef";
		// No sign-in: the answer tells nothing secret, and its proof is good for this nonce only.
		const answer = await send(port, "GET", `/_p3/identity?nonce=${nonce}`);
		assert.equal(answer.status, 200);
		const said = JSON.parse(answer.body) as { run: string; pid: number; pi: string; proof: string };
		assert.deepEqual(said, { run: record.run, pid: process.pid, pi: id, proof: proofOf(token, nonce) });
		assert.match(record.run, /^[0-9a-f]{32}$/);
		for (const bad of ["", "?nonce=", "?nonce=xyz", `?nonce=${nonce}0`, `?nonce=${nonce.toUpperCase()}`]) {
			assert.equal((await send(port, "GET", `/_p3/identity${bad}`)).status, 400, bad);
		}
	});

	it("is proven only by the proof for the command's own nonce, under the owner token", () => {
		const nonce = "0123456789abcdef0123456789abcdef";
		const other = "fedcba9876543210fedcba9876543210";
		assert.ok(proves(proofOf("token", nonce), "token", nonce));
		// A proof replayed from another question, one made with another token, and what is no proof at all.
		for (const proof of [proofOf("token", other), proofOf("other", nonce), "0".repeat(64), "", undefined, 1]) {
			assert.equal(proves(proof, "token", nonce), false, String(proof));
		}
	});

	it("comes with a fresh run id at each start", async () => {
		const first = await kitApp();
		const runOf = async (dataDir: string) =>
			(JSON.parse(await readFile(join(dataDir, "server.json"), "utf8")) as { run: string }).run;
		const before = await runOf(first.dataDir);
		await first.app.close(context);
		const second = await kitApp({ dataDir: first.dataDir, root: first.root });
		assert.notEqual(await runOf(second.dataDir), before);
	});
});
