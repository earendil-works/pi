import { spawn, spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_RADIUS_GATEWAY } from "@earendil-works/pi-ai/providers/radius-config";
import { type Container, type EditorComponent, hyperlink, type TUI } from "@earendil-works/pi-tui";
import { getAuthCredential } from "../../cli/auth-command.ts";
import { getShareViewerUrl } from "../../config.ts";
import type { AgentSession } from "../../core/agent-session.ts";
import { exportSessionToJsonl } from "../../core/session-export.ts";
import { BorderedLoader } from "./components/bordered-loader.ts";
import { theme } from "./theme/theme.ts";

interface SessionShareContext {
	session: AgentSession;
	ui: TUI;
	editorContainer: Container;
	editor: EditorComponent;
	showStatus: (message: string) => void;
	showError: (message: string) => void;
}

/** Export the current branch with presentation metadata for Radius. */
export function exportSessionForShare(filePath: string, session: AgentSession): void {
	exportSessionToJsonl(session.sessionManager, filePath, (parentId, timestamp) => [
		{
			type: "custom",
			customType: "pi.share",
			id: crypto.randomUUID().slice(0, 8),
			parentId,
			timestamp,
			data: {
				systemPrompt: session.state.systemPrompt,
				tools: session.state.tools.map((tool) => ({
					name: tool.name,
					description: tool.description,
					parameters: tool.parameters,
				})),
			},
		},
	]);
}

/** Share the current session through Radius, falling back to a private gist. */
export async function shareSession(context: SessionShareContext): Promise<void> {
	const jsonlFile = path.join(os.tmpdir(), "session.jsonl");
	let htmlFile: string | null = null;

	try {
		try {
			exportSessionForShare(jsonlFile, context.session);
		} catch (error: unknown) {
			context.showError(`Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`);
			return;
		}
		if (await tryShareViaRadius(jsonlFile, context)) return;

		try {
			const authResult = spawnSync("gh", ["auth", "status"], { encoding: "utf-8" });
			if (authResult.status !== 0) {
				context.showError("GitHub CLI is not logged in. Run 'gh auth login' first.");
				return;
			}
		} catch {
			context.showError("GitHub CLI (gh) is not installed. Install it from https://cli.github.com/");
			return;
		}

		try {
			htmlFile = path.join(os.tmpdir(), "session.html");
			await context.session.exportToHtml(htmlFile, { themeName: theme.name });
		} catch (error: unknown) {
			context.showError(`Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`);
			return;
		}
		await shareViaGist(htmlFile, context);
	} finally {
		for (const tmpFile of [jsonlFile, htmlFile]) {
			try {
				if (tmpFile !== null) {
					fs.unlinkSync(tmpFile);
				}
			} catch {
				// Ignore cleanup errors
			}
		}
	}
}

async function tryShareViaRadius(tmpFile: string, context: SessionShareContext): Promise<boolean> {
	const provider = context.session.modelRuntime.getProvider("radius");
	if (!provider) return false;

	const token = getAuthCredential(
		await context.session.modelRuntime.getAuth("radius", { minOAuthValidityMs: 5 * 60_000 }),
	);
	if (!token) return false;

	const loader = new BorderedLoader(context.ui, theme, "Uploading to Radius...");
	context.editorContainer.clear();
	context.editorContainer.addChild(loader);
	context.ui.setFocus(loader);
	context.ui.requestRender();
	loader.onAbort = () => {
		restoreEditor(loader, context);
		context.showStatus("Share cancelled");
	};

	try {
		const body = fs.readFileSync(tmpFile);
		const url = new URL("/v1/artifacts", DEFAULT_RADIUS_GATEWAY);
		url.searchParams.set("visibility", "organization");
		url.searchParams.set("title", "Pi session");
		const response = await fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/x-ndjson",
				"Content-Length": String(body.byteLength),
			},
			body,
			signal: loader.signal,
		});
		if (loader.signal.aborted) return true;
		const json = (await response.json().catch(() => null)) as {
			artifact?: { canonical_url: string };
			error?: string;
		} | null;
		if (loader.signal.aborted) return true;
		restoreEditor(loader, context);
		if (!response.ok || !json?.artifact) {
			context.showError(
				`Failed to upload Radius artifact: ${json?.error || response.statusText || response.status}`,
			);
			return true;
		}
		const shareUrl = json.artifact.canonical_url;
		context.showStatus(`Share URL: ${hyperlink(shareUrl, shareUrl)}`);
		return true;
	} catch (error: unknown) {
		if (!loader.signal.aborted) {
			restoreEditor(loader, context);
			context.showError(
				`Failed to upload Radius artifact: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}
		return true;
	}
}

async function shareViaGist(tmpFile: string, context: SessionShareContext): Promise<void> {
	const loader = new BorderedLoader(context.ui, theme, "Creating gist...");
	context.editorContainer.clear();
	context.editorContainer.addChild(loader);
	context.ui.setFocus(loader);
	context.ui.requestRender();

	let proc: ReturnType<typeof spawn> | null = null;
	loader.onAbort = () => {
		proc?.kill();
		restoreEditor(loader, context);
		context.showStatus("Share cancelled");
	};

	try {
		const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
			proc = spawn("gh", ["gist", "create", "--public=false", tmpFile]);
			let stdout = "";
			let stderr = "";
			proc.stdout?.on("data", (data) => {
				stdout += data.toString();
			});
			proc.stderr?.on("data", (data) => {
				stderr += data.toString();
			});
			proc.on("close", (code) => resolve({ stdout, stderr, code }));
		});

		if (loader.signal.aborted) return;
		restoreEditor(loader, context);

		if (result.code !== 0) {
			context.showError(`Failed to create gist: ${result.stderr?.trim() || "Unknown error"}`);
			return;
		}

		const gistUrl = result.stdout?.trim();
		const gistId = gistUrl?.split("/").pop();
		if (!gistId) {
			context.showError("Failed to parse gist ID from gh output");
			return;
		}

		const previewUrl = getShareViewerUrl(gistId);
		context.showStatus(`Share URL: ${hyperlink(previewUrl, previewUrl)}\nGist: ${hyperlink(gistUrl, gistUrl)}`);
	} catch (error: unknown) {
		if (!loader.signal.aborted) {
			restoreEditor(loader, context);
			context.showError(`Failed to create gist: ${error instanceof Error ? error.message : "Unknown error"}`);
		}
	}
}

function restoreEditor(loader: BorderedLoader, context: SessionShareContext): void {
	loader.dispose();
	context.editorContainer.clear();
	context.editorContainer.addChild(context.editor);
	context.ui.setFocus(context.editor);
}
