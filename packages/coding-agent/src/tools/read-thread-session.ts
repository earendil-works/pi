import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import type { Message } from "@kennyfrc/mu-ai";

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function loadThreadMessagesFromSessionFile(sessionPath: string): { messages: Message[]; totalMessages: number } {
	const raw = readFileSync(sessionPath, "utf8");
	const lines = raw.trim().length === 0 ? [] : raw.trim().split("\n");

	const messages: Message[] = [];

	for (const line of lines) {
		try {
			const entry: unknown = JSON.parse(line);
			if (!isObject(entry)) continue;
			if (entry.type !== "message" && entry.type !== "custom_message") continue;
			if (!("message" in entry)) continue;

			// Session JSONL is produced by our runtime, so we accept it as Message with a minimal structural check.
			const rawMessage = (entry as { message: unknown }).message;
			if (!isObject(rawMessage)) continue;
			if (!("role" in rawMessage)) continue;

			// This JSONL is produced by our own runtime, but when loading from disk we only
			// do lightweight validation. Tell TS we're intentionally narrowing.
			messages.push(rawMessage as unknown as Message);
		} catch {
			// ignore malformed lines
		}
	}

	return { messages, totalMessages: messages.length };
}

function readTailUtf8(
	filePath: string,
	bytes: number,
): {
	text: string;
	startsAtZero: boolean;
	startedOnLineBoundary: boolean;
} {
	let size: number;
	try {
		size = statSync(filePath).size;
	} catch {
		return { text: "", startsAtZero: true, startedOnLineBoundary: true };
	}

	const start = Math.max(0, size - bytes);
	const length = size - start;
	if (length <= 0) {
		return { text: "", startsAtZero: start === 0, startedOnLineBoundary: start === 0 };
	}

	const readStart = start > 0 ? start - 1 : start;
	const readLen = size - readStart;
	if (readLen <= 0) {
		return { text: "", startsAtZero: start === 0, startedOnLineBoundary: start === 0 };
	}

	const fd = openSync(filePath, "r");
	try {
		const buffer = Buffer.allocUnsafe(readLen);
		const bytesRead = readSync(fd, buffer, 0, readLen, readStart);
		let text = buffer.subarray(0, bytesRead).toString("utf8");

		let startedOnLineBoundary = start === 0;
		if (start > 0) {
			startedOnLineBoundary = text.startsWith("\n");
			if (startedOnLineBoundary) {
				text = text.slice(1);
			}
		}

		return { text, startsAtZero: start === 0, startedOnLineBoundary };
	} finally {
		closeSync(fd);
	}
}

export function loadThreadMessagesTailFromSessionFile(
	sessionPath: string,
	maxMessages: number,
): {
	messages: Message[];
	totalMessages: number | null;
} {
	// Try to bound work for huge session files by reading from the end and growing the
	// window until we have enough parsed messages (or we hit the file start).
	//
	// NOTE: We only return exact totalMessages when we read the full file.
	const MIN_BYTES = 256 * 1024;
	const MAX_BYTES = 8 * 1024 * 1024;

	let bytes = MIN_BYTES;
	let parsed: Message[] = [];
	let totalMessages: number | null = null;

	for (;;) {
		const { text, startsAtZero, startedOnLineBoundary } = readTailUtf8(sessionPath, bytes);
		const rawLines = text.length === 0 ? [] : text.split("\n");
		if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") {
			rawLines.pop();
		}

		// If we started mid-line, drop the partial first line; otherwise keep it.
		const lines = startsAtZero || startedOnLineBoundary ? rawLines : rawLines.slice(1);

		const messages: Message[] = [];

		for (const line of lines) {
			try {
				const entry: unknown = JSON.parse(line);
				if (!isObject(entry)) continue;
				if (entry.type !== "message" && entry.type !== "custom_message") continue;
				if (!("message" in entry)) continue;

				const rawMessage = (entry as { message: unknown }).message;
				if (!isObject(rawMessage)) continue;
				if (!("role" in rawMessage)) continue;

				messages.push(rawMessage as unknown as Message);
			} catch {
				// ignore malformed lines
			}
		}

		parsed = messages;
		if (startsAtZero) {
			totalMessages = parsed.length;
		}

		if (parsed.length >= maxMessages || startsAtZero) {
			break;
		}

		if (bytes >= MAX_BYTES) {
			break;
		}

		bytes = Math.min(MAX_BYTES, bytes * 2);
	}

	const sliced = parsed.slice(Math.max(0, parsed.length - maxMessages));
	return { messages: sliced, totalMessages };
}
