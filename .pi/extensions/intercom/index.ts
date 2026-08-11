/**
 * Intercom extension: live session-to-session messaging over a shared on-disk mailbox.
 *
 * Two pi sessions running in the same project join a named channel and talk: each
 * message is one JSON file under `<cwd>/.pi/intercom/<channel>/`, and every session
 * polls its joined channels, injecting anything new as a custom message that wakes the
 * idle agent (`triggerTurn`). No sockets, no server — latency is one poll interval,
 * which is real-time enough for agents. See DESIGN.md.
 *
 * Surface:
 * - Tools `intercom_send` / `intercom_wait` — how the LLM talks and listens in-turn.
 * - `/intercom join|leave|clear|status` — how the user wires a session up by hand.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { formatIncoming } from "./format.ts";
import {
	clearChannel,
	collectNew,
	INTERCOM_SCHEMA,
	type IntercomMessage,
	isValidChannel,
	listChannels,
	listMessageFiles,
	writeMessage,
} from "./store.ts";

const POLL_MS = 1500;
const WAIT_POLL_MS = 500;
const WAIT_DEFAULT_S = 60;
const WAIT_MAX_S = 300;

interface ChannelState {
	alias?: string;
	/** Last filename seen. Undefined until the first scan = deliver the full backlog. */
	cursor?: string;
	/** True while an `intercom_wait` owns this channel; the watcher stays out of its way. */
	waiting: boolean;
}

interface IntercomState {
	joined: Map<string, ChannelState>;
	/** Captured from the latest `session_start`; the watcher tick has no event ctx. */
	cwd?: string;
	sessionId?: string;
	/** Per-process send sequence; orders same-millisecond sends from this session. */
	seq: number;
	/** Last watcher failure, surfaced via `/intercom status` — a watcher must never throw. */
	watchError?: string;
}

function normalizeChannel(raw: string): string | undefined {
	const name = raw.trim().toLowerCase();
	return isValidChannel(name) ? name : undefined;
}

function join(state: IntercomState, channel: string, alias?: string): ChannelState {
	let entry = state.joined.get(channel);
	if (!entry) {
		entry = { waiting: false };
		state.joined.set(channel, entry);
	}
	if (alias) entry.alias = alias;
	return entry;
}

/** One watcher pass over every joined channel. Failures land in `watchError`, never throw. */
function tick(pi: ExtensionAPI, state: IntercomState): void {
	if (!state.cwd || !state.sessionId) return;
	for (const [channel, entry] of state.joined) {
		if (entry.waiting) continue;
		try {
			const collected = collectNew(state.cwd, channel, entry.cursor, state.sessionId);
			entry.cursor = collected.cursor;
			state.watchError = undefined;
			if (collected.messages.length === 0) continue;
			pi.sendMessage(
				{ customType: "intercom", content: formatIncoming(channel, collected.messages), display: true },
				// steer + triggerTurn: an idle session wakes up and answers; a busy one sees
				// the message before its next LLM call instead of after the whole turn.
				{ deliverAs: "steer", triggerTurn: true },
			);
		} catch (err) {
			state.watchError = err instanceof Error ? err.message : String(err);
		}
	}
}

function registerWatcher(pi: ExtensionAPI, state: IntercomState): void {
	let started = false;
	pi.on("session_start", (_event, ctx) => {
		// Every reason, including resume/fork: whatever session is live now is the sender
		// identity and cwd the watcher must use.
		state.cwd = ctx.cwd;
		state.sessionId = ctx.sessionManager.getSessionId();
		if (started) return;
		started = true;
		// unref: a forgotten channel must never hold pi's exit open.
		setInterval(() => tick(pi, state), POLL_MS).unref();
	});
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolvePromise) => {
		const timer = setTimeout(done, ms);
		function done(): void {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			resolvePromise();
		}
		signal?.addEventListener("abort", done, { once: true });
	});
}

const SEND_PARAMS = Type.Object({
	channel: Type.String({ description: "Channel name, e.g. 'handoff' or 'constellation'" }),
	message: Type.String({ description: "The message to send" }),
	alias: Type.Optional(
		Type.String({ description: "Name to appear as on this channel from now on, e.g. 'laptop-player'" }),
	),
});

const WAIT_PARAMS = Type.Object({
	channel: Type.String({ description: "Channel name to listen on" }),
	timeout_seconds: Type.Optional(
		Type.Number({ description: `How long to wait before giving up (default ${WAIT_DEFAULT_S}, max ${WAIT_MAX_S})` }),
	),
});

function registerTools(pi: ExtensionAPI, state: IntercomState): void {
	pi.registerTool({
		name: "intercom_send",
		label: "Intercom Send",
		description:
			"Send a message to another pi session over a named intercom channel. " +
			"Sessions in the same project directory sharing a channel name receive each other's messages.",
		promptSnippet: "Message another pi session on a named channel",
		promptGuidelines: [
			"Use intercom_send to talk to another pi session (answering its questions, coordinating work); after sending a question, call intercom_wait on the same channel for the reply.",
		],
		parameters: SEND_PARAMS,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const channel = normalizeChannel(params.channel);
			// Throwing is pi's error contract for tools: it sets isError on the result.
			if (!channel) throw new Error(`Invalid channel name: ${params.channel}`);
			const entry = join(state, channel, params.alias?.trim() || undefined);
			const message: IntercomMessage = {
				schema: INTERCOM_SCHEMA,
				channel,
				sender: ctx.sessionManager.getSessionId(),
				created: new Date().toISOString(),
				text: params.message,
			};
			if (entry.alias) message.alias = entry.alias;
			const path = writeMessage(ctx.cwd, message, state.seq++);
			return {
				content: [{ type: "text", text: `Sent to #${channel} (${path}).` }],
				details: { channel, path },
			};
		},
	});

	pi.registerTool({
		name: "intercom_wait",
		label: "Intercom Wait",
		description:
			"Wait for new intercom messages from other pi sessions on a channel. " +
			"Blocks until a message arrives or the timeout passes. Joining a channel delivers its existing backlog immediately.",
		promptSnippet: "Wait for a message from another pi session",
		promptGuidelines: [
			"Use intercom_wait when expecting a reply or instruction from another session; prefer one long wait over many short ones.",
		],
		parameters: WAIT_PARAMS,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const channel = normalizeChannel(params.channel);
			if (!channel) throw new Error(`Invalid channel name: ${params.channel}`);
			const timeoutS = Math.min(Math.max(params.timeout_seconds ?? WAIT_DEFAULT_S, 1), WAIT_MAX_S);
			const sessionId = ctx.sessionManager.getSessionId();
			const entry = join(state, channel);
			entry.waiting = true;
			try {
				const deadline = Date.now() + timeoutS * 1000;
				for (;;) {
					const collected = collectNew(ctx.cwd, channel, entry.cursor, sessionId);
					entry.cursor = collected.cursor;
					if (collected.messages.length > 0) {
						return {
							content: [{ type: "text", text: formatIncoming(channel, collected.messages) }],
							details: { channel, count: collected.messages.length },
						};
					}
					if (signal?.aborted) throw new Error("Wait cancelled.");
					if (Date.now() >= deadline) {
						return {
							content: [
								{ type: "text", text: `No messages on #${channel} within ${timeoutS}s. Still joined; the watcher will deliver anything that arrives later.` },
							],
							details: { channel, count: 0 },
						};
					}
					await sleep(Math.min(WAIT_POLL_MS, deadline - Date.now()), signal);
				}
			} finally {
				entry.waiting = false;
			}
		},
	});
}

const USAGE = "Usage: /intercom join <channel> [as <alias>] | leave <channel> | clear <channel> | status";

function registerIntercomCommand(pi: ExtensionAPI, state: IntercomState): void {
	pi.registerCommand("intercom", {
		description: "Session-to-session messaging: /intercom join <channel> [as <alias>] | leave | clear | status",
		handler: async (args, ctx: ExtensionCommandContext) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const [verb, rawChannel] = parts;

			if (verb === "status") {
				const joined = [...state.joined.entries()]
					.map(([name, entry]) => `#${name}${entry.alias ? ` as ${entry.alias}` : ""}`)
					.join(", ");
				const onDisk = listChannels(ctx.cwd)
					.map((name) => `#${name} (${listMessageFiles(ctx.cwd, name).length})`)
					.join(", ");
				const lines = [
					`Joined: ${joined || "none"}`,
					`On disk: ${onDisk || "none"}`,
					...(state.watchError ? [`Watcher error: ${state.watchError}`] : []),
				];
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			if (!verb || !rawChannel) {
				ctx.ui.notify(USAGE, "error");
				return;
			}
			const channel = normalizeChannel(rawChannel);
			if (!channel) {
				ctx.ui.notify(`Invalid channel name: ${rawChannel}`, "error");
				return;
			}

			switch (verb) {
				case "join": {
					// `/intercom join dev as laptop-player`
					const alias = parts[2] === "as" ? parts.slice(3).join(" ") : undefined;
					join(state, channel, alias);
					ctx.ui.notify(
						`Joined #${channel}${alias ? ` as ${alias}` : ""}. Backlog and new messages will be delivered.`,
						"info",
					);
					return;
				}
				case "leave": {
					if (!state.joined.delete(channel)) {
						ctx.ui.notify(`Not joined to #${channel}`, "warning");
						return;
					}
					ctx.ui.notify(`Left #${channel}`, "info");
					return;
				}
				case "clear": {
					const removed = clearChannel(ctx.cwd, channel);
					// Reset the cursor so the channel reads as brand new: the next scan treats
					// whatever arrives as a fresh backlog rather than a continuation.
					const joinedEntry = state.joined.get(channel);
					if (joinedEntry) joinedEntry.cursor = undefined;
					ctx.ui.notify(`Cleared #${channel} (${removed} message${removed === 1 ? "" : "s"} removed)`, "info");
					return;
				}
				default:
					ctx.ui.notify(USAGE, "error");
			}
		},
	});
}

/** Sets injected intercom traffic apart from the user's own prompts in the transcript. */
function registerIntercomRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer("intercom", (message, { outputPad }, theme) => {
		const text = typeof message.content === "string" ? message.content : "";
		const [banner, ...rest] = text.split("\n");
		const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
		box.addChild(new Text(`${theme.fg("accent", banner)}\n${rest.join("\n")}`, 0, 0));
		return box;
	});
}

export default function (pi: ExtensionAPI) {
	const state: IntercomState = { joined: new Map(), seq: 0 };
	registerWatcher(pi, state);
	registerIntercomRenderer(pi);
	registerTools(pi, state);
	registerIntercomCommand(pi, state);
}
