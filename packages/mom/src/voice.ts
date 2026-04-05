import { createReadStream, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import * as log from "./log.js";

const MOM_GROQ_API_KEY = process.env.MOM_GROQ_API_KEY;
const MOM_OPENAI_API_KEY = process.env.MOM_OPENAI_API_KEY;

export async function transcribeAudio(filePath: string, originalName: string): Promise<string> {
	if (!MOM_GROQ_API_KEY && !MOM_OPENAI_API_KEY) {
		log.logWarning("Voice transcription skipped - no API key", "Set MOM_GROQ_API_KEY or MOM_OPENAI_API_KEY");
		return `[Voice message: ${originalName}] (transcription unavailable - no API key)`;
	}
	try {
		const { default: OpenAI } = await import("openai");
		const openai = new OpenAI({
			apiKey: MOM_GROQ_API_KEY || MOM_OPENAI_API_KEY,
			baseURL: MOM_GROQ_API_KEY ? "https://api.groq.com/openai/v1" : undefined,
		});
		const audioStream = createReadStream(filePath);
		const transcription = await openai.audio.transcriptions.create({
			file: audioStream,
			model: MOM_GROQ_API_KEY ? "whisper-large-v3" : "whisper-1",
			response_format: "text",
		});
		const text = typeof transcription === "string" ? transcription : String(transcription);
		log.logInfo(`Transcribed voice message: ${originalName} (${text.length} chars)`);
		return `[Voice message]: ${text.trim()}`;
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		log.logWarning("Voice transcription failed", `${originalName}: ${errorMsg}`);
		return `[Voice message: ${originalName}] (transcription failed: ${errorMsg})`;
	}
}

export function updateLoggedMessageText(channelDir: string, messageTs: string, newText: string): void {
	const logPath = join(channelDir, "log.jsonl");
	if (!existsSync(logPath)) return;
	try {
		const content = readFileSync(logPath, "utf-8");
		const lines = content.trim().split("\n");
		let updated = false;
		const updatedLines = lines.map((line) => {
			if (!line) return line;
			const message = JSON.parse(line) as { ts?: string; text?: string };
			if (message.ts === messageTs) {
				message.text = newText;
				updated = true;
				return JSON.stringify(message);
			}
			return line;
		});
		if (updated) {
			writeFileSync(logPath, `${updatedLines.join("\n")}\n`);
			log.logInfo(`Updated logged message ${messageTs} with transcription`);
		}
	} catch (err) {
		log.logWarning("Failed to update logged message", String(err));
	}
}

export function isProbablyAudioFile(file: { name?: string; mimetype?: string }): boolean {
	const mime = file.mimetype?.toLowerCase() || "";
	if (mime.startsWith("audio/")) return true;
	const n = (file.name || "").toLowerCase();
	return /\.(mp3|wav|m4a|mp4|webm|ogg|flac)$/i.test(n);
}
