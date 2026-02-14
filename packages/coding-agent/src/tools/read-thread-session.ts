import { readFileSync } from "node:fs";
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
			if (entry.type !== "message") continue;
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
