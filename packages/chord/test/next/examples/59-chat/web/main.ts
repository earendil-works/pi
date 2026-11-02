// The chat's page (the web base bundle): the channels as tabs, the current room's messages (images inline, other files
// as links), a message box and a file picker. A file goes up in chunks through the room (into its worker's files).

import * as React from "react";
import { createElement as h, useState } from "react";
import * as jsx from "react/jsx-runtime";
import { createRoot } from "react-dom/client";
import type { Held } from "../../../../../src/next/index.ts";
import { HostProvider, useHold, useWatch } from "../../../../../src/next-react/index.ts";
import { startPage } from "../../../../../src/next-web/index.ts";
import * as v1 from "../app/v1.ts";
import "./style.css";

const { BACKGROUND_CONTEXT: context, Channels, Room } = v1;

/** The size of one upload chunk. */
const CHUNK = 256 * 1024;

/** Sends `file` to `room` in chunks, then shares it. */
async function upload(room: Held<typeof Room>, file: File): Promise<void> {
	const id = await room.begin({ name: file.name, mime: file.type || "application/octet-stream" }, context);
	for (let offset = 0; offset < file.size; offset += CHUNK) {
		const bytes = new Uint8Array(await file.slice(offset, offset + CHUNK).arrayBuffer());
		await room.append({ upload: id, offset, bytes }, context);
	}
	await room.share({ upload: id, text: "" }, context);
}

function Message({ channel, message }: { channel: string; message: v1.Message }) {
	const { file } = message;
	const url = file === undefined ? "" : `/files/${channel}/${file.id}`;
	const body =
		file === undefined
			? null
			: file.mime.startsWith("image/")
				? h("img", { src: url, alt: file.name })
				: h("a", { href: url }, `${file.name} (${file.size} bytes)`);
	return h("li", null, h("b", null, message.author), " ", message.text, body);
}

function RoomView({ channel }: { channel: string }) {
	const room = useHold(Room, { id: channel });
	const messages = useWatch(room?.messages) ?? [];
	const [text, setText] = useState("");
	const send = (event: { preventDefault(): void }) => {
		event.preventDefault();
		if (room === undefined || text === "") return;
		void room.post(text, context);
		setText("");
	};
	return h(
		"section",
		null,
		h("ul", null, ...messages.map((message) => h(Message, { key: message.id, channel, message }))),
		h(
			"form",
			{ onSubmit: send },
			h("input", { value: text, onChange: (event: { target: { value: string } }) => setText(event.target.value) }),
			h("input", {
				type: "file",
				onChange: (event: { target: { files: FileList | null } }) => {
					const file = event.target.files?.[0];
					if (room !== undefined && file !== undefined) void upload(room, file);
				},
			}),
		),
	);
}

function Chat() {
	const channels = useWatch(useHold(Channels, {})?.names) ?? [];
	const [channel, setChannel] = useState("general");
	return h(
		"main",
		null,
		h(
			"nav",
			null,
			...channels.map((name) =>
				h(
					"button",
					{ key: name, type: "button", onClick: () => setChannel(name), "aria-pressed": name === channel },
					`#${name}`,
				),
			),
		),
		h(RoomView, { key: channel, channel }),
	);
}

void startPage({
	connect: () => new WebSocket(`${location.origin.replace(/^http/, "ws")}/chord`),
	modules: { "@chat/app/v1": v1, react: React, "react/jsx-runtime": jsx },
	render: (host) => createRoot(document.getElementById("root")!).render(h(HostProvider, { host }, h(Chat))),
});
