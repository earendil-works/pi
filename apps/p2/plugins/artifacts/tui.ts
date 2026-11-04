// Artifacts in the TUI (p2-tui-port.md P11c), after the web's artifact card, picker and viewer. The card shows the
// title, type and version; expanded, a text or Markdown artifact shows the content the call wrote. `/artifacts` lists
// the conversation's artifacts (`ArtifactList`): Enter shows one inline (`ArtifactContent`; Markdown rendered, HTML and
// SVG as source), Ctrl+B opens it in the browser (launcher `openUrl`; the browser needs its own sign-in) and Ctrl+S
// downloads it (launcher `download`). The worker never fetches the `/artifact` route itself: it has no cookie.

import { Markdown, Text } from "@earendil-works/pi-tui";
import { BACKGROUND_CONTEXT, contribute, defineFacet, follow, statusOf, whenLive } from "@p2/app/v1";
import type { TuiContext } from "@p2/app/v1/tui";
import {
	getTextOutput,
	grantNotice,
	ListOverlay,
	type ListRow,
	lineText,
	record,
	safeText,
	str,
	TextViewer,
	type ToolRenderers,
	type TuiCommand,
	TuiCommands,
	TuiToolRenderers,
} from "@p2/app/v1/tui";
import { ArtifactContent, type ArtifactInfo, ArtifactList } from "./contract.ts";

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** Collapsed cards show this many lines of a text or Markdown artifact; expanded ones all. */
const PREVIEW_LINES = 8;
const BROWSER_NOTE = "the browser needs its own sign-in to this server";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const artifactRenderers: ToolRenderers = {
	renderCall(args, theme, context) {
		const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
		const title = str(args.title) || str(args.name) || "...";
		text.setText(`${theme.fg("toolTitle", theme.bold("artifact"))} ${theme.fg("accent", lineText(title))}`);
		return text;
	},
	renderResult(result, options, theme, context) {
		const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
		const details = record(result.details);
		const saved =
			!context.isError &&
			typeof details?.title === "string" &&
			typeof details.type === "string" &&
			typeof details.version === "number";
		if (!saved) {
			text.setText(`\n${theme.fg(context.isError ? "error" : "toolOutput", getTextOutput(result))}`);
			return text;
		}
		const lines = [
			`${theme.fg("success", "■")} ${lineText(String(details.title))} ${theme.fg("muted", `· ${lineText(String(details.type)).toUpperCase()} · version ${details.version}`)} ${theme.fg("dim", "· /artifacts opens")}`,
		];
		// What the call wrote (text and Markdown; HTML and SVG run only in a browser).
		const content = str(context.args.content);
		if (content && (details.type === "text" || details.type === "markdown")) {
			const all = content.split("\n").map((line) => theme.fg("toolOutput", lineText(line)));
			const shown = options.expanded ? all : all.slice(0, PREVIEW_LINES);
			lines.push("", ...shown);
			if (shown.length < all.length)
				lines.push(
					theme.fg(
						"muted",
						`... (${all.length - shown.length} more lines, ${context.ui.keyText("app.tools.expand")} to expand)`,
					),
				);
		}
		text.setText(`\n${lines.join("\n")}`);
		return text;
	},
};

/** An artifact shown inline: Markdown rendered, text and HTML/SVG source as lines. */
function showArtifact(ctx: TuiContext, session: string, artifact: ArtifactInfo): void {
	let content: string | undefined;
	let status = "Loading…";
	let cache: { width: number; lines: string[] } | undefined;
	const lines = (width: number): string[] => {
		if (content === undefined) return [ctx.theme.current.fg("muted", status)];
		if (cache?.width === width) return cache.lines;
		const body =
			artifact.type === "markdown"
				? new Markdown(safeText(content), 0, 0, ctx.theme.markdown).render(width)
				: content.split("\n").map((line) => lineText(line));
		const note =
			artifact.type === "html" || artifact.type === "svg"
				? [
						ctx.theme.current.fg(
							"warning",
							`Source only: Ctrl+B in /artifacts opens it in the browser (${BROWSER_NOTE}).`,
						),
						"",
					]
				: [];
		cache = { width, lines: [...note, ...body, ...(status ? ["", ctx.theme.current.fg("warning", status)] : [])] };
		return cache.lines;
	};
	const viewer = ctx.overlay(
		"artifact-view",
		new TextViewer(ctx, {
			title: `${artifact.title} · ${artifact.type.toUpperCase()} · version ${artifact.version}`,
			lines,
			onClose: () => {
				ref.release();
				viewer.close();
			},
		}),
		{ width: "100%", anchor: "bottom-center" },
	);
	const ref = ctx.host.hold(ArtifactContent, { session }, BACKGROUND_CONTEXT);
	void whenLive(ref)
		.then(async () => {
			if (statusOf(ref) !== "live" || ref.variant !== "reader") throw new Error("Artifacts are not available");
			const read = await ref.read({ name: artifact.name, version: artifact.version }, BACKGROUND_CONTEXT);
			status = read.truncated ? "… truncated: Ctrl+S in /artifacts downloads all of it" : "";
			content = read.content;
		})
		.catch((error: unknown) => {
			status = message(error);
		})
		.finally(() => {
			cache = undefined;
			ctx.requestRender();
		});
}

function openArtifacts(ctx: TuiContext): void {
	const session = ctx.identity.session;
	if (!session) return;
	const list = ctx.host.hold(ArtifactList, { session, conversation: ctx.identity.conversation }, BACKGROUND_CONTEXT);
	let artifacts: ArtifactInfo[] = [];
	const stop = follow(list.artifacts, (value) => {
		artifacts = (value ?? []).filter((artifact) => NAME.test(artifact.name));
		ctx.requestRender();
	});
	const byRow = (row: ListRow | undefined) => artifacts.find((artifact) => artifact.name === row?.key);
	const overlay = ctx.overlay(
		"artifacts",
		new ListOverlay(ctx, {
			title: () => `Artifacts (${artifacts.length})`,
			rows: () =>
				artifacts.map((artifact) => ({
					key: artifact.name,
					label: artifact.title,
					detail: `${artifact.type.toUpperCase()} · v${artifact.version}`,
				})),
			onSelect: (row) => {
				const artifact = byRow(row);
				if (artifact) showArtifact(ctx, session, artifact);
			},
			actions: [
				{
					key: "ctrl+b",
					label: "open in browser",
					run: (row) => {
						const artifact = byRow(row);
						if (!artifact) return;
						const query = new URLSearchParams({
							session,
							name: artifact.name,
							version: String(artifact.version),
						});
						void ctx
							.grant("openUrl", { kind: "origin", path: `/artifact?${query}` })
							.then((result) => grantNotice(ctx, `Opened ${artifact.title} in the browser`, result));
					},
				},
				{
					key: "ctrl+s",
					label: "download",
					run: (row) => {
						const artifact = byRow(row);
						if (!artifact) return;
						void ctx
							.grant("download", { kind: "artifact", session, name: artifact.name, version: artifact.version })
							.then((result) => grantNotice(ctx, `Downloaded ${artifact.title}`, result));
					},
				},
			],
			footer: () => [
				ctx.theme.current.fg("dim", `  Enter shows it here; Ctrl+B opens it in the browser (${BROWSER_NOTE})`),
			],
			onClose: () => {
				stop();
				list.release();
				overlay.close();
			},
		}),
		{ width: "100%", anchor: "bottom-center" },
	);
}

const COMMANDS: Record<string, TuiCommand> = {
	"p2.artifacts": {
		title: "Artifacts",
		category: "Session",
		when: "chat && !overlay",
		slash: { name: "artifacts" },
		run: (ctx) => openArtifacts(ctx),
	},
};

export default defineFacet((host) =>
	contribute(host, "p2.tui-artifacts", (self) => {
		self.contribute(TuiToolRenderers, { artifact: artifactRenderers });
		self.contribute(TuiCommands, COMMANDS);
	}),
);
