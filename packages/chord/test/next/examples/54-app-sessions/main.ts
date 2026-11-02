// Sessions and device pairing (slice 13 §2), with example 53's notes app. A command-line client on another machine
// has no owner token file: it asks for a pairing code (`POST /_chord/pair`, public), the owner approves the code in a
// signed-in browser (`/_chord/pair/<code>`, owner only), and the client's next poll returns its device token, once.
// The owner lists the sessions (`Sessions`, the kit's object; never a token or its hash) and revokes the device's.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/next/examples/54-app-sessions/main.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "../../../../src/context/index.ts";
import { Sessions } from "../../../../src/next-node/app/index.ts";
import { call } from "../53-app/client.ts";
import { startNotes } from "../53-app/start.ts";

const base = await mkdtemp(join(tmpdir(), "notes-"));
const app = await startNotes(join(base, "data"), context);
const link = new URL(app.ownerLink());
const port = Number(link.port);

// 1. The owner signs in in the browser with the owner link (example 53).
const browser = { cookie: (await call(port, "POST", link.pathname, {}, { token: link.hash.slice(1) })).cookie ?? "" };

// 2. The client asks for a code and shows it; it keeps the poll secret to itself.
const { code, poll } = (await call(port, "POST", "/_chord/pair", {}, { label: "laptop CLI" })).body as {
	code: string;
	poll: string;
};
console.log("1. pairing code:", code.replace(/[A-Z0-9]/g, "X"));
console.log("   poll:", JSON.stringify((await call(port, "POST", "/_chord/pair/poll", {}, { poll })).body));

// 3. Only the owner may see and approve it: an anonymous request is refused before the kit's route runs.
console.log("2. anonymous approval:", (await call(port, "POST", `/_chord/pair/${code}`)).status);
const confirm = await call(port, "GET", `/_chord/pair/${code}`, browser);
console.log(
	"   the owner's confirm page:",
	confirm.status,
	String(confirm.body).includes("laptop CLI") ? "(names the device)" : "",
);
console.log("   approved:", (await call(port, "POST", `/_chord/pair/${code}`, browser)).status);

// 4. The client's next poll returns its token, once; it signs in with it as a bearer token.
const approved = (await call(port, "POST", "/_chord/pair/poll", {}, { poll })).body as {
	status: string;
	token: string;
};
console.log("3. poll:", approved.status);
console.log("   poll again:", (await call(port, "POST", "/_chord/pair/poll", {}, { poll })).status);
const device = { authorization: `Bearer ${approved.token}` };
console.log("   CLI GET /:", JSON.stringify((await call(port, "GET", "/", device)).body));

// 5. The owner lists the sessions (a server plugin would do this with `self.get(Sessions, {})`) and revokes the
//    device's: its next request is refused.
const sessions = await app.host.get(Sessions, {}, context);
console.log("4. sessions:");
for (const { kind, label } of sessions.list.value) console.log(`   ${kind}: ${label}`);
const laptop = sessions.list.value.find(({ label }) => label === "laptop CLI");
await sessions.revoke(laptop?.id ?? "", context);
console.log("   revoked; CLI GET /:", (await call(port, "GET", "/", device)).status);
sessions.release();

await app.close(context);
await rm(base, { recursive: true, force: true });
