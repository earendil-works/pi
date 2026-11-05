// Artifacts in the TUI (p2-tui-port.md P11c), after the web's artifact card, picker and viewer. The card shows the
// title, type and version; expanded, a text or Markdown artifact shows the content the call wrote. A call with
// `inline: true` shows all of it at once (Markdown rendered); inline HTML and SVG keep the card line. `/artifacts` lists
// the conversation's artifacts (`ArtifactList`): Enter shows one inline (`ArtifactContent`; Markdown rendered, HTML and
// SVG as source; in the side panel, where it follows new versions, when the terminal is wide enough), Ctrl+B opens it in the browser (launcher `openUrl`; the browser needs its own sign-in) and Ctrl+S
// downloads it (launcher `download`). The worker never fetches the `/artifact` route itself: it has no cookie.

import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
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
		const component = context.lastComponent instanceof Container ? context.lastComponent : new Container();
		component.clear();
		component.addChild(new Spacer(1));
		const details = record(result.details);
		const saved =
			!context.isError &&
			typeof details?.title === "string" &&
			typeof details.type === "string" &&
			typeof details.version === "number";
		if (!saved) {
			component.addChild(new Text(theme.fg(context.isError ? "error" : "toolOutput", getTextOutput(result)), 0, 0));
			return component;
		}
		component.addChild(
			new Text(
				`${theme.fg("success", "■")} ${lineText(String(details.title))} ${theme.fg("muted", `· ${lineText(String(details.type)).toUpperCase()} · version ${details.version}`)} ${theme.fg("dim", "· /artifacts opens")}`,
				0,
				0,
			),
		);
		// What the call wrote (text and Markdown; HTML and SVG run only in a browser): the version this call produced.
		const content = str(context.args.content);
		if (!content || (details.type !== "text" && details.type !== "markdown")) return component;
		component.addChild(new Spacer(1));
		if (details.inline === true && details.type === "markdown") {
			component.addChild(new Markdown(safeText(content), 0, 0, context.ui.theme.markdown));
			return component;
		}
		const all = content.split("\n").map((line) => theme.fg("toolOutput", lineText(line)));
		const shown = options.expanded || details.inline === true ? all : all.slice(0, PREVIEW_LINES);
		if (shown.length < all.length)
			shown.push(
				theme.fg(
					"muted",
					`... (${all.length - shown.length} more lines, ${context.ui.keyText("app.tools.expand")} to expand)`,
				),
			);
		component.addChild(new Text(shown.join("\n"), 0, 0));
		return component;
	},
};

/** Reads artifact versions of `session` through one held `ArtifactContent`, until released. */
function contentReader(ctx: TuiContext, session: string) {
	const ref = ctx.host.hold(ArtifactContent, { session }, BACKGROUND_CONTEXT);
	return {
		read: async (artifact: ArtifactInfo) => {
			await whenLive(ref);
			if (statusOf(ref) !== "live" || ref.variant !== "reader") throw new Error("Artifacts are not available");
			return ref.read({ name: artifact.name, version: artifact.version }, BACKGROUND_CONTEXT);
		},
		release: () => ref.release(),
	};
}

type ContentReader = ReturnType<typeof contentReader>;

/**
 * One version of an artifact as lines at a width (Markdown rendered, text and HTML/SVG source), cached per width;
 * `load` reads a version and renders it once read.
 */
class ArtifactLines {
	private content: string | undefined;
	private status = "Loading…";
	private cache: { width: number; lines: string[] } | undefined;
	private readonly ctx: TuiContext;
	private artifact: ArtifactInfo;
	constructor(ctx: TuiContext, artifact: ArtifactInfo) {
		this.ctx = ctx;
		this.artifact = artifact;
	}
	get info(): ArtifactInfo {
		return this.artifact;
	}
	/** Reads `artifact` (a version) and shows it once read; the previous version stays shown meanwhile. */
	load(reader: ContentReader, artifact: ArtifactInfo): void {
		void reader
			.read(artifact)
			.then((read) => {
				// Reads may finish out of order: an older version never replaces a newer one.
				if (artifact.version < this.artifact.version && this.content !== undefined) return;
				this.artifact = artifact;
				this.status = read.truncated ? "… truncated: Ctrl+S in /artifacts downloads all of it" : "";
				this.content = read.content;
			})
			.catch((error: unknown) => {
				this.status = message(error);
			})
			.finally(() => {
				this.cache = undefined;
				this.ctx.requestRender();
			});
	}
	render(width: number): string[] {
		const theme = this.ctx.theme.current;
		if (this.content === undefined) return [theme.fg("muted", this.status)];
		if (this.cache?.width === width) return this.cache.lines;
		const body =
			this.artifact.type === "markdown"
				? new Markdown(safeText(this.content), 0, 0, this.ctx.theme.markdown).render(width)
				: this.content.split("\n").map((line) => lineText(line));
		const note =
			this.artifact.type === "html" || this.artifact.type === "svg"
				? [theme.fg("warning", `Source only: Ctrl+B in /artifacts opens it in the browser (${BROWSER_NOTE}).`), ""]
				: [];
		const status = this.status ? ["", theme.fg("warning", this.status)] : [];
		this.cache = { width, lines: [...note, ...body, ...status] };
		return this.cache.lines;
	}
	invalidate(): void {
		this.cache = undefined;
	}
}

/** An artifact shown inline, over the chat. */
function showArtifact(ctx: TuiContext, session: string, artifact: ArtifactInfo): void {
	const shown = new ArtifactLines(ctx, artifact);
	const viewer = ctx.overlay(
		"artifact-view",
		new TextViewer(ctx, {
			title: `${artifact.title} · ${artifact.type.toUpperCase()} · version ${artifact.version}`,
			lines: (width) => shown.render(width),
			onClose: () => {
				reader.release();
				viewer.close();
			},
		}),
		{ width: "100%", anchor: "bottom-center" },
	);
	const reader = contentReader(ctx, session);
	shown.load(reader, artifact);
}

/** An artifact pinned in the side panel: it shows each new version as the conversation's artifact list reports it. */
function pinArtifact(ctx: TuiContext, session: string, conversation: number, artifact: ArtifactInfo): void {
	const shown = new ArtifactLines(ctx, artifact);
	const reader = contentReader(ctx, session);
	const list = ctx.host.hold(ArtifactList, { session, conversation }, BACKGROUND_CONTEXT);
	let loaded = artifact.version;
	shown.load(reader, artifact);
	const stop = follow(list.artifacts, (value) => {
		// The list has one entry per version.
		const latest = (value ?? [])
			.filter((candidate) => candidate.name === artifact.name)
			.reduce<ArtifactInfo | undefined>(
				(max, candidate) => (max && max.version >= candidate.version ? max : candidate),
				undefined,
			);
		if (!latest || latest.version <= loaded) return;
		loaded = latest.version;
		shown.load(reader, latest);
	});
	ctx.panel.open(
		`artifact:${artifact.name}`,
		{
			render: (width) => shown.render(width),
			invalidate: () => shown.invalidate(),
			dispose: () => {
				stop();
				list.release();
				reader.release();
			},
		},
		() => `${lineText(shown.info.title)} · ${shown.info.type.toUpperCase()} · v${shown.info.version}`,
	);
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
	const close = () => {
		stop();
		list.release();
		overlay.close();
	};
	// One entry per version: a row is a name and a version.
	const keyOf = (artifact: ArtifactInfo) => `${artifact.name}:${artifact.version}`;
	const byRow = (row: ListRow | undefined) => artifacts.find((artifact) => keyOf(artifact) === row?.key);
	const overlay = ctx.overlay(
		"artifacts",
		new ListOverlay(ctx, {
			title: () => `Artifacts (${artifacts.length})`,
			rows: () =>
				artifacts.map((artifact) => ({
					key: keyOf(artifact),
					label: artifact.title,
					detail: `${artifact.type.toUpperCase()} · v${artifact.version}`,
				})),
			onSelect: (row) => {
				const artifact = byRow(row);
				if (!artifact) return;
				if (!ctx.panel.fits) return showArtifact(ctx, session, artifact);
				close();
				pinArtifact(ctx, session, ctx.identity.conversation, artifact);
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
				ctx.theme.current.fg(
					"dim",
					`  Enter shows it ${ctx.panel.fits ? "beside the chat" : "here"}; Ctrl+B opens it in the browser (${BROWSER_NOTE})`,
				),
			],
			onClose: () => close(),
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
