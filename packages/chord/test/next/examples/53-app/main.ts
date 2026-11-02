// The app kit (slice 13): an app is its API (`app/`), its built-in plugins (`plugins/`: home and notes) and a start
// script (`start.ts`) calling `startApp`; its workers' entry (`worker.ts`) calls `startWorker`. The kit makes the data
// directory, the server's store and host, HTTP (deny by default: no session, 401), one worker per project with its own
// store and files, and the owner's sign-in: a one-time owner link for the browser, an owner token file for command-line
// clients on the same machine.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/next/examples/53-app/main.ts
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "../../../../src/context/index.ts";
import { call } from "./client.ts";
import { startNotes } from "./start.ts";

const dataDir = join(await mkdtemp(join(tmpdir(), "notes-")), "data");

// 1. Start the app. The start script prints the owner link (single use, 10 minutes, a new one at each start).
const app = await startNotes(dataDir, context);
const link = new URL(app.ownerLink());
const port = Number(link.port);
console.log("1. owner link:", `${link.origin}${link.pathname}#…`);
console.log("   data directory:", (await readdir(dataDir)).sort().join(", "));

// 2. Nobody is signed in: every plugin route answers 401 before the plugin runs.
console.log("2. anonymous GET /:", (await call(port, "GET", "/")).status);

// 3. The owner opens the link: the page posts the token from the URL's fragment (never sent in a URL, so never in a
//    log) and gets the session cookie. The link is used up.
const page = await call(port, "GET", link.pathname);
console.log(
	"3. the link's page:",
	page.status,
	String(page.body).includes("location.hash") ? "(reads the fragment)" : "",
);
const signedIn = await call(port, "POST", link.pathname, {}, { token: link.hash.slice(1) });
const browser = { cookie: signedIn.cookie ?? "" };
console.log("   signed in:", signedIn.status, signedIn.body);
console.log("   the link again:", (await call(port, "POST", link.pathname, {}, { token: link.hash.slice(1) })).status);

// 4. Signed in, the home plugin reads the kit's `AppInfo` and lists the sections of its registry (the notes plugin's);
//    the notes plugin's routes reach the project's worker (it starts on the first request) with its store and the
//    start data the app gave it.
console.log("4. GET /:", JSON.stringify((await call(port, "GET", "/", browser)).body));
await call(port, "POST", "/notes/p1", browser, "milk, eggs");
console.log("   GET /notes/p1:", JSON.stringify((await call(port, "GET", "/notes/p1", browser)).body));
console.log("   worker directories:", (await readdir(join(dataDir, "workers", "project"))).join(", "));

// 5. A command-line client on the same machine reads the owner token file (mode 0600) and sends it as a bearer token.
const token = (await readFile(app.ownerTokenFile, "utf8")).trim();
const cli = { authorization: `Bearer ${token}` };
console.log("5. CLI GET /:", JSON.stringify((await call(port, "GET", "/", cli)).body));

// 6. Close: HTTP, workers, host, store, in that order.
await app.close(context);
await rm(join(dataDir, ".."), { recursive: true, force: true });
console.log("6. closed");
