/**
 * Import a pi session shared as a gist by the issue-analysis CI workflow
 * (.github/workflows/issue-analysis.yml) and switch to it.
 *
 * The CI job runs in a high-entropy checkout directory; this command rewrites
 * the recorded cwd to the local checkout, installs the session file into the
 * current session directory, and switches to it.
 *
 * Usage:
 *   /ir b4d100022aefb12f25dd2d8485e0a82a
 *   /ir https://gist.github.com/mitsuhiko/b4d100022aefb12f25dd2d8485e0a82a
 *   /ir https://pi.dev/session/#b4d100022aefb12f25dd2d8485e0a82a
 *   /ir https://github.com/earendil-works/pi/issues/123
 *
 *   pi "/ir <gist-id>"
 */

import { Buffer } from "node:buffer";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const GIST_ID_RE = /^[0-9a-fA-F]{20,}$/;
const GIST_URL_RE = /^https:\/\/gist\.github\.com\/(?:[^/]+\/)?([0-9a-fA-F]{20,})(?:[/#?].*)?$/;
const SHARE_URL_RE = /^https:\/\/pi\.dev\/session\/#([0-9a-fA-F]{20,})(?:[/#?].*)?$/;
const ISSUE_URL_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)(?:[/#?].*)?$/;
const GIST_URL_IN_TEXT_RE = /https:\/\/gist\.github\.com\/(?:[^/\s]+\/)?([0-9a-fA-F]{20,})\b/g;
const SESSION_DATA_RE = /<script id="session-data" type="application\/json">([^<]+)<\/script>/;

interface SessionHeader {
	type: "session";
	id: string;
	cwd: string;
	[key: string]: unknown;
}

interface ExportedSessionData {
	header: SessionHeader | null;
	entries: Array<Record<string, unknown>>;
}

interface GistFile {
	filename?: string;
	raw_url?: string;
	content?: string;
	truncated?: boolean;
}

interface GistResponse {
	files?: Record<string, GistFile>;
}

interface IssueComment {
	body?: string | null;
	user?: { login?: string } | null;
}

function parseRef(
	ref: string,
	cwd: string,
): { type: "gist"; id: string } | { type: "file"; path: string } | { type: "issue"; owner: string; repo: string; issue: string } {
	if (ref.endsWith(".html") || ref.endsWith(".jsonl")) {
		return { type: "file", path: isAbsolute(ref) ? ref : resolve(cwd, ref) };
	}

	const shareMatch = ref.match(SHARE_URL_RE);
	if (shareMatch) return { type: "gist", id: shareMatch[1] };

	const gistMatch = ref.match(GIST_URL_RE);
	if (gistMatch) return { type: "gist", id: gistMatch[1] };

	const issueMatch = ref.match(ISSUE_URL_RE);
	if (issueMatch) return { type: "issue", owner: issueMatch[1], repo: issueMatch[2], issue: issueMatch[3] };

	if (GIST_ID_RE.test(ref)) return { type: "gist", id: ref };

	throw new Error(`expected a gist ID, gist URL, pi.dev share URL, issue URL, .html file, or .jsonl file: ${ref}`);
}

function parseSessionJsonl(raw: string): { header: SessionHeader; jsonl: string } {
	const newlineIndex = raw.indexOf("\n");
	const firstLine = newlineIndex === -1 ? raw : raw.slice(0, newlineIndex);
	let parsed: unknown;
	try {
		parsed = JSON.parse(firstLine);
	} catch {
		throw new Error("first line of session file is not valid JSON");
	}
	const header = parsed as Partial<SessionHeader>;
	if (header.type !== "session" || typeof header.id !== "string" || typeof header.cwd !== "string" || header.cwd === "") {
		throw new Error("session file has no valid session header with a cwd");
	}
	return { header: header as SessionHeader, jsonl: raw };
}

function decodeExportedHtml(html: string): { header: SessionHeader; jsonl: string } {
	const match = html.match(SESSION_DATA_RE);
	if (!match) throw new Error("HTML does not contain embedded pi session data");

	let data: unknown;
	try {
		data = JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
	} catch {
		throw new Error("embedded pi session data is not valid JSON");
	}

	const sessionData = data as Partial<ExportedSessionData>;
	const header = sessionData.header;
	if (!header || header.type !== "session" || typeof header.id !== "string" || typeof header.cwd !== "string") {
		throw new Error("embedded pi session data has no valid session header");
	}
	if (!Array.isArray(sessionData.entries)) {
		throw new Error("embedded pi session data has no entries array");
	}

	const lines = [header, ...sessionData.entries].map((entry) => JSON.stringify(entry));
	return { header, jsonl: `${lines.join("\n")}\n` };
}

type SessionPlatform = "windows" | "unix" | "unknown";

function escapeJsonString(value: string): string {
	return JSON.stringify(value).slice(1, -1);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function trimTrailingPathSeparators(value: string): string {
	return value.replace(/[\\/]+$/, "");
}

function getPathTailName(value: string): string {
	const trimmed = trimTrailingPathSeparators(value);
	return trimmed.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
}

function getWindowsDrivePathParts(value: string): { drive: string; rest: string } | undefined {
	const trimmed = trimTrailingPathSeparators(value);
	const driveMatch = trimmed.match(/^([A-Za-z]):[\\/](.*)$/);
	if (driveMatch) {
		return { drive: driveMatch[1].toUpperCase(), rest: driveMatch[2].replace(/[\\/]+/g, "/") };
	}

	const msysMatch = trimmed.match(/^\/([A-Za-z])\/(.*)$/);
	if (msysMatch) {
		return { drive: msysMatch[1].toUpperCase(), rest: msysMatch[2].replace(/[\\/]+/g, "/") };
	}

	return undefined;
}

function getCwdRewriteVariants(sourceCwd: string): string[] {
	const trimmed = trimTrailingPathSeparators(sourceCwd);
	const variants = new Set<string>();
	if (trimmed) variants.add(trimmed);

	const driveParts = getWindowsDrivePathParts(trimmed);
	if (driveParts) {
		const rest = driveParts.rest.replace(/^\/+|\/+$/g, "");
		const backslashRest = rest.replace(/\//g, "\\");
		variants.add(`${driveParts.drive}:\\${backslashRest}`);
		variants.add(`${driveParts.drive}:/${rest}`);
		variants.add(`/${driveParts.drive.toLowerCase()}/${rest}`);
		variants.add(`/${driveParts.drive}/${rest}`);
	}

	return Array.from(variants).filter(Boolean).sort((a, b) => b.length - a.length);
}

function getCiWorkdirName(sourceCwd: string): string | undefined {
	const name = getPathTailName(sourceCwd);
	return /^pi-ci-[0-9a-f]{32}$/i.test(name) ? name : undefined;
}

function detectSessionPlatform(cwd: string): SessionPlatform {
	if (/^[A-Za-z]:[\\/]/.test(cwd) || /^\/[A-Za-z]\//.test(cwd)) return "windows";
	if (cwd.startsWith("/")) return "unix";
	return "unknown";
}

function getLocalPlatform(): Exclude<SessionPlatform, "unknown"> {
	return process.platform === "win32" ? "windows" : "unix";
}

function getPlatformContinuationNotice(sourceCwd: string): string | undefined {
	const sourcePlatform = detectSessionPlatform(sourceCwd);
	const localPlatform = getLocalPlatform();
	if (sourcePlatform === "unknown" || sourcePlatform === localPlatform) return undefined;
	if (localPlatform === "unix") {
		return "This session was continued on a non-Windows machine; paths are now Unix style.";
	}
	return "This session was continued on a Windows machine; paths are now Windows style.";
}

/** Rewrite occurrences of the recorded CI cwd (JSON-escaped) to the target cwd. */
function rewriteSessionCwd(raw: string, sourceCwd: string, targetCwd: string): string {
	const target = escapeJsonString(targetCwd);
	let rewritten = raw;

	for (const sourceVariant of getCwdRewriteVariants(sourceCwd)) {
		if (sourceVariant === targetCwd) continue;
		rewritten = rewritten.split(escapeJsonString(sourceVariant)).join(target);
	}

	const ciWorkdirName = getCiWorkdirName(sourceCwd);
	if (ciWorkdirName) {
		const escapedName = escapeRegExp(ciWorkdirName);
		const windowsPathPatterns = [
			new RegExp(`[A-Za-z]:(?:[^"\\r\\n])*?${escapedName}`, "g"),
			new RegExp(`/[A-Za-z]/(?:[^"\\r\\n])*?${escapedName}`, "g"),
		];
		for (const pattern of windowsPathPatterns) {
			rewritten = rewritten.replace(pattern, target);
		}
	}

	return rewritten;
}

async function fetchText(url: string): Promise<string> {
	const response = await fetch(url, { headers: { Accept: "application/vnd.github+json" } });
	if (!response.ok) {
		throw new Error(`failed to fetch ${url}: HTTP ${response.status}`);
	}
	return await response.text();
}

async function readGistFile(file: GistFile): Promise<string> {
	if (file.content && !file.truncated) return file.content;
	if (!file.raw_url) throw new Error(`gist file ${file.filename ?? "<unknown>"} has no raw URL`);
	return await fetchText(file.raw_url);
}

async function findIssueGistId(owner: string, repo: string, issue: string): Promise<string> {
	const gistIds: string[] = [];
	let page = 1;
	while (true) {
		const response = await fetch(
			`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${encodeURIComponent(issue)}/comments?per_page=100&page=${page}`,
			{ headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" } },
		);
		if (!response.ok) throw new Error(`failed to fetch issue comments: HTTP ${response.status}`);

		const comments = (await response.json()) as IssueComment[];
		for (const comment of comments) {
			if (comment.user?.login !== "github-actions[bot]") continue;
			for (const match of (comment.body ?? "").matchAll(GIST_URL_IN_TEXT_RE)) {
				gistIds.push(match[1]);
			}
		}

		if (comments.length < 100) break;
		page++;
	}

	const gistId = gistIds.at(-1);
	if (!gistId) throw new Error(`no github-actions gist link found in comments on ${owner}/${repo}#${issue}`);
	return gistId;
}

async function fetchGistSession(gistId: string): Promise<{ header: SessionHeader; jsonl: string }> {
	const response = await fetch(`https://api.github.com/gists/${gistId}`, {
		headers: {
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
		},
	});
	if (!response.ok) throw new Error(`failed to fetch gist ${gistId}: HTTP ${response.status}`);

	const gist = (await response.json()) as GistResponse;
	const files = Object.values(gist.files ?? {});
	const jsonlFile = files.find((file) => file.filename?.endsWith(".jsonl"));
	if (jsonlFile) return parseSessionJsonl(await readGistFile(jsonlFile));

	const htmlFile = files.find((file) => file.filename?.endsWith(".html"));
	if (htmlFile) return decodeExportedHtml(await readGistFile(htmlFile));

	throw new Error(`gist ${gistId} has no .jsonl or .html session file`);
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("ir", {
		description: "Import a CI issue-analysis session from a gist ID, share URL, or issue URL and switch to it",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const ref = args.trim();
			if (!ref) {
				ctx.ui.notify("Usage: /ir <gist-id | gist-url | pi.dev/session URL | issue URL>", "error");
				return;
			}

			try {
				const targetCwd = ctx.sessionManager.getCwd();
				const sessionDir = ctx.sessionManager.getSessionDir();
				const parsedRef = parseRef(ref, targetCwd);

				ctx.ui.notify(`Importing repro session from ${ref}...`, "info");

				let sourceName: string;
				let decoded: { header: SessionHeader; jsonl: string };
				if (parsedRef.type === "gist") {
					decoded = await fetchGistSession(parsedRef.id);
					sourceName = `${parsedRef.id}.jsonl`;
				} else if (parsedRef.type === "issue") {
					const gistId = await findIssueGistId(parsedRef.owner, parsedRef.repo, parsedRef.issue);
					decoded = await fetchGistSession(gistId);
					sourceName = `${gistId}.jsonl`;
				} else {
					if (!existsSync(parsedRef.path)) throw new Error(`session file not found: ${parsedRef.path}`);
					const raw = readFileSync(parsedRef.path, "utf8");
					decoded = parsedRef.path.endsWith(".html") ? decodeExportedHtml(raw) : parseSessionJsonl(raw);
					sourceName = basename(parsedRef.path).replace(/\.html$/, ".jsonl");
				}

				const platformNotice = getPlatformContinuationNotice(decoded.header.cwd);
				const rewritten = rewriteSessionCwd(decoded.jsonl, decoded.header.cwd, targetCwd);
				const destination = join(sessionDir, sourceName);
				if (existsSync(destination)) {
					const overwrite = await ctx.ui.confirm(
						"Session already imported",
						`Overwrite ${destination}? Local changes to that session will be lost.`,
					);
					if (!overwrite) {
						ctx.ui.notify("Import cancelled", "warning");
						return;
					}
				}
				writeFileSync(destination, rewritten);

				ctx.ui.notify(`Imported session ${decoded.header.id} (cwd ${decoded.header.cwd} -> ${targetCwd})`, "info");
				await ctx.switchSession(destination, {
					withSession: async (nextCtx) => {
						if (!platformNotice) return;
						await nextCtx.sendMessage(
							{
								customType: "import-repro",
								content: platformNotice,
								display: true,
								details: { sourceCwd: decoded.header.cwd, targetCwd },
							},
							{ triggerTurn: false },
						);
					},
				});
			} catch (error) {
				ctx.ui.notify(`ir: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
