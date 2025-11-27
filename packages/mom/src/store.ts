import { existsSync, mkdirSync } from "fs";
import { appendFile, writeFile } from "fs/promises";
import { join } from "path";
import * as log from "./log.js";

export interface Attachment {
	original: string; // original filename from uploader
	local: string; // path relative to working dir (e.g., "C12345/attachments/1732531234567_file.png")
}

export interface LoggedMessage {
	date: string; // ISO 8601 date (e.g., "2025-11-26T10:44:00.000Z") for easy grepping
	ts: string; // slack timestamp or epoch ms
	user: string; // user ID (or "bot" for bot responses)
	userName?: string; // handle (e.g., "mario")
	displayName?: string; // display name (e.g., "Mario Zechner")
	text: string;
	attachments: Attachment[];
	isBot: boolean;
}

export interface ChannelStoreConfig {
	workingDir: string;
	botToken: string; // needed for authenticated file downloads
}

interface PendingDownload {
	channelId: string;
	localPath: string; // relative path
	url: string;
}

export class ChannelStore {
	private workingDir: string;
	private botToken: string;
	private pendingDownloads: PendingDownload[] = [];
	private isDownloading = false;

	constructor(config: ChannelStoreConfig) {
		this.workingDir = config.workingDir;
		this.botToken = config.botToken;

		// Ensure working directory exists
		if (!existsSync(this.workingDir)) {
			mkdirSync(this.workingDir, { recursive: true });
		}
	}

	/**
	 * Get or create the directory for a channel/DM
	 */
	getChannelDir(channelId: string): string {
		const dir = join(this.workingDir, channelId);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		return dir;
	}

	/**
	 * Generate a unique local filename for an attachment
	 */
	generateLocalFilename(originalName: string, timestamp: string): string {
		// Convert slack timestamp (1234567890.123456) to milliseconds
		const ts = Math.floor(parseFloat(timestamp) * 1000);
		// Sanitize original name (remove problematic characters)
		const sanitized = originalName.replace(/[^a-zA-Z0-9._-]/g, "_");
		return `${ts}_${sanitized}`;
	}

	/**
	 * Process attachments from a Slack message event
	 * Returns attachment metadata and queues downloads
	 */
	processAttachments(
		channelId: string,
		files: Array<{ name: string; url_private_download?: string; url_private?: string }>,
		timestamp: string,
	): Attachment[] {
		const attachments: Attachment[] = [];

		for (const file of files) {
			const url = file.url_private_download || file.url_private;
			if (!url) continue;

			const filename = this.generateLocalFilename(file.name, timestamp);
			const localPath = `${channelId}/attachments/${filename}`;

			attachments.push({
				original: file.name,
				local: localPath,
			});

			// Queue for background download
			this.pendingDownloads.push({ channelId, localPath, url });
		}

		// Trigger background download
		this.processDownloadQueue();

		return attachments;
	}

	/**
	 * Log a message to the channel's log.jsonl
	 */
	async logMessage(channelId: string, message: LoggedMessage): Promise<void> {
		const logPath = join(this.getChannelDir(channelId), "log.jsonl");

		// Ensure message has a date field
		if (!message.date) {
			// Parse timestamp to get date
			let date: Date;
			if (message.ts.includes(".")) {
				// Slack timestamp format (1234567890.123456)
				date = new Date(parseFloat(message.ts) * 1000);
			} else {
				// Epoch milliseconds
				date = new Date(parseInt(message.ts, 10));
			}
			message.date = date.toISOString();
		}

		const line = JSON.stringify(message) + "\n";
		await appendFile(logPath, line, "utf-8");
	}

	/**
	 * Log a bot response
	 */
	async logBotResponse(channelId: string, text: string, ts: string): Promise<void> {
		await this.logMessage(channelId, {
			date: new Date().toISOString(),
			ts,
			user: "bot",
			text,
			attachments: [],
			isBot: true,
		});
	}

	/**
	 * Process the download queue in the background
	 */
	private async processDownloadQueue(): Promise<void> {
		if (this.isDownloading || this.pendingDownloads.length === 0) return;

		this.isDownloading = true;

		while (this.pendingDownloads.length > 0) {
			const item = this.pendingDownloads.shift();
			if (!item) break;

			try {
				await this.downloadAttachment(item.localPath, item.url);
				// Success - could add success logging here if we have context
			} catch (error) {
				const errorMsg = error instanceof Error ? error.message : String(error);
				log.logWarning(`Failed to download attachment`, `${item.localPath}: ${errorMsg}`);
			}
		}

		this.isDownloading = false;
	}

	/**
	 * Download a single attachment
	 */
	private async downloadAttachment(localPath: string, url: string): Promise<void> {
		const filePath = join(this.workingDir, localPath);

		// Ensure directory exists
		const dir = join(this.workingDir, localPath.substring(0, localPath.lastIndexOf("/")));
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		const response = await fetch(url, {
			headers: {
				Authorization: `Bearer ${this.botToken}`,
			},
		});

		if (!response.ok) {
			throw new Error(`HTTP ${response.status}: ${response.statusText}`);
		}

		const buffer = await response.arrayBuffer();
		await writeFile(filePath, Buffer.from(buffer));
	}
}
