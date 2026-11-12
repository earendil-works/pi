// Artifacts in the TUI: `/artifacts` lists the session's artifacts (`Artifacts`); Enter shows one (Markdown rendered,
// an html page as its source) over the chat, or in the side panel when the terminal is wide enough, where it follows
// new versions; Ctrl+B opens an html page in the browser (launcher `openUrl`; the browser needs its own sign-in).
import { Markdown } from "@earendil-works/pi-tui";
import { BACKGROUND_CONTEXT, contribute, defineFacet, follow, liveIn, whenLive } from "@p2/app/v1";
import {
	grantNotice,
	ListOverlay,
	type ListRow,
	lineText,
	safeText,
	TextViewer,
	type TuiCommand,
	TuiCommands,
	type TuiContext,
} from "@p2/app/v1/tui";
import { type ArtifactSummary, Artifacts } from "./contract.ts";

const BROWSER_NOTE = "the browser needs its own sign-in to this server";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The session's artifacts held for one overlay or panel, until released: the live list and reads. */
function holdArtifacts(ctx: TuiContext, session: string) {
	const ref = ctx.host.hold(Artifacts, { session }, BACKGROUND_CONTEXT);
	const reader = whenLive(ref).then(() => {
		const live = liveIn(ref, "reader", "editor");
		if (!live) throw new Error("Artifacts are not available");
		return live;
	});
	let stops: (() => void)[] = [];
	let released = false;
	return {
		read: async (id: string, version: number) => (await reader).read({ id, version }, BACKGROUND_CONTEXT),
		/** Calls `fn` with the list now and at each change, until released. */
		follow: (fn: (list: readonly ArtifactSummary[]) => void): void => {
			void reader.then(
				(live) => {
					if (!released) stops.push(follow(live.artifacts, fn));
				},
				() => fn([]),
			);
		},
		release: () => {
			released = true;
			for (const stop of stops) stop();
			stops = [];
			ref.release();
		},
	};
}

/** One artifact's newest version as lines at a width (Markdown rendered, an html page's source), cached per width. */
class ArtifactLines {
	private content: string | undefined;
	private status = "Loading…";
	private cache: { width: number; lines: string[] } | undefined;
	private readonly ctx: TuiContext;
	summary: ArtifactSummary;
	constructor(ctx: TuiContext, summary: ArtifactSummary) {
		this.ctx = ctx;
		this.summary = summary;
	}
	/** Reads version `summary.version` and shows it once read; the previous version stays shown meanwhile. */
	load(held: ReturnType<typeof holdArtifacts>, summary: ArtifactSummary): void {
		void held
			.read(summary.id, summary.version)
			.then((read) => {
				// Reads may finish out of order: an older version never replaces a newer one.
				if (summary.version < this.summary.version && this.content !== undefined) return;
				this.summary = summary;
				this.status = "";
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
			this.summary.kind === "md"
				? new Markdown(safeText(this.content), 0, 0, this.ctx.theme.markdown).render(width)
				: this.content.split("\n").map((line) => lineText(line));
		const note =
			this.summary.kind === "html"
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

/** An artifact over the chat, or in the side panel when it fits; it follows new versions. */
function showArtifact(ctx: TuiContext, session: string, summary: ArtifactSummary): void {
	const held = holdArtifacts(ctx, session);
	const shown = new ArtifactLines(ctx, summary);
	let loaded = summary.version;
	shown.load(held, summary);
	held.follow((list) => {
		const latest = list.find((each) => each.id === summary.id);
		if (!latest || latest.version <= loaded) return;
		loaded = latest.version;
		shown.load(held, latest);
	});
	const release = () => held.release();
	const title = () =>
		`${lineText(shown.summary.title)} · ${shown.summary.kind.toUpperCase()} · v${shown.summary.version}`;
	if (ctx.panel.fits) {
		ctx.panel.open(
			`artifact:${summary.id}`,
			{ render: (width) => shown.render(width), invalidate: () => shown.invalidate(), dispose: release },
			title,
		);
		return;
	}
	const viewer = ctx.overlay(
		"artifact-view",
		new TextViewer(ctx, {
			title: title(),
			lines: (width) => shown.render(width),
			onClose: () => {
				release();
				viewer.close();
			},
		}),
		{ width: "100%", anchor: "bottom-center" },
	);
}

function openArtifacts(ctx: TuiContext): void {
	const session = ctx.identity.session;
	if (!session) return;
	const held = holdArtifacts(ctx, session);
	let artifacts: readonly ArtifactSummary[] = [];
	held.follow((list) => {
		artifacts = list;
		ctx.requestRender();
	});
	const close = () => {
		held.release();
		overlay.close();
	};
	const byRow = (row: ListRow | undefined) => artifacts.find((artifact) => artifact.id === row?.key);
	const overlay = ctx.overlay(
		"artifacts",
		new ListOverlay(ctx, {
			title: () => `Artifacts (${artifacts.length})`,
			rows: () =>
				artifacts.map((artifact) => ({
					key: artifact.id,
					label: artifact.title,
					detail: `${artifact.kind.toUpperCase()} · v${artifact.version}`,
				})),
			onSelect: (row) => {
				const artifact = byRow(row);
				if (!artifact) return;
				if (ctx.panel.fits) close();
				showArtifact(ctx, session, artifact);
			},
			actions: [
				{
					key: "ctrl+b",
					label: "open in browser",
					run: (row) => {
						const artifact = byRow(row);
						if (artifact?.kind !== "html") return;
						const query = new URLSearchParams({ session, id: artifact.id, version: String(artifact.version) });
						void ctx
							.grant("openUrl", { kind: "origin", path: `/artifact-frame?${query}` })
							.then((result) => grantNotice(ctx, `Opened ${artifact.title} in the browser`, result));
					},
				},
			],
			footer: () => [
				ctx.theme.current.fg(
					"dim",
					`  Enter shows it ${ctx.panel.fits ? "beside the chat" : "here"}; Ctrl+B a page in the browser (${BROWSER_NOTE})`,
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
		self.contribute(TuiCommands, COMMANDS);
	}),
);
