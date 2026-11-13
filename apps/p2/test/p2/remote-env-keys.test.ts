import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT, type Held, whenLive } from "@p2/app/v1";
import { Devices } from "../../plugins/devices/contract.ts";
import { Envs } from "../../plugins/envs/contract.ts";
import { PROXY_MARKER_HEADER } from "../../plugins/proxy-marker/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { Sharing } from "../../plugins/sharing/contract.ts";
import { expectChord, holdIn, http, startFixture, until, webAssets } from "./helpers.ts";

const hasKeygen = !spawnSync("ssh-keygen", ["-?"], { stdio: "ignore" }).error;
const TUNNEL = { Host: "keys.test", Origin: "https://keys.test" };
for (const via of ["token", "relay", "proxy"] as const)
	test(
		`remote ${via} owner may upload and generate SSH keys; guests cannot`,
		{ skip: hasKeygen ? false : "no ssh-keygen" },
		async (t) => {
			const fixture = await startFixture({
				allowedHosts: ["keys.test"],
				web: true,
			});
			t.after(() => fixture.close());
			const source = join(fixture.dataDir, "fixture-key");
			execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", source], { stdio: "ignore" });
			const key = await readFile(source, "utf8");
			const local = fixture.browser();
			let envs: Held<typeof Envs>;
			if (via === "token" || via === "proxy") {
				const { token } = await local.hold(Devices, {}, BACKGROUND_CONTEXT).token(BACKGROUND_CONTEXT);
				const signedIn = await http(fixture.server.port, "/owner/claim", {
					headers: { ...TUNNEL, "Content-Type": "application/json" },
					method: "POST",
					body: JSON.stringify({ token }),
				});
				assert.equal(signedIn.status, 200);
				const cookie = String(signedIn.headers["set-cookie"]).split(";")[0]!;
				envs = fixture
					.client({ ...TUNNEL, Cookie: cookie, ...(via === "proxy" ? { [PROXY_MARKER_HEADER]: "1" } : {}) })
					.host.hold(Envs, {}, BACKGROUND_CONTEXT);
			} else {
				envs = fixture.as({ kind: "owner", access: "relay" }).hold(Envs, {}, BACKGROUND_CONTEXT);
				t.after(() => envs.release());
			}
			await envs.save({ name: "box", config: { type: "ssh", host: "fixture.test" } }, BACKGROUND_CONTEXT);
			const stored = await envs.uploadKey({ name: "box", key }, BACKGROUND_CONTEXT);
			assert.match(stored.publicKey, /^ssh-ed25519 /);
			assert.equal(stored.identityFile, join(fixture.dataDir, "ssh", "keys", "box"));
			assert.equal(await readFile(stored.identityFile, "utf8"), key);
			assert.equal((await stat(stored.identityFile)).mode & 0o777, 0o600);
			const published = await until(envs.envs, (entries) => {
				const config = entries?.[0]?.config;
				return config?.type === "ssh" && config.identityFile === stored.identityFile;
			});
			assert(!JSON.stringify(published).includes("PRIVATE KEY"));
			await assert.rejects(envs.uploadKey({ name: "box", key: "invalid" }, BACKGROUND_CONTEXT), /private key/i);
			await assert.rejects(envs.uploadKey({ name: "box", key: "PRIVATE KEY".repeat(2000) }, BACKGROUND_CONTEXT));
			await assert.rejects(envs.uploadKey({ name: "../escape", key }, BACKGROUND_CONTEXT), /name/i);
			const protectedKey = join(fixture.dataDir, "protected-key");
			execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "fixture-passphrase", "-f", protectedKey], {
				stdio: "ignore",
			});
			await assert.rejects(
				envs.uploadKey({ name: "box", key: await readFile(protectedKey, "utf8") }, BACKGROUND_CONTEXT),
				/passphrase|valid/i,
			);
			assert.equal(await readFile(stored.identityFile, "utf8"), key);
			assert(!(await readdir(join(fixture.dataDir, "ssh", "keys"))).some((name) => name.startsWith(".upload-")));
			// Key generation and the public key are available to every owner too, as in Pi Mobile.
			const generated = await envs.generateKey({ name: "generated" }, BACKGROUND_CONTEXT);
			assert.match(generated.publicKey, /^ssh-ed25519 /);
			assert.equal(await envs.publicKey({ name: "generated" }, BACKGROUND_CONTEXT), generated.publicKey);
			const session = await (await holdIn(local, Sessions, {}, "owner")).create(
				{ cwd: fixture.workspace },
				BACKGROUND_CONTEXT,
			);
			const sharing = local.hold(Sharing, { session: session.id }, BACKGROUND_CONTEXT);
			await sharing.link({ mode: "full" }, BACKGROUND_CONTEXT);
			const links = await until(sharing.links, (value) => Boolean(value?.length));
			const joined = await http(fixture.server.port, "/join", {
				method: "POST",
				headers: { ...TUNNEL, "Content-Type": "application/json" },
				body: JSON.stringify({ token: links?.[0]?.token, name: "Guest" }),
			});
			assert.equal(joined.status, 200);
			const guest = fixture
				.client({ ...TUNNEL, Cookie: String(joined.headers["set-cookie"]).split(";")[0]! })
				.host.hold(Envs, {}, BACKGROUND_CONTEXT);
			await expectChord(whenLive(guest), "forbidden");
			await expectChord(guest.uploadKey({ name: "guest", key }, BACKGROUND_CONTEXT), "forbidden");
			await expectChord(guest.generateKey({ name: "guest" }, BACKGROUND_CONTEXT), "forbidden");
			await expectChord(guest.publicKey({ name: "generated" }, BACKGROUND_CONTEXT), "forbidden");
			// The envs plugin's web script, in the page's combined plugins file.
			const ui = await fixture.http(
				(await webAssets(fixture.server.port, { Cookie: fixture.owner.cookie })).plugins,
			);
			assert.equal(ui.status, 200);
			assert(ui.body.includes("Upload private key"));
			assert(!ui.body.includes("Generate/upload keys only on the device"));
		},
	);
