// The workspace in the TUI (p2-tui-port.md P11i), after the web's Workspace panel, read-only: `/files` browses the
// session directory and shows a file, `/changes` lists git changes and shows a change's diff (pi's diff renderer),
// `/grep` searches text and opens a match at its line. Participants only: holding `Workspace` leases the worker's
// filesystem watch, which read-only guests cannot get. Comments, commits and uploads stay on the web for now.

import type { Held } from "@p2/app/v1";
import { BACKGROUND_CONTEXT, contribute, defineFacet, statusOf, whenLive } from "@p2/app/v1";
import type { TuiContext } from "@p2/app/v1/tui";
import {
	ListOverlay,
	type ListRow,
	lineText,
	renderDiff,
	TextViewer,
	type TuiCommand,
	TuiCommands,
	type TuiRuntime,
	TuiScope,
	TuiSlots,
	type TuiSurface,
} from "@p2/app/v1/tui";
import { Workspace } from "./contract.ts";
import type { WorkspaceQuery, WorkspaceResult } from "./protocol.ts";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The viewed conversation's workspace, released when the panel closes. */
function workspace(ctx: TuiContext): Held<typeof Workspace> | undefined {
	const session = ctx.identity.session;
	if (!session) return undefined;
	return ctx.host.hold(Workspace, { session, conversation: ctx.identity.conversation }, BACKGROUND_CONTEXT);
}

async function query<K extends WorkspaceResult["kind"]>(
	ref: Held<typeof Workspace>,
	request: WorkspaceQuery,
	kind: K,
): Promise<Extract<WorkspaceResult, { kind: K }>> {
	await whenLive(ref);
	if (statusOf(ref) !== "live" || ref.variant !== "reader") throw new Error("The workspace is not available");
	const result = await ref.query(request, BACKGROUND_CONTEXT);
	if (result.kind !== kind) throw new Error(`Unexpected workspace result: ${result.kind}`);
	return result as Extract<WorkspaceResult, { kind: K }>;
}

/**
 * Git's unified patch in pi's diff line format ("+12 text", "-12 text", " 12 text", "     ..."), so the copied
 * renderer (intra-line highlighting) applies. File headers are dropped; a hunk boundary becomes "...".
 */
export function piDiff(patch: string): string {
	const out: string[] = [];
	let oldLine = 0;
	let newLine = 0;
	let width = 1;
	for (const match of patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm))
		width = Math.max(
			width,
			String(Number(match[3]) + Number(match[4] ?? 1)).length,
			String(Number(match[1]) + Number(match[2] ?? 1)).length,
		);
	let inHunk = false;
	for (const raw of patch.split("\n")) {
		const hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
		if (hunk) {
			if (inHunk) out.push(`${" ".repeat(width + 1)} ...`);
			oldLine = Number(hunk[1]);
			newLine = Number(hunk[2]);
			inHunk = true;
			continue;
		}
		if (!inHunk || raw.startsWith("\\")) continue;
		const text = lineText(raw.slice(1));
		if (raw.startsWith("+")) out.push(`+${String(newLine++).padStart(width)} ${text}`);
		else if (raw.startsWith("-")) out.push(`-${String(oldLine++).padStart(width)} ${text}`);
		else if (raw.startsWith(" ")) {
			out.push(` ${String(newLine).padStart(width)} ${text}`);
			oldLine++;
			newLine++;
		} else if (raw.startsWith("diff ")) inHunk = false;
	}
	return out.join("\n");
}

/** Shows a file (optionally at a line) above the list it came from. */
function showFile(ctx: TuiContext, ref: Held<typeof Workspace>, path: string, line?: number): void {
	let lines: string[] = ["Loading…"];
	const viewer = ctx.overlay(
		"workspace-file",
		new TextViewer(ctx, {
			title: path,
			lines: () => lines,
			onClose: () => viewer.close(),
			...(line ? { line } : {}),
		}),
		{ width: "100%", anchor: "bottom-center" },
	);
	void query(ref, { kind: "file", path }, "file")
		.then((file) => {
			if (file.binary || file.text === undefined) lines = [`Binary file, ${file.size} bytes`];
			else {
				const width = String(file.text.split("\n").length).length;
				const theme = ctx.theme.current;
				lines = file.text.split("\n").map((text, index) => {
					const number = theme.fg(index + 1 === line ? "accent" : "dim", String(index + 1).padStart(width));
					return `${number} ${lineText(text)}`;
				});
				if (file.truncated) lines.push(ctx.theme.current.fg("warning", "… truncated (the web panel shows more)"));
			}
		})
		.catch((error: unknown) => {
			lines = [message(error)];
		})
		.finally(() => ctx.requestRender());
}

function showDiff(ctx: TuiContext, ref: Held<typeof Workspace>, path: string): void {
	let lines: string[] = ["Loading…"];
	const viewer = ctx.overlay(
		"workspace-diff",
		new TextViewer(ctx, { title: `Changes: ${path}`, lines: () => lines, onClose: () => viewer.close() }),
		{ width: "100%", anchor: "bottom-center" },
	);
	void query(ref, { kind: "diff", path }, "diff")
		.then((diff) => {
			const converted = piDiff(diff.patch);
			lines = converted ? renderDiff(converted, ctx.theme.current).split("\n") : ["No textual changes"];
			if (diff.truncated) lines.push(ctx.theme.current.fg("warning", "… truncated"));
		})
		.catch((error: unknown) => {
			lines = [message(error)];
		})
		.finally(() => ctx.requestRender());
}

/** Opens a panel with a workspace reference that is released when it closes. */
function panel(
	ctx: TuiContext,
	id: string,
	build: (ref: Held<typeof Workspace>, close: () => void) => ConstructorParameters<typeof ListOverlay>[1],
): void {
	const ref = workspace(ctx);
	if (!ref) return;
	const close = () => {
		ref.release();
		overlay.close();
	};
	const overlay = ctx.overlay(id, new ListOverlay(ctx, build(ref, close)), {
		width: "100%",
		anchor: "bottom-center",
	});
}

/** `/files [dir]`: the directory's entries, directories first; Enter opens a directory or shows a file. */
function openFiles(ctx: TuiContext, start: string): void {
	panel(ctx, "files", (ref, close) => {
		let dir = start.replace(/^\.?\/+|\/+$/g, "");
		let rows: ListRow[] = [];
		let status = "Loading…";
		const load = () => {
			status = "Loading…";
			void query(ref, { kind: "list", path: dir }, "list")
				.then((list) => {
					const entries = list.entries.toSorted(
						(a, b) =>
							Number(b.kind === "directory") - Number(a.kind === "directory") || a.name.localeCompare(b.name),
					);
					rows = [
						...(dir ? [{ key: "..", label: "../" }] : []),
						...entries.map((entry) => ({
							key: entry.name,
							label: `${entry.name}${entry.kind === "directory" ? "/" : ""}`,
							detail: entry.kind === "file" ? `${entry.size} B` : entry.kind === "symlink" ? "link" : "",
							...(entry.ignored ? { color: "muted" as const } : {}),
						})),
					];
					status = list.truncated ? "Listing truncated" : "";
				})
				.catch((error: unknown) => {
					rows = [];
					status = message(error);
				})
				.finally(() => ctx.requestRender());
		};
		load();
		return {
			title: () => `Files: ${dir || "."}`,
			rows: () => rows,
			onSelect: (row) => {
				if (row.key === "..") {
					dir = dir.split("/").slice(0, -1).join("/");
					load();
				} else if (row.label.endsWith("/")) {
					dir = dir ? `${dir}/${row.key}` : row.key;
					load();
				} else showFile(ctx, ref, dir ? `${dir}/${row.key}` : row.key);
			},
			footer: () => (status ? [ctx.theme.current.fg("muted", `  ${lineText(status)}`)] : []),
			onClose: close,
		};
	});
}

/** `/changes`: the working tree's git status; Enter shows the change's diff. */
function openChanges(ctx: TuiContext): void {
	panel(ctx, "changes", (ref, close) => {
		let rows: ListRow[] = [];
		let status = "Loading…";
		let branch = "";
		void query(ref, { kind: "status" }, "status")
			.then((result) => {
				if (!result.repo) {
					status = result.reason ?? "Not a git repository";
					return;
				}
				branch = result.branch ?? result.head?.slice(0, 7) ?? "";
				rows = result.changes.map((change) => ({
					key: change.path,
					label: change.from ? `${change.from} → ${change.path}` : change.path,
					detail: change.status,
					...(change.status.includes("U") ? { color: "error" as const } : {}),
				}));
				status = result.truncated ? "List truncated" : rows.length ? "" : "No changes";
			})
			.catch((error: unknown) => {
				status = message(error);
			})
			.finally(() => ctx.requestRender());
		return {
			title: () => `Changes${branch ? ` on ${branch}` : ""} (${rows.length})`,
			rows: () => rows,
			onSelect: (row) => showDiff(ctx, ref, row.key),
			footer: () => (status ? [ctx.theme.current.fg("muted", `  ${lineText(status)}`)] : []),
			onClose: close,
		};
	});
}

/** `/grep <text>`: literal matches below the session directory; Enter opens the file at the match. */
function openGrep(ctx: TuiContext, text: string): void {
	if (!text.trim()) {
		ctx.notify("Usage: /grep <text>");
		return;
	}
	panel(ctx, "grep", (ref, close) => {
		let rows: (ListRow & { path: string; line: number })[] = [];
		let status = "Searching…";
		void query(ref, { kind: "search", text, path: "" }, "search")
			.then((result) => {
				rows = result.matches.map((match, index) => ({
					key: String(index),
					label: match.text.trim(),
					detail: `${match.path}:${match.line}`,
					path: match.path,
					line: match.line,
				}));
				status = result.truncated ? "Results truncated" : rows.length ? "" : "No matches";
			})
			.catch((error: unknown) => {
				status = message(error);
			})
			.finally(() => ctx.requestRender());
		return {
			title: () => `Search "${lineText(text)}" (${rows.length})`,
			rows: () => rows,
			onSelect: (row) => {
				const match = rows.find((candidate) => candidate.key === row.key);
				if (match) showFile(ctx, ref, match.path, match.line);
			},
			footer: () => (status ? [ctx.theme.current.fg("muted", `  ${lineText(status)}`)] : []),
			onClose: close,
		};
	});
}

export const WORKSPACE_COMMANDS: Record<string, TuiCommand> = {
	"p2.files": {
		title: "Browse files",
		category: "Workspace",
		when: "chat && participant && !overlay",
		slash: { name: "files", argumentHint: "[directory]" },
		run: (ctx, args) => openFiles(ctx, args ?? ""),
	},
	"p2.changes": {
		title: "Working tree changes",
		category: "Workspace",
		when: "chat && participant && !overlay",
		slash: { name: "changes" },
		run: (ctx) => openChanges(ctx),
	},
	"p2.grep": {
		title: "Search files",
		category: "Workspace",
		when: "chat && participant && !overlay",
		slash: { name: "grep", argumentHint: "<text>" },
		run: (ctx, args) => openGrep(ctx, args ?? ""),
	},
};

/**
 * The viewed conversation's git branch for the footer (pi's `cwd (branch)`), from `Workspace.query({kind: "status"})`,
 * asked again when files change (debounced). "detached" for a detached HEAD, as pi. Only for those who may hold
 * `Workspace` (the owner, full-access guests): view-only guests are refused, so they never ask.
 */
export class GitBranch implements TuiSurface {
	readonly runtime: TuiRuntime;
	branch: string | undefined;
	private key: string | undefined;
	private scope: TuiScope | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private asking = false;
	private again = false;
	private stop: () => void;
	constructor(runtime: TuiRuntime) {
		this.runtime = runtime;
		const changed = () => this.sync();
		runtime.listeners.add(changed);
		this.stop = () => runtime.listeners.delete(changed);
		this.sync();
	}
	private allowed(): boolean {
		const runtime = this.runtime;
		return runtime.role === "owner" || (runtime.role === "guest" && runtime.guestMode() === "full");
	}
	private sync(): void {
		const session = this.runtime.session;
		const allowed = session !== undefined && this.allowed();
		const key = allowed ? `${session}#${this.runtime.conversation}` : undefined;
		if (key === this.key) return;
		this.key = key;
		this.scope?.dispose();
		this.scope = undefined;
		clearTimeout(this.timer);
		this.branch = undefined;
		if (!allowed || !session) return;
		const scope = new TuiScope(this.runtime);
		this.scope = scope;
		const workspace = scope.watch(Workspace, { session, conversation: this.runtime.conversation }, (_ref, follow) =>
			follow(_ref.changes, () => {
				// The first answer at once; file changes coalesce.
				clearTimeout(this.timer);
				this.timer = setTimeout(() => this.ask(workspace, key), this.branch === undefined ? 0 : 500);
			}),
		);
	}
	private ask(workspace: () => Held<typeof Workspace> | undefined, key: string | undefined): void {
		const ref = workspace();
		if (ref === undefined || statusOf(ref) !== "live" || ref.variant !== "reader" || key !== this.key) return;
		if (this.asking) {
			this.again = true;
			return;
		}
		this.asking = true;
		void ref
			.query({ kind: "status" }, BACKGROUND_CONTEXT)
			.then((result) => {
				if (key !== this.key || result.kind !== "status") return;
				const branch = result.repo ? (result.branch ?? (result.head ? "detached" : undefined)) : undefined;
				if (branch === this.branch) return;
				this.branch = branch;
				this.runtime.changed();
			})
			.catch(() => {})
			.finally(() => {
				this.asking = false;
				if (this.again) {
					this.again = false;
					this.ask(workspace, key);
				}
			});
	}
	render(): string[] {
		return this.branch ? [lineText(this.branch)] : [];
	}
	invalidate(): void {}
	dispose(): void {
		this.stop();
		clearTimeout(this.timer);
		this.scope?.dispose();
	}
}

export default defineFacet((host) =>
	contribute(host, "p2.tui-workspace", (self) => {
		self.contribute(TuiCommands, WORKSPACE_COMMANDS);
		self.contribute(TuiSlots, { "footer:branch": (runtime: TuiRuntime): TuiSurface => new GitBranch(runtime) });
	}),
);
