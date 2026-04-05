#!/usr/bin/env node

import { existsSync } from "fs";
import { join, resolve } from "path";
import { type AgentRunner, getOrCreateRunner } from "./agent.js";
import { getMomConfig, initMomConfig } from "./config.js";
import { getConversationKey, getSessionThreadRoot } from "./conversation.js";
import { downloadChannel } from "./download.js";
import { createEventsWatcher } from "./events.js";
import * as log from "./log.js";
import { parseSandboxArg, type SandboxConfig, validateSandbox } from "./sandbox.js";
import { type MomHandler, type SlackBot, SlackBot as SlackBotClass, type SlackEvent } from "./slack.js";
import { ChannelStore } from "./store.js";
import { TrackedThreadsManager } from "./tracked-threads.js";
import { isProbablyAudioFile, transcribeAudio, updateLoggedMessageText } from "./voice.js";

// ============================================================================
// Config
// ============================================================================

const MOM_SLACK_APP_TOKEN = process.env.MOM_SLACK_APP_TOKEN;
const MOM_SLACK_BOT_TOKEN = process.env.MOM_SLACK_BOT_TOKEN;

interface ParsedArgs {
	workingDir?: string;
	sandbox: SandboxConfig;
	downloadChannel?: string;
}

function parseArgs(): ParsedArgs {
	const args = process.argv.slice(2);
	let sandbox: SandboxConfig = { type: "host" };
	let workingDir: string | undefined;
	let downloadChannelId: string | undefined;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg.startsWith("--sandbox=")) {
			sandbox = parseSandboxArg(arg.slice("--sandbox=".length));
		} else if (arg === "--sandbox") {
			sandbox = parseSandboxArg(args[++i] || "");
		} else if (arg.startsWith("--download=")) {
			downloadChannelId = arg.slice("--download=".length);
		} else if (arg === "--download") {
			downloadChannelId = args[++i];
		} else if (!arg.startsWith("-")) {
			workingDir = arg;
		}
	}

	return {
		workingDir: workingDir ? resolve(workingDir) : undefined,
		sandbox,
		downloadChannel: downloadChannelId,
	};
}

const parsedArgs = parseArgs();

// Handle --download mode
if (parsedArgs.downloadChannel) {
	if (!MOM_SLACK_BOT_TOKEN) {
		console.error("Missing env: MOM_SLACK_BOT_TOKEN");
		process.exit(1);
	}
	await downloadChannel(parsedArgs.downloadChannel, MOM_SLACK_BOT_TOKEN);
	process.exit(0);
}

// Normal bot mode - require working dir
if (!parsedArgs.workingDir) {
	console.error("Usage: mom [--sandbox=host|docker:<name>] <working-directory>");
	console.error("       mom --download <channel-id>");
	process.exit(1);
}

const { workingDir, sandbox } = { workingDir: parsedArgs.workingDir, sandbox: parsedArgs.sandbox };

if (!MOM_SLACK_APP_TOKEN || !MOM_SLACK_BOT_TOKEN) {
	console.error("Missing env: MOM_SLACK_APP_TOKEN, MOM_SLACK_BOT_TOKEN");
	process.exit(1);
}

await validateSandbox(sandbox);

initMomConfig();
const momConfig = getMomConfig();
const trackedThreads = momConfig.trackThreads ? new TrackedThreadsManager(workingDir) : null;
trackedThreads?.load();

// ============================================================================
// State (per Slack conversation = channel + thread root)
// ============================================================================

interface ConversationState {
	running: boolean;
	runner: AgentRunner;
	store: ChannelStore;
	stopRequested: boolean;
	stopMessageTs?: string;
}

const conversationStates = new Map<string, ConversationState>();
const channelStores = new Map<string, ChannelStore>();

function getChannelStore(channelId: string): ChannelStore {
	let store = channelStores.get(channelId);
	if (!store) {
		store = new ChannelStore({ workingDir, botToken: MOM_SLACK_BOT_TOKEN! });
		channelStores.set(channelId, store);
	}
	return store;
}

function getConversationState(
	conversationKey: string,
	channelId: string,
	sessionThreadRoot: string,
): ConversationState {
	let state = conversationStates.get(conversationKey);
	if (!state) {
		const channelDir = join(workingDir, channelId);
		state = {
			running: false,
			runner: getOrCreateRunner(sandbox, channelId, channelDir, sessionThreadRoot),
			store: getChannelStore(channelId),
			stopRequested: false,
		};
		conversationStates.set(conversationKey, state);
	}
	return state;
}

// ============================================================================
// Create SlackContext adapter
// ============================================================================

function createSlackContext(
	event: SlackEvent,
	slack: SlackBot,
	state: ConversationState,
	threadRootForLog: string,
	isEvent?: boolean,
) {
	let messageTs: string | null = null;
	const threadMessageTs: string[] = [];
	let accumulatedText = "";
	let isWorking = true;
	const workingIndicator = " ...";
	let lastDisplayText = "";
	let updatePromise = Promise.resolve();

	const user = slack.getUser(event.user);
	const cfg = getMomConfig();
	const threadRoot = !isEvent && cfg.slackReplyInUserThread ? (event.threadTs ?? event.ts) : null;

	// Extract event filename for status message
	const eventFilename = isEvent ? event.text.match(/^\[EVENT:([^:]+):/)?.[1] : undefined;

	async function postMainOrThread(text: string): Promise<string> {
		if (threadRoot) {
			return slack.postInThread(event.channel, threadRoot, text);
		}
		return slack.postMessage(event.channel, text);
	}

	return {
		message: {
			text: event.text,
			rawText: event.text,
			user: event.user,
			userName: user?.userName,
			channel: event.channel,
			ts: event.ts,
			attachments: (event.attachments || []).map((a) => ({ local: a.local })),
		},
		channelName: slack.getChannel(event.channel)?.name,
		store: state.store,
		channels: slack.getAllChannels().map((c) => ({ id: c.id, name: c.name })),
		users: slack.getAllUsers().map((u) => ({ id: u.id, userName: u.userName, displayName: u.displayName })),

		respond: async (text: string, shouldLog = true) => {
			updatePromise = updatePromise.then(async () => {
				try {
					accumulatedText = accumulatedText ? `${accumulatedText}\n${text}` : text;

					// Truncate accumulated text if too long (Slack limit is 40K, we use 35K for safety)
					const MAX_MAIN_LENGTH = 35000;
					const truncationNote = "\n\n_(message truncated, ask me to elaborate on specific parts)_";
					if (accumulatedText.length > MAX_MAIN_LENGTH) {
						accumulatedText =
							accumulatedText.substring(0, MAX_MAIN_LENGTH - truncationNote.length) + truncationNote;
					}

					const displayText = isWorking ? accumulatedText + workingIndicator : accumulatedText;

					if (displayText === lastDisplayText) {
						return;
					}

					if (messageTs) {
						await slack.updateMessage(event.channel, messageTs, displayText);
					} else {
						messageTs = await postMainOrThread(displayText);
					}
					lastDisplayText = displayText;

					if (shouldLog && messageTs) {
						slack.logBotResponse(event.channel, text, messageTs, threadRootForLog);
					}
				} catch (err) {
					log.logWarning("Slack respond error", err instanceof Error ? err.message : String(err));
				}
			});
			await updatePromise;
		},

		replaceMessage: async (text: string) => {
			updatePromise = updatePromise.then(async () => {
				try {
					// Replace the accumulated text entirely, with truncation
					const MAX_MAIN_LENGTH = 35000;
					const truncationNote = "\n\n_(message truncated, ask me to elaborate on specific parts)_";
					if (text.length > MAX_MAIN_LENGTH) {
						accumulatedText = text.substring(0, MAX_MAIN_LENGTH - truncationNote.length) + truncationNote;
					} else {
						accumulatedText = text;
					}

					const displayText = isWorking ? accumulatedText + workingIndicator : accumulatedText;

					if (displayText === lastDisplayText) {
						return;
					}

					if (messageTs) {
						await slack.updateMessage(event.channel, messageTs, displayText);
					} else {
						messageTs = await postMainOrThread(displayText);
					}
					lastDisplayText = displayText;
				} catch (err) {
					log.logWarning("Slack replaceMessage error", err instanceof Error ? err.message : String(err));
				}
			});
			await updatePromise;
		},

		respondInThread: async (text: string) => {
			updatePromise = updatePromise.then(async () => {
				try {
					if (messageTs) {
						// Truncate thread messages if too long (20K limit for safety)
						const MAX_THREAD_LENGTH = 20000;
						let threadText = text;
						if (threadText.length > MAX_THREAD_LENGTH) {
							threadText = `${threadText.substring(0, MAX_THREAD_LENGTH - 50)}\n\n_(truncated)_`;
						}

						const ts = await slack.postInThread(event.channel, messageTs, threadText);
						threadMessageTs.push(ts);
					}
				} catch (err) {
					log.logWarning("Slack respondInThread error", err instanceof Error ? err.message : String(err));
				}
			});
			await updatePromise;
		},

		setTyping: async (isTyping: boolean) => {
			if (isTyping && !messageTs) {
				updatePromise = updatePromise.then(async () => {
					try {
						if (!messageTs) {
							accumulatedText = eventFilename ? `_Starting event: ${eventFilename}_` : "_Thinking_";
							const displayText = accumulatedText + workingIndicator;
							messageTs = await postMainOrThread(displayText);
							lastDisplayText = displayText;
						}
					} catch (err) {
						log.logWarning("Slack setTyping error", err instanceof Error ? err.message : String(err));
					}
				});
				await updatePromise;
			}
		},

		uploadFile: async (filePath: string, title?: string) => {
			await slack.uploadFile(event.channel, filePath, title);
		},

		setWorking: async (working: boolean) => {
			updatePromise = updatePromise.then(async () => {
				try {
					isWorking = working;
					if (messageTs) {
						const displayText = isWorking ? accumulatedText + workingIndicator : accumulatedText;
						if (displayText !== lastDisplayText) {
							await slack.updateMessage(event.channel, messageTs, displayText);
							lastDisplayText = displayText;
						}
					}
				} catch (err) {
					log.logWarning("Slack setWorking error", err instanceof Error ? err.message : String(err));
				}
			});
			await updatePromise;
		},

		deleteMessage: async () => {
			updatePromise = updatePromise.then(async () => {
				// Delete thread messages first (in reverse order)
				for (let i = threadMessageTs.length - 1; i >= 0; i--) {
					try {
						await slack.deleteMessage(event.channel, threadMessageTs[i]);
					} catch {
						// Ignore errors deleting thread messages
					}
				}
				threadMessageTs.length = 0;
				// Then delete main message
				if (messageTs) {
					await slack.deleteMessage(event.channel, messageTs);
					messageTs = null;
					lastDisplayText = "";
				}
			});
			await updatePromise;
		},
	};
}

async function maybeTranscribeVoiceAttachments(event: SlackEvent, channelDir: string): Promise<void> {
	const files = event.files;
	if (!files?.length) return;

	const audioFiles = files.filter(isProbablyAudioFile);
	if (audioFiles.length === 0) return;

	log.logInfo(`[${event.channel}] Found ${audioFiles.length} audio file(s), transcribing...`);
	const transcriptions: string[] = [];

	for (const audioFile of audioFiles) {
		const tsMs = Math.floor(parseFloat(event.ts) * 1000);
		const sanitized = (audioFile.name || audioFile.title || "audio").replace(/[^a-zA-Z0-9._-]/g, "_");
		const filename = `${tsMs}_${sanitized}`;
		const audioPath = join(channelDir, "attachments", filename);

		let attempts = 0;
		while (!existsSync(audioPath) && attempts < 20) {
			await new Promise((r) => setTimeout(r, 500));
			attempts++;
		}

		if (existsSync(audioPath)) {
			const t = await transcribeAudio(audioPath, audioFile.name || audioFile.title || "audio");
			transcriptions.push(t);
		} else {
			transcriptions.push(`[Voice message: ${audioFile.name || "audio"}] (file not downloaded yet)`);
		}
	}

	const transcriptionText = transcriptions.join("\n\n");
	const newText = event.text ? `${event.text}\n\n${transcriptionText}` : transcriptionText;
	updateLoggedMessageText(channelDir, event.ts, newText);
	event.text = newText;
}

// ============================================================================
// Handler
// ============================================================================

const handler: MomHandler = {
	isRunning(conversationKey: string): boolean {
		const state = conversationStates.get(conversationKey);
		return state?.running ?? false;
	},

	countRunningConversationsInChannel(channelId: string): number {
		const prefix = `${channelId}:`;
		let n = 0;
		for (const [key, state] of conversationStates) {
			if (key.startsWith(prefix) && state.running) {
				n++;
			}
		}
		return n;
	},

	isTrackedThread(channelId: string, threadTs: string): boolean {
		return trackedThreads?.isTracked(channelId, threadTs) ?? false;
	},

	async handleStop(
		conversationKey: string,
		slack: SlackBot,
		replyTarget: { channel: string; threadTs?: string },
	): Promise<void> {
		const state = conversationStates.get(conversationKey);
		if (state?.running) {
			state.stopRequested = true;
			state.runner.abort();
			const ts = replyTarget.threadTs
				? await slack.postInThread(replyTarget.channel, replyTarget.threadTs, "_Stopping..._")
				: await slack.postMessage(replyTarget.channel, "_Stopping..._");
			state.stopMessageTs = ts;
		} else {
			if (replyTarget.threadTs) {
				await slack.postInThread(replyTarget.channel, replyTarget.threadTs, "_Nothing running_");
			} else {
				await slack.postMessage(replyTarget.channel, "_Nothing running_");
			}
		}
	},

	async handleEvent(event: SlackEvent, slack: SlackBot, isEvent?: boolean): Promise<void> {
		const sessionThreadRoot = getSessionThreadRoot(event);
		const conversationKey = getConversationKey(event.channel, sessionThreadRoot);
		const state = getConversationState(conversationKey, event.channel, sessionThreadRoot);
		const cfg = getMomConfig();
		const channelDir = join(workingDir, event.channel);

		// Start run
		state.running = true;
		state.stopRequested = false;

		log.logInfo(`[${event.channel}] Starting run: ${event.text.substring(0, 50)}`);

		let threadStatusTs: string | null = null;
		let stopped = false;

		try {
			if (!isEvent && cfg.voiceTranscription) {
				await maybeTranscribeVoiceAttachments(event, channelDir);
			}

			if (!isEvent && trackedThreads) {
				const root = event.threadTs ?? event.ts;
				trackedThreads.track(event.channel, root);
			}

			if (!isEvent && cfg.slackStatusReactions) {
				await slack.addReaction(event.channel, event.ts, "hourglass_flowing_sand");
			}

			if (!isEvent && cfg.slackStatusThreadMessage) {
				try {
					const parentTs = event.threadTs ?? event.ts;
					threadStatusTs = await slack.postInThread(event.channel, parentTs, "_On it! :hourglass_flowing_sand:_");
				} catch (err) {
					log.logWarning("Failed to post thread status", err instanceof Error ? err.message : String(err));
				}
			}

			// Create context adapter
			const ctx = createSlackContext(event, slack, state, sessionThreadRoot, isEvent);

			// Run the agent
			await ctx.setTyping(true);
			await ctx.setWorking(true);
			const result = await state.runner.run(ctx as any, state.store);
			await ctx.setWorking(false);

			if (result.stopReason === "aborted" && state.stopRequested) {
				stopped = true;
				if (state.stopMessageTs) {
					await slack.updateMessage(event.channel, state.stopMessageTs, "_Stopped_");
					state.stopMessageTs = undefined;
				} else {
					const parentTs = event.threadTs;
					if (parentTs) {
						await slack.postInThread(event.channel, parentTs, "_Stopped_");
					} else {
						await slack.postMessage(event.channel, "_Stopped_");
					}
				}
			}
		} catch (err) {
			log.logWarning(`[${event.channel}] Run error`, err instanceof Error ? err.message : String(err));
		} finally {
			if (!isEvent) {
				if (cfg.slackStatusReactions) {
					await slack.removeReaction(event.channel, event.ts, "hourglass_flowing_sand");
					await slack.addReaction(event.channel, event.ts, stopped ? "x" : "white_check_mark");
				}
				if (threadStatusTs && cfg.slackStatusThreadMessage) {
					try {
						await slack.updateMessage(
							event.channel,
							threadStatusTs,
							stopped ? "_Stopped :x:_" : "_Done :white_check_mark:_",
						);
					} catch (err) {
						log.logWarning("Failed to update thread status", err instanceof Error ? err.message : String(err));
					}
				}
			}
			state.running = false;
		}
	},
};

// ============================================================================
// Start
// ============================================================================

log.logStartup(workingDir, sandbox.type === "host" ? "host" : `docker:${sandbox.container}`);

// Shared store for attachment downloads (also used per-channel in getState)
const sharedStore = new ChannelStore({ workingDir, botToken: MOM_SLACK_BOT_TOKEN! });

const bot = new SlackBotClass(handler, {
	appToken: MOM_SLACK_APP_TOKEN,
	botToken: MOM_SLACK_BOT_TOKEN,
	workingDir,
	store: sharedStore,
});

// Start events watcher
const eventsWatcher = createEventsWatcher(workingDir, bot);
eventsWatcher.start();

// Handle shutdown
process.on("SIGINT", () => {
	log.logInfo("Shutting down...");
	eventsWatcher.stop();
	process.exit(0);
});

process.on("SIGTERM", () => {
	log.logInfo("Shutting down...");
	eventsWatcher.stop();
	process.exit(0);
});

bot.start();
