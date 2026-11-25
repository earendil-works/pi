// A chat (slice 11 with the app kit): one worker per channel (`Channel({ id })`), each channel's `Room` on its worker
// with every message in a table of the worker's store (the newest 100 live, older ones by page: `history`) and the
// attachments in its files (the kit's `Files`, sent in chunks); the server keeps the channel list and serves the page
// (`/chat`, after picking a name at `/`) and the terminal client. A browser and a terminal are live in the same room.
// Here a user who picked a name ("ada") joins over the same Chord link a page uses, and with Node 26.5.1 or later the
// owner's terminal client joins too.
// Run from packages/chord (`--serve` keeps it running: open the printed URL, and run the terminal with 57-tui's
// `terminal.ts` and the owner token file):
//   node --conditions=source --experimental-strip-types test/examples/59-chat/main.ts
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { WebSocket } from "ws";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { createHost, type WebSocketLike, webSocketLink } from "../../../src/index.ts";
import { requireSandboxNode, startTerminal } from "../../../src/node/tui/index.ts";
import type { ChatPrincipal } from "./app/principals.ts";
import { Room } from "./app/v1.ts";
import { chatDirectories, startChat } from "./start.ts";

const { base, dataDir, root } = await chatDirectories();
const app = await startChat(dataDir, root, context);
const url = new URL(app.ownerLink()).origin;
console.log(`1. the chat at ${url}/ (pick a name), the page at ${url}/chat`);

// 2. Ada picks a name (the kit's ephemeral login) and joins over the links endpoint with her sign-in cookie.
const login = await fetch(`${url}/_chord/login`, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: '{"name":"ada"}',
});
const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
const ada = createHost<ChatPrincipal>({ onError: () => {} });
await ada.load([], context);
const socket = new WebSocket(`${url.replace(/^http/, "ws")}/chord`, { headers: { cookie } });
ada.connect(webSocketLink(socket as unknown as WebSocketLike), { principal: { kind: "server" } }, context);
const general = await ada.get(Room, { id: "general" }, context);
await general.post("hello from ada", context);
const random = await ada.get(Room, { id: "random" }, context);
await random.post("anyone here?", context);
console.log("2. ada posted in #general and #random");

// 3. A picture, in chunks as the page sends one: into #general's worker files, then shared as a message.
const png = new Uint8Array(
	Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
		"base64",
	),
);
const upload = await general.begin({ name: "dot.png", mime: "image/png" }, context);
for (let offset = 0; offset < png.length; offset += 32) {
	await general.append({ upload, offset, bytes: png.subarray(offset, offset + 32) }, context);
}
await general.share({ upload, text: "a picture" }, context);
const shared = general.messages.value.at(-1)!;
const image = await fetch(`${url}/files/general/${shared.file!.id}`, { headers: { cookie } });
console.log(
	`3. shared ${shared.file!.name}: GET /files/general/… ${image.status} ${image.headers.get("content-type")}, ${(await image.arrayBuffer()).byteLength} bytes`,
);
console.log("   one worker per channel:", Object.keys(app.workers.get("channel")!.state.value).join(", "));

// 4. Every message is kept in the channel's table: the room shows the newest 100 live and pages older ones.
for (let n = 1; n <= 120; n++) await random.post(`message ${n}`, context);
while (random.messages.value.at(-1)?.text !== "message 120") await new Promise((resolve) => setTimeout(resolve, 20));
const live = random.messages.value;
const older = await random.history({ before: live[0]!.id }, context);
console.log(
	`4. #random keeps ${older.length + live.length} messages: ${live.length} live (from "${live[0]!.text}"), ${older.length} older by history (from "${older[0]!.text}")`,
);

// 5. The owner's terminal client in the same room (Node 26.5.1 or later): it shows ada's messages; its post and an
//    attached file (the launcher asks before it reads the file) reach ada at once; PgUp in #random loads older ones.
let sandboxed = true;
try {
	requireSandboxNode();
} catch (error) {
	sandboxed = false;
	console.log(`5. (${(error as Error).message})`);
}
if (sandboxed) {
	const input = new PassThrough();
	const output = Object.assign(new PassThrough(), { columns: 80, rows: 20 });
	let screen = "";
	output.on("data", (chunk: Buffer) => {
		screen += chunk.toString();
	});
	const terminal = await startTerminal({
		url,
		credentials: { kind: "file", path: app.ownerTokenFile },
		input,
		output,
	});
	const shows = async (text: string): Promise<void> => {
		while (!screen.replace(/\x1b\[[0-9;]*m/g, "").includes(text))
			await new Promise((resolve) => setTimeout(resolve, 20));
	};
	await shows("[image: dot.png]");
	console.log(
		"5. the terminal shows:",
		JSON.stringify(
			screen
				.split("\x1b[2J\x1b[H")
				.at(-1)!
				.replace(/\x1b\[[0-9;]*m/g, "")
				.split("\r\n")
				.slice(1, 3),
		),
	);
	input.write("hi ada, from the terminal");
	input.write("\r");
	const notes = join(base, "notes.txt");
	await writeFile(notes, "the agenda");
	input.write(`/attach ${notes}`);
	input.write("\r");
	// The launcher's prompt names the file's real path and asks; only a yes lets it read the file. Keys typed in the
	// first 300 ms of a prompt are ignored (they were meant for the app).
	await shows("Attach this file? [y/N]");
	await new Promise((resolve) => setTimeout(resolve, 350));
	input.write("y");
	while (general.messages.value.at(-1)?.file?.name !== "notes.txt")
		await new Promise((resolve) => setTimeout(resolve, 20));
	const last = general.messages.value
		.slice(-2)
		.map((message) => `${message.author}: ${message.text || message.file?.name}`);
	console.log("   ada sees:", last.join(" | "));
	// #random, then PgUp to its first message: the terminal loads the page before the live window.
	input.write("\t");
	for (let n = 0; n < 8; n++) {
		input.write("\x1b[5~");
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	await shows("ada anyone here?");
	console.log("   PgUp in #random reaches its first message: anyone here?");
	input.write("\x03");
	await terminal.exited;
}

if (process.argv.includes("--serve")) {
	console.log(`Owner token file: ${app.ownerTokenFile}`);
} else {
	general.release();
	random.release();
	await ada.close(context);
	await app.close(context);
	await rm(base, { recursive: true, force: true });
}
