// The chat in a terminal (the terminal base bundle, run in the launcher's sandbox): the channels (Tab switches), the
// current room's messages (an image as a placeholder, other files as their link), and a line to type into. Enter
// posts; `/attach <path>` asks the launcher for a file of this machine (it asks the user) and shares it in chunks;
// Ctrl-C quits.

import type { Held } from "../../../../src/index.ts";
import { type AttachedFile, startTerminalRuntime, TuiScope } from "../../../../src/tui/index.ts";
import * as v1 from "../app/v1.ts";

const { BACKGROUND_CONTEXT: context, Channels, Room } = v1;

/** The size of one upload chunk. */
const CHUNK = 256 * 1024;

/** Shares `file` in `room`, in chunks. */
async function share(room: Held<typeof Room>, file: AttachedFile): Promise<void> {
	const mime = /\.(png|jpe?g|gif|webp)$/i.test(file.name)
		? `image/${file.name.split(".").pop()!.toLowerCase()}`
		: "application/octet-stream";
	const id = await room.begin({ name: file.name, mime }, context);
	for (let offset = 0; offset < file.bytes.length; offset += CHUNK) {
		await room.append({ upload: id, offset, bytes: file.bytes.subarray(offset, offset + CHUNK) }, context);
	}
	await room.share({ upload: id, text: "" }, context);
}

/** One message as a line. */
function line(message: v1.Message, channel: string, theme: { fg(role: string, text: string): string }): string {
	const { file } = message;
	const attached =
		file === undefined
			? ""
			: file.mime.startsWith("image/")
				? ` ${theme.fg("muted", `[image: ${file.name}]`)}`
				: ` ${theme.fg("accent", `[${file.name}] /files/${channel}/${file.id}`)}`;
	return `${theme.fg("accent", message.author)} ${message.text}${attached}`;
}

void startTerminalRuntime({
	modules: { "@chat/app/v1": v1 },
	render: (runtime) => {
		const { terminal, theme } = runtime;
		const scope = new TuiScope(runtime.host, () => draw());
		const channels = scope.watch(scope.hold(Channels, {}).names);
		// Each channel's room held once, on first view.
		const rooms = new Map<string, { room: Held<typeof Room>; messages: () => readonly v1.Message[] | undefined }>();
		const roomOf = (id: string) => {
			let held = rooms.get(id);
			if (held === undefined) {
				const room = scope.hold(Room, { id });
				held = { room, messages: scope.watch(room.messages) };
				rooms.set(id, held);
			}
			return held;
		};
		let channel = "general";
		let draft = "";
		const draw = (): void => {
			const tabs = (channels() ?? []).map((name) =>
				name === channel ? theme.fg("accent", `#${name}`) : `#${name}`,
			);
			const shown = (roomOf(channel).messages() ?? [])
				.slice(-(terminal.rows - 3))
				.map((message) => line(message, channel, theme));
			terminal.write(`\x1b[2J\x1b[H${tabs.join(" ")}\r\n${shown.join("\r\n")}\r\n> ${draft}`);
		};
		const send = (text: string): void => {
			if (text.startsWith("/attach ")) {
				const { room } = roomOf(channel);
				void runtime
					.attach(text.slice(8).trim())
					.then((file) => (file === undefined ? undefined : share(room, file)));
			} else if (text !== "") void roomOf(channel).room.post(text, context);
		};
		terminal.onInput((data) => {
			if (data === "\x03") runtime.exit(0);
			else if (data === "\t") {
				const names = channels() ?? [];
				channel = names[(names.indexOf(channel) + 1) % names.length] ?? channel;
			} else if (data === "\r") {
				send(draft);
				draft = "";
			} else if (data === "\x7f") draft = draft.slice(0, -1);
			else if (!data.startsWith("\x1b")) draft += data;
			draw();
		});
		theme.onChange(draw);
		draw();
	},
});
