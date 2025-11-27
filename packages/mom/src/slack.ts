import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { readFileSync } from "fs";
import { basename } from "path";
import * as log from "./log.js";
import { type Attachment, ChannelStore } from "./store.js";

export interface SlackMessage {
	text: string; // message content (mentions stripped)
	rawText: string; // original text with mentions
	user: string; // user ID
	userName?: string; // user handle
	channel: string; // channel ID
	ts: string; // timestamp (for threading)
	attachments: Attachment[]; // file attachments
}

export interface SlackContext {
	message: SlackMessage;
	channelName?: string; // channel name for logging (e.g., #dev-team)
	store: ChannelStore;
	/** Send/update the main message (accumulates text) */
	respond(text: string): Promise<void>;
	/** Replace the entire message text (not append) */
	replaceMessage(text: string): Promise<void>;
	/** Post a message in the thread under the main message (for verbose details) */
	respondInThread(text: string): Promise<void>;
	/** Show/hide typing indicator */
	setTyping(isTyping: boolean): Promise<void>;
	/** Upload a file to the channel */
	uploadFile(filePath: string, title?: string): Promise<void>;
	/** Set working state (adds/removes working indicator emoji) */
	setWorking(working: boolean): Promise<void>;
}

export interface MomHandler {
	onChannelMention(ctx: SlackContext): Promise<void>;
	onDirectMessage(ctx: SlackContext): Promise<void>;
}

export interface MomBotConfig {
	appToken: string;
	botToken: string;
	workingDir: string; // directory for channel data and attachments
}

export class MomBot {
	private socketClient: SocketModeClient;
	private webClient: WebClient;
	private handler: MomHandler;
	private botUserId: string | null = null;
	public readonly store: ChannelStore;
	private userCache: Map<string, { userName: string; displayName: string }> = new Map();

	constructor(handler: MomHandler, config: MomBotConfig) {
		this.handler = handler;
		this.socketClient = new SocketModeClient({ appToken: config.appToken });
		this.webClient = new WebClient(config.botToken);
		this.store = new ChannelStore({
			workingDir: config.workingDir,
			botToken: config.botToken,
		});

		this.setupEventHandlers();
	}

	private async getUserInfo(userId: string): Promise<{ userName: string; displayName: string }> {
		if (this.userCache.has(userId)) {
			return this.userCache.get(userId)!;
		}

		try {
			const result = await this.webClient.users.info({ user: userId });
			const user = result.user as { name?: string; real_name?: string };
			const info = {
				userName: user?.name || userId,
				displayName: user?.real_name || user?.name || userId,
			};
			this.userCache.set(userId, info);
			return info;
		} catch {
			return { userName: userId, displayName: userId };
		}
	}

	private setupEventHandlers(): void {
		// Handle @mentions in channels
		this.socketClient.on("app_mention", async ({ event, ack }) => {
			await ack();

			const slackEvent = event as {
				text: string;
				channel: string;
				user: string;
				ts: string;
				files?: Array<{ name: string; url_private_download?: string; url_private?: string }>;
			};

			// Log the mention (message event may not fire for app_mention)
			await this.logMessage(slackEvent);

			const ctx = await this.createContext(slackEvent);
			await this.handler.onChannelMention(ctx);
		});

		// Handle all messages (for logging) and DMs (for triggering handler)
		this.socketClient.on("message", async ({ event, ack }) => {
			await ack();

			const slackEvent = event as {
				text?: string;
				channel: string;
				user?: string;
				ts: string;
				channel_type?: string;
				subtype?: string;
				bot_id?: string;
				files?: Array<{ name: string; url_private_download?: string; url_private?: string }>;
			};

			// Ignore bot messages
			if (slackEvent.bot_id) return;
			// Ignore message edits, etc. (but allow file_share)
			if (slackEvent.subtype !== undefined && slackEvent.subtype !== "file_share") return;
			// Ignore if no user
			if (!slackEvent.user) return;
			// Ignore messages from the bot itself
			if (slackEvent.user === this.botUserId) return;
			// Ignore if no text AND no files
			if (!slackEvent.text && (!slackEvent.files || slackEvent.files.length === 0)) return;

			// Log ALL messages (channel and DM)
			await this.logMessage({
				text: slackEvent.text || "",
				channel: slackEvent.channel,
				user: slackEvent.user,
				ts: slackEvent.ts,
				files: slackEvent.files,
			});

			// Only trigger handler for DMs (channel mentions are handled by app_mention event)
			if (slackEvent.channel_type === "im") {
				const ctx = await this.createContext({
					text: slackEvent.text || "",
					channel: slackEvent.channel,
					user: slackEvent.user,
					ts: slackEvent.ts,
					files: slackEvent.files,
				});
				await this.handler.onDirectMessage(ctx);
			}
		});
	}

	private async logMessage(event: {
		text: string;
		channel: string;
		user: string;
		ts: string;
		files?: Array<{ name: string; url_private_download?: string; url_private?: string }>;
	}): Promise<void> {
		const attachments = event.files ? this.store.processAttachments(event.channel, event.files, event.ts) : [];
		const { userName, displayName } = await this.getUserInfo(event.user);

		await this.store.logMessage(event.channel, {
			date: new Date(parseFloat(event.ts) * 1000).toISOString(),
			ts: event.ts,
			user: event.user,
			userName,
			displayName,
			text: event.text,
			attachments,
			isBot: false,
		});
	}

	private async createContext(event: {
		text: string;
		channel: string;
		user: string;
		ts: string;
		files?: Array<{ name: string; url_private_download?: string; url_private?: string }>;
	}): Promise<SlackContext> {
		const rawText = event.text;
		const text = rawText.replace(/<@[A-Z0-9]+>/gi, "").trim();

		// Get user info for logging
		const { userName } = await this.getUserInfo(event.user);

		// Get channel name for logging (best effort)
		let channelName: string | undefined;
		try {
			if (event.channel.startsWith("C")) {
				const result = await this.webClient.conversations.info({ channel: event.channel });
				channelName = result.channel?.name ? `#${result.channel.name}` : undefined;
			}
		} catch {
			// Ignore errors - we'll just use the channel ID
		}

		// Process attachments (for context, already logged by message handler)
		const attachments = event.files ? this.store.processAttachments(event.channel, event.files, event.ts) : [];

		// Track the single message for this run
		let messageTs: string | null = null;
		let accumulatedText = "";
		let isThinking = true; // Track if we're still in "thinking" state
		let isWorking = true; // Track if still processing
		const workingIndicator = " ...";
		let updatePromise: Promise<void> = Promise.resolve();

		return {
			message: {
				text,
				rawText,
				user: event.user,
				userName,
				channel: event.channel,
				ts: event.ts,
				attachments,
			},
			channelName,
			store: this.store,
			respond: async (responseText: string) => {
				// Queue updates to avoid race conditions
				updatePromise = updatePromise.then(async () => {
					if (isThinking) {
						// First real response replaces "Thinking..."
						accumulatedText = responseText;
						isThinking = false;
					} else {
						// Subsequent responses get appended
						accumulatedText += "\n" + responseText;
					}

					// Add working indicator if still working
					const displayText = isWorking ? accumulatedText + workingIndicator : accumulatedText;

					if (messageTs) {
						// Update existing message
						await this.webClient.chat.update({
							channel: event.channel,
							ts: messageTs,
							text: displayText,
						});
					} else {
						// Post initial message
						const result = await this.webClient.chat.postMessage({
							channel: event.channel,
							text: displayText,
						});
						messageTs = result.ts as string;
					}

					// Log the response
					await this.store.logBotResponse(event.channel, responseText, messageTs!);
				});

				await updatePromise;
			},
			respondInThread: async (threadText: string) => {
				// Queue thread posts to maintain order
				updatePromise = updatePromise.then(async () => {
					if (!messageTs) {
						// No main message yet, just skip
						return;
					}
					// Post in thread under the main message
					await this.webClient.chat.postMessage({
						channel: event.channel,
						thread_ts: messageTs,
						text: threadText,
					});
				});
				await updatePromise;
			},
			setTyping: async (isTyping: boolean) => {
				if (isTyping && !messageTs) {
					// Post initial "thinking" message (... auto-appended by working indicator)
					accumulatedText = "_Thinking_";
					const result = await this.webClient.chat.postMessage({
						channel: event.channel,
						text: accumulatedText,
					});
					messageTs = result.ts as string;
				}
				// We don't delete/clear anymore - message persists and gets updated
			},
			uploadFile: async (filePath: string, title?: string) => {
				const fileName = title || basename(filePath);
				const fileContent = readFileSync(filePath);

				await this.webClient.files.uploadV2({
					channel_id: event.channel,
					file: fileContent,
					filename: fileName,
					title: fileName,
				});
			},
			replaceMessage: async (text: string) => {
				updatePromise = updatePromise.then(async () => {
					// Replace the accumulated text entirely
					accumulatedText = text;

					const displayText = isWorking ? accumulatedText + workingIndicator : accumulatedText;

					if (messageTs) {
						await this.webClient.chat.update({
							channel: event.channel,
							ts: messageTs,
							text: displayText,
						});
					} else {
						// Post initial message
						const result = await this.webClient.chat.postMessage({
							channel: event.channel,
							text: displayText,
						});
						messageTs = result.ts as string;
					}
				});
				await updatePromise;
			},
			setWorking: async (working: boolean) => {
				updatePromise = updatePromise.then(async () => {
					isWorking = working;

					// If we have a message, update it to add/remove indicator
					if (messageTs) {
						const displayText = isWorking ? accumulatedText + workingIndicator : accumulatedText;
						await this.webClient.chat.update({
							channel: event.channel,
							ts: messageTs,
							text: displayText,
						});
					}
				});
				await updatePromise;
			},
		};
	}

	async start(): Promise<void> {
		const auth = await this.webClient.auth.test();
		this.botUserId = auth.user_id as string;
		await this.socketClient.start();
		log.logConnected();
	}

	async stop(): Promise<void> {
		await this.socketClient.disconnect();
		log.logDisconnected();
	}
}
