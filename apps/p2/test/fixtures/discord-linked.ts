// Browser-only component fixture, bundled by `Browser.loadFixture` into a disposable localhost page: a linked session's
// Discord sheet body (`LinkedView`) with a server's roles and two MCP servers; saves and unlinks are recorded on
// `window.discordCalls`, and `window.failNextSave` makes the next save fail.
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Binding } from "../../plugins/discord/contract.ts";
import { LinkedView } from "../../plugins/discord/LinkSheet.tsx";

const calls: unknown[] = [];
const binding: Binding = {
	botId: "bot1",
	channelId: "100",
	channelName: "general",
	guildId: "g1",
	guildName: "Guild",
	session: "s1",
	wake: { anyone: false, users: ["123456789"], roles: ["r1"] },
	cursor: null,
	threads: {},
	createdAt: 1,
};
const flags = window as unknown as { discordCalls: unknown[]; failNextSave?: boolean };
flags.discordCalls = calls;
const element = document.createElement("div");
element.className = "sheet-body";
document.body.replaceChildren(element);
createRoot(element).render(
	createElement(LinkedView, {
		binding,
		botName: "pixi#6938",
		connected: true,
		sandbox: "box1",
		lock: { mcp: ["docs"], projectMcp: false, instructions: true, capabilities: [] },
		server: {
			channels: [{ id: "100", name: "general" }],
			roles: [
				{ id: "r1", name: "maintainers" },
				{ id: "r2", name: "helpers" },
			],
		},
		servers: ["docs", "tracker"],
		onSave: async (wake, lock) => {
			if (flags.failNextSave) {
				flags.failNextSave = false;
				throw new Error("The session is busy");
			}
			calls.push({ save: { wake, lock } });
		},
		onUnlink: async () => {
			calls.push("unlink");
		},
	}),
);
