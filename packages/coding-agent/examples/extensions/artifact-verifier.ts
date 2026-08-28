import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "../../src/core/extensions/index.ts";

const CONFIG_FILE = ".pi-artifact-verifier.json";
const PENDING_TOKEN = "ARTIFACT_VERIFICATION_PENDING";
const FAILED_TOKEN = "ARTIFACT_VERIFICATION_FAILED";

interface ArtifactVerifierConfig {
	args: string[];
	command: string;
	maxRepairs: number;
	successToken: string;
	timeoutMs: number;
	version: 1;
}

interface VerificationReport {
	issues: unknown[];
	ok: boolean;
	summary: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseConfig(value: unknown): ArtifactVerifierConfig {
	if (
		!isRecord(value) ||
		value.version !== 1 ||
		typeof value.command !== "string" ||
		value.command.length === 0 ||
		!Array.isArray(value.args) ||
		!value.args.every((arg) => typeof arg === "string") ||
		typeof value.timeoutMs !== "number" ||
		!Number.isInteger(value.timeoutMs) ||
		value.timeoutMs <= 0 ||
		typeof value.maxRepairs !== "number" ||
		!Number.isInteger(value.maxRepairs) ||
		value.maxRepairs < 0 ||
		typeof value.successToken !== "string" ||
		value.successToken.length === 0
	) {
		throw new Error(`Invalid ${CONFIG_FILE}`);
	}
	return {
		args: value.args,
		command: value.command,
		maxRepairs: value.maxRepairs,
		successToken: value.successToken,
		timeoutMs: value.timeoutMs,
		version: 1,
	};
}

function parseReport(stdout: string): VerificationReport {
	let value: unknown;
	try {
		value = JSON.parse(stdout);
	} catch {
		value = undefined;
	}
	if (
		!isRecord(value) ||
		typeof value.ok !== "boolean" ||
		typeof value.summary !== "string" ||
		!Array.isArray(value.issues)
	) {
		return {
			issues: [{ code: "verifier_protocol_error", message: "Verifier returned invalid JSON" }],
			ok: false,
			summary: "Artifact verifier protocol failed",
		};
	}
	return { issues: value.issues, ok: value.ok, summary: value.summary };
}

function replaceToken(message: AgentMessage, token: string, replacement: string): AgentMessage | undefined {
	if (message.role !== "assistant") {
		return;
	}
	let changed = false;
	const content = message.content.map((part) => {
		if (part.type !== "text" || !part.text.includes(token)) {
			return part;
		}
		changed = true;
		return { ...part, text: part.text.replaceAll(token, replacement) };
	});
	return changed ? { ...message, content } : undefined;
}

export default function artifactVerifier(pi: ExtensionAPI): void {
	let config: ArtifactVerifierConfig | undefined;
	let configCwd: string | undefined;
	let exhausted = false;
	let repairs = 0;
	let running = false;
	let verified = false;

	async function loadConfig(ctx: ExtensionContext): Promise<ArtifactVerifierConfig | undefined> {
		if (!ctx.isProjectTrusted()) {
			return;
		}
		if (configCwd === ctx.cwd) {
			return config;
		}
		configCwd = ctx.cwd;
		exhausted = false;
		repairs = 0;
		verified = false;
		try {
			config = parseConfig(JSON.parse(await readFile(join(ctx.cwd, CONFIG_FILE), "utf8")));
		} catch (error) {
			if (isRecord(error) && error.code === "ENOENT") {
				config = undefined;
				return;
			}
			throw error;
		}
		return config;
	}

	pi.on("message_end", async (event, ctx) => {
		const active = await loadConfig(ctx);
		if (active === undefined || verified) {
			return;
		}
		const message = replaceToken(event.message, active.successToken, exhausted ? FAILED_TOKEN : PENDING_TOKEN);
		return message === undefined ? undefined : { message };
	});

	pi.on("agent_end", async (_event, ctx) => {
		const active = await loadConfig(ctx);
		if (active === undefined || exhausted || running || verified) {
			return;
		}
		running = true;
		try {
			const execution = await pi.exec(active.command, active.args, {
				cwd: ctx.cwd,
				timeout: active.timeoutMs,
			});
			const report = parseReport(execution.stdout);
			if (execution.code === 0 && report.ok) {
				verified = true;
				pi.sendUserMessage(`Artifact verification passed. Reply with exactly ${active.successToken}`, {
					deliverAs: "followUp",
				});
				return;
			}
			if (repairs < active.maxRepairs) {
				repairs += 1;
				pi.sendUserMessage(
					[
						`Artifact verification failed. Repair attempt ${repairs} of ${active.maxRepairs}.`,
						"Repair the artifact from this machine-readable report, then re-run your normal read check.",
						JSON.stringify(report),
						`Do not emit ${active.successToken} until verification passes.`,
					].join("\n"),
					{ deliverAs: "followUp" },
				);
				return;
			}
			exhausted = true;
			pi.sendUserMessage(
				`${FAILED_TOKEN}: repair budget exhausted. Report the verifier failure without claiming success.\n${JSON.stringify(report)}`,
				{ deliverAs: "followUp" },
			);
		} finally {
			running = false;
		}
	});
}
