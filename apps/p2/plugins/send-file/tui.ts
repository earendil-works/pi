// Sent files in the TUI (p2-tui-port.md P11c), after the web's file card and viewer. The card names the file and its
// size. `/downloads` lists the files sent in the loaded transcript: Enter previews text (`SentFiles.preview`),
// Ctrl+S saves it through the launcher's `download` (bounded, never overwriting) and Ctrl+B opens the download in the
// browser (launcher `openUrl`; the browser needs its own sign-in). The worker never fetches `/download` itself.

import { Text } from "@earendil-works/pi-tui";
import { BACKGROUND_CONTEXT, contribute, defineFacet, statusOf, whenLive } from "@p2/app/v1";
import type { TuiContext } from "@p2/app/v1/tui";
import {
	chatSurface,
	formatSize,
	getTextOutput,
	grantNotice,
	ListOverlay,
	type ListRow,
	lineText,
	record,
	renderToolPath,
	str,
	TextViewer,
	type ToolRenderers,
	type TuiCommand,
	TuiCommands,
	TuiToolRenderers,
} from "@p2/app/v1/tui";
import { SentFiles } from "./contract.ts";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type SentFile = { id: string; name: string; size: number };

/** The web card's checks: a snapshot ID, a name and a size. */
function sentFile(details: unknown): SentFile | undefined {
	const value = record(details);
	return typeof value?.id === "string" &&
		ID.test(value.id) &&
		typeof value.name === "string" &&
		typeof value.size === "number" &&
		value.size >= 0
		? { id: value.id, name: value.name, size: value.size }
		: undefined;
}

const sendFileRenderers: ToolRenderers = {
	renderCall(args, theme, context) {
		const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
		text.setText(
			`${theme.fg("toolTitle", theme.bold("send_file"))} ${renderToolPath(str(args.path), theme, context.cwd)}`,
		);
		return text;
	},
	renderResult(result, _options, theme, context) {
		const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
		const file = context.isError ? undefined : sentFile(result.details);
		text.setText(
			file
				? `\n${theme.fg("success", "■")} ${lineText(file.name)} ${theme.fg("muted", `· ${formatSize(file.size)} · ready to download`)} ${theme.fg("dim", "· /downloads saves")}`
				: `\n${theme.fg(context.isError ? "error" : "toolOutput", getTextOutput(result))}`,
		);
		return text;
	},
};

function preview(ctx: TuiContext, session: string, file: SentFile): void {
	let lines: string[] = [ctx.theme.current.fg("muted", "Loading…")];
	const viewer = ctx.overlay(
		"download-view",
		new TextViewer(ctx, {
			title: `${file.name} · ${formatSize(file.size)}`,
			lines: () => lines,
			onClose: () => {
				ref.release();
				viewer.close();
			},
		}),
		{ width: "100%", anchor: "bottom-center" },
	);
	const ref = ctx.host.hold(SentFiles, { session }, BACKGROUND_CONTEXT);
	void whenLive(ref)
		.then(async () => {
			if (statusOf(ref) !== "live" || ref.variant !== "reader") throw new Error("Sent files are not available");
			const result = await ref.preview({ id: file.id }, BACKGROUND_CONTEXT);
			const theme = ctx.theme.current;
			lines =
				result.text === null
					? [theme.fg("muted", "Not a text file: Ctrl+S in /downloads saves it.")]
					: [
							...result.text.split("\n").map((line) => lineText(line)),
							...(result.truncated
								? ["", theme.fg("warning", "… truncated: Ctrl+S in /downloads saves all of it")]
								: []),
						];
		})
		.catch((error: unknown) => {
			lines = [error instanceof Error ? error.message : String(error)];
		})
		.finally(() => ctx.requestRender());
}

function openDownloads(ctx: TuiContext): void {
	const session = ctx.identity.session;
	const chat = chatSurface(ctx);
	if (!session || !chat) return;
	// Newest first; one row per snapshot.
	const files = () => {
		const seen = new Set<string>();
		return chat
			.toolViews("send_file")
			.flatMap((tool) => sentFile(tool.details) ?? [])
			.toReversed()
			.filter((file) => !seen.has(file.id) && seen.add(file.id));
	};
	const byRow = (row: ListRow | undefined) => files().find((file) => file.id === row?.key);
	const overlay = ctx.overlay(
		"downloads",
		new ListOverlay(ctx, {
			title: () => `Sent files (${files().length})`,
			rows: () => files().map((file) => ({ key: file.id, label: file.name, detail: formatSize(file.size) })),
			onSelect: (row) => {
				const file = byRow(row);
				if (file) preview(ctx, session, file);
			},
			actions: [
				{
					key: "ctrl+s",
					label: "save",
					run: (row) => {
						const file = byRow(row);
						if (file)
							void ctx
								.grant("download", { kind: "file", session, id: file.id, name: file.name })
								.then((result) => grantNotice(ctx, `Saved ${file.name}`, result));
					},
				},
				{
					key: "ctrl+b",
					label: "open in browser",
					run: (row) => {
						const file = byRow(row);
						if (file)
							void ctx
								.grant("openUrl", {
									kind: "origin",
									path: `/download?${new URLSearchParams({ session, id: file.id })}`,
								})
								.then((result) => grantNotice(ctx, `Opened ${file.name} in the browser`, result));
					},
				},
			],
			footer: () => [
				ctx.theme.current.fg("dim", "  Files sent in the loaded transcript; the browser needs its own sign-in"),
			],
			onClose: () => overlay.close(),
		}),
		{ width: "100%", anchor: "bottom-center" },
	);
}

const COMMANDS: Record<string, TuiCommand> = {
	"p2.downloads": {
		title: "Sent files",
		category: "Session",
		when: "chat && !overlay",
		slash: { name: "downloads" },
		run: (ctx) => openDownloads(ctx),
	},
};

export default defineFacet((host) =>
	contribute(host, "p2.tui-send-file", (self) => {
		self.contribute(TuiToolRenderers, { send_file: sendFileRenderers });
		self.contribute(TuiCommands, COMMANDS);
	}),
);
