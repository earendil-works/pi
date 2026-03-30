#!/usr/bin/env node

import { join, resolve } from "path";
import { type AgentRunner, createRunner } from "./agent.js";
import { downloadChannel } from "./download.js";
import { createEventsWatcher } from "./events.js";
import { resolveMomTrustConfig, validateStrictTrustBoundary } from "./extensions.js";
import * as log from "./log.js";
import { parseSandboxArg, type SandboxConfig, validateSandbox } from "./sandbox.js";
import {
	type MomHandler,
	type SlackBot,
	SlackBot as SlackBotClass,
	type SlackContext,
	type SlackEvent,
} from "./slack.js";
import {
	MAX_MAIN_MESSAGE_LENGTH,
	MAX_THREAD_MESSAGE_LENGTH,
	publishSplitFinalSlackReply,
	THREAD_TRUNCATION_NOTE,
	TRUNCATION_NOTE,
	truncateSlackText,
} from "./slack-message-utils.js";
import { ChannelStore } from "./store.js";

const MOM_SLACK_APP_TOKEN = process.env.MOM_SLACK_APP_TOKEN;
const MOM_SLACK_BOT_TOKEN = process.env.MOM_SLACK_BOT_TOKEN;

interface ParsedArgs {
	workingDir?: string;
	sandbox: SandboxConfig;
	downloadChannel?: string;
}

interface ChannelState {
	running: boolean;
	runner?: AgentRunner;
	store: ChannelStore;
	stopRequested: boolean;
	stopMessageTs?: string;
	channelDir: string;
}

function parseArgs(): ParsedArgs {
	const args = process.argv.slice(2);
	let sandbox: SandboxConfig = { type: "host" };
	let workingDir: string | undefined;
	let downloadChannelId: string | undefined;

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg.startsWith("--sandbox=")) {
			sandbox = parseSandboxArg(arg.slice("--sandbox=".length));
		} else if (arg === "--sandbox") {
			sandbox = parseSandboxArg(args[++index] || "");
		} else if (arg.startsWith("--download=")) {
			downloadChannelId = arg.slice("--download=".length);
		} else if (arg === "--download") {
			downloadChannelId = args[++index];
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

if (parsedArgs.downloadChannel) {
	if (!MOM_SLACK_BOT_TOKEN) {
		console.error("Missing env: MOM_SLACK_BOT_TOKEN");
		process.exit(1);
	}
	await downloadChannel(parsedArgs.downloadChannel, MOM_SLACK_BOT_TOKEN);
	process.exit(0);
}

if (!parsedArgs.workingDir) {
	console.error("Usage: mom [--sandbox=host|docker:<name>] <working-directory>");
	console.error("       mom --download <channel-id>");
	process.exit(1);
}

const workingDir = parsedArgs.workingDir;
const sandbox = parsedArgs.sandbox;

if (!MOM_SLACK_APP_TOKEN || !MOM_SLACK_BOT_TOKEN) {
	console.error("Missing env: MOM_SLACK_APP_TOKEN, MOM_SLACK_BOT_TOKEN");
	process.exit(1);
}

process.chdir(workingDir);
await validateSandbox(sandbox);

const trustConfig = resolveMomTrustConfig(workingDir);
validateStrictTrustBoundary(workingDir, trustConfig);

log.logStartup(workingDir, sandbox.type === "host" ? "host" : `docker:${sandbox.container}`);
if (trustConfig.strict) {
	log.logInfo(`Strict trusted-extension mode enabled: ${trustConfig.trustedRoot}`);
}

const channelStates = new Map<string, ChannelState>();

function getState(channelId: string): ChannelState {
	let state = channelStates.get(channelId);
	if (!state) {
		state = {
			running: false,
			store: new ChannelStore({ workingDir, botToken: MOM_SLACK_BOT_TOKEN! }),
			stopRequested: false,
			channelDir: join(workingDir, channelId),
		};
		channelStates.set(channelId, state);
	}
	return state;
}

function ensureRunner(state: ChannelState, channelId: string): AgentRunner {
	if (!state.runner) {
		state.runner = createRunner({
			sandboxConfig: sandbox,
			channelId,
			channelDir: state.channelDir,
			workspaceDir: workingDir,
			trustConfig,
		});
	}
	return state.runner;
}

function createSlackContext(event: SlackEvent, slack: SlackBot, isEvent = false): SlackContext {
	let messageTs: string | null = null;
	const threadMessageTs: string[] = [];
	let accumulatedText = "";
	let isWorking = true;
	let finalMessageLogged = false;
	let updatePromise = Promise.resolve();

	const workingIndicator = " ...";
	const user = slack.getUser(event.user);
	const channelMentionThreadRootTs = !isEvent && event.type === "mention" ? (event.threadTs ?? event.ts) : undefined;
	const eventFilename = isEvent ? event.text.match(/^\[EVENT:([^:]+):/)?.[1] : undefined;

	const postPrimaryMessage = async (text: string): Promise<string> => {
		if (channelMentionThreadRootTs) {
			return slack.postInThread(event.channel, channelMentionThreadRootTs, text);
		}
		return slack.postMessage(event.channel, text);
	};

	const updatePrimaryMessage = async (text: string): Promise<void> => {
		if (messageTs) {
			await slack.updateMessage(event.channel, messageTs, text);
			return;
		}
		messageTs = await postPrimaryMessage(text);
	};

	const respond: SlackContext["respond"] = async (text, shouldLog = false) => {
		updatePromise = updatePromise.then(async () => {
			try {
				accumulatedText = accumulatedText ? `${accumulatedText}\n${text}` : text;
				const displayText = isWorking
					? truncateSlackText(accumulatedText, MAX_MAIN_MESSAGE_LENGTH, TRUNCATION_NOTE) + workingIndicator
					: truncateSlackText(accumulatedText, MAX_MAIN_MESSAGE_LENGTH, TRUNCATION_NOTE);
				await updatePrimaryMessage(displayText);
				if (shouldLog && messageTs) {
					slack.logBotResponse(event.channel, text, messageTs);
				}
			} catch (error) {
				log.logWarning("Slack respond error", error instanceof Error ? error.message : String(error));
			}
		});
		await updatePromise;
	};

	const publishFinal: SlackContext["publishFinal"] = async (text, shouldLog = false) => {
		updatePromise = updatePromise.then(async () => {
			try {
				const { mainText } = await publishSplitFinalSlackReply({
					text,
					updateMainMessage: async (nextText) => {
						accumulatedText = nextText;
						await updatePrimaryMessage(accumulatedText);
					},
					postInThread: async (overflowPart) => {
						const ts = await slack.postInThread(
							event.channel,
							channelMentionThreadRootTs ?? messageTs!,
							overflowPart,
						);
						threadMessageTs.push(ts);
					},
				});
				if (shouldLog && !finalMessageLogged && messageTs) {
					slack.logBotResponse(event.channel, mainText, messageTs);
					finalMessageLogged = true;
				}
			} catch (error) {
				log.logWarning("Slack publishFinal error", error instanceof Error ? error.message : String(error));
			}
		});
		await updatePromise;
	};

	const respondInThread: SlackContext["respondInThread"] = async (text) => {
		updatePromise = updatePromise.then(async () => {
			try {
				const threadRootTs = channelMentionThreadRootTs ?? messageTs;
				if (!threadRootTs) {
					return;
				}

				const threadText = truncateSlackText(text, MAX_THREAD_MESSAGE_LENGTH, THREAD_TRUNCATION_NOTE);
				const ts = await slack.postInThread(event.channel, threadRootTs, threadText);
				threadMessageTs.push(ts);
			} catch (error) {
				log.logWarning("Slack respondInThread error", error instanceof Error ? error.message : String(error));
			}
		});
		await updatePromise;
	};

	return {
		message: {
			text: event.text,
			rawText: event.text,
			user: event.user,
			userName: user?.userName,
			channel: event.channel,
			ts: event.ts,
			threadTs: channelMentionThreadRootTs ?? event.threadTs,
			attachments: (event.attachments || []).map((attachment) => ({ local: attachment.local })),
		},
		channelName: slack.getChannel(event.channel)?.name,
		isEvent,
		channels: slack.getAllChannels().map((channel) => ({ id: channel.id, name: channel.name })),
		users: slack.getAllUsers().map((slackUser) => ({
			id: slackUser.id,
			userName: slackUser.userName,
			displayName: slackUser.displayName,
		})),
		respond,
		publishFinal,
		replaceMessage: async (text) => publishFinal(text, false),
		respondInThread,
		setTyping: async (isTyping) => {
			if (!isTyping || messageTs) {
				return;
			}

			updatePromise = updatePromise.then(async () => {
				try {
					if (!messageTs) {
						accumulatedText = eventFilename ? `_Starting event: ${eventFilename}_` : "_Thinking_";
						messageTs = await postPrimaryMessage(`${accumulatedText}${workingIndicator}`);
					}
				} catch (error) {
					log.logWarning("Slack setTyping error", error instanceof Error ? error.message : String(error));
				}
			});
			await updatePromise;
		},
		uploadFile: async (filePath, title) => {
			await slack.uploadFile(event.channel, filePath, title);
		},
		setWorking: async (working) => {
			updatePromise = updatePromise.then(async () => {
				try {
					isWorking = working;
					if (messageTs) {
						const displayText = isWorking ? `${accumulatedText}${workingIndicator}` : accumulatedText;
						await slack.updateMessage(event.channel, messageTs, displayText);
					}
				} catch (error) {
					log.logWarning("Slack setWorking error", error instanceof Error ? error.message : String(error));
				}
			});
			await updatePromise;
		},
		deleteMessage: async () => {
			updatePromise = updatePromise.then(async () => {
				for (let index = threadMessageTs.length - 1; index >= 0; index--) {
					try {
						await slack.deleteMessage(event.channel, threadMessageTs[index]);
					} catch {
						// Ignore thread deletion failures
					}
				}
				threadMessageTs.length = 0;
				if (messageTs) {
					await slack.deleteMessage(event.channel, messageTs);
					messageTs = null;
				}
			});
			await updatePromise;
		},
	};
}

const handler: MomHandler = {
	isRunning(channelId: string): boolean {
		const state = channelStates.get(channelId);
		return state?.running ?? false;
	},

	async handleStop(channelId: string, slack: SlackBot): Promise<void> {
		const state = channelStates.get(channelId);
		if (state?.running && state.runner) {
			state.stopRequested = true;
			state.runner.abort();
			state.stopMessageTs = await slack.postMessage(channelId, "_Stopping..._");
			return;
		}

		await slack.postMessage(channelId, "_Nothing running_");
	},

	async handleEvent(event: SlackEvent, slack: SlackBot, isEvent = false): Promise<void> {
		const state = getState(event.channel);
		const runner = ensureRunner(state, event.channel);
		state.running = true;
		state.stopRequested = false;

		log.logInfo(`[${event.channel}] Starting run: ${event.text.substring(0, 50)}`);

		try {
			const ctx = createSlackContext(event, slack, isEvent);
			const result = await runner.run(ctx, state.store);
			await ctx.setWorking(false);

			if (result.fatalInitializationError) {
				state.runner = undefined;
			}

			if (result.stopReason === "aborted" && state.stopRequested) {
				if (state.stopMessageTs) {
					await slack.updateMessage(event.channel, state.stopMessageTs, "_Stopped_");
					state.stopMessageTs = undefined;
				} else {
					await slack.postMessage(event.channel, "_Stopped_");
				}
			}
		} catch (error) {
			log.logWarning(`[${event.channel}] Run error`, error instanceof Error ? error.message : String(error));
		} finally {
			state.running = false;
		}
	},
};

const sharedStore = new ChannelStore({ workingDir, botToken: MOM_SLACK_BOT_TOKEN! });
const bot = new SlackBotClass(handler, {
	appToken: MOM_SLACK_APP_TOKEN,
	botToken: MOM_SLACK_BOT_TOKEN,
	workingDir,
	store: sharedStore,
});

const eventsWatcher = createEventsWatcher(workingDir, bot);
eventsWatcher.start();

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

await bot.start();
