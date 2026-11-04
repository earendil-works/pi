// Owner diagnostics in the TUI (p2-tui-port.md P11d), after the web's logs sheet and owner notice lane: `/logs`
// shows a log source (server, terminals, dev supervisor, session workers) and follows its tail; owner notices from
// the server (`LogNotices`) become status lines as they arrive, and `/notices` lists and dismisses them. Owner only:
// guests never acquire these objects.

import type { Held } from "@p2/app/v1";
import { BACKGROUND_CONTEXT, contribute, defineFacet, follow, liveIn, whenLive } from "@p2/app/v1";
import type { TuiContext } from "@p2/app/v1/tui";
import {
	ListOverlay,
	lineText,
	type TuiCommand,
	TuiCommands,
	type TuiRuntime,
	TuiScope,
	TuiSlots,
	type TuiSurface,
} from "@p2/app/v1/tui";
import { type LogLine, LogNotices, Logs } from "./contract.ts";

type Notice = { id: number; time: number; source: string; message: string };

/** The web's `sourceLabel`. */
function sourceLabel(source: string): string {
	if (source.startsWith("session:")) return `Worker ${source.slice(8)}`;
	return source === "dev" ? "Dev supervisor" : source === "terminals" ? "Terminal host" : "Server";
}

/** Owner notices as they arrive (a non-screen slot); the list for `/notices`. */
export class NoticeWatch implements TuiSurface {
	readonly runtime: TuiRuntime;
	private scope: TuiScope | undefined;
	private service: () => Held<typeof LogNotices> | undefined = () => undefined;
	notices: Notice[] = [];
	private seen = new Set<number>();
	private first = true;
	private stop: () => void;
	constructor(runtime: TuiRuntime) {
		this.runtime = runtime;
		const changed = (): void => {
			if (runtime.role !== "owner" || this.scope) return;
			this.scope = new TuiScope(runtime);
			this.service = this.scope.watch(LogNotices, {}, (ref, follow) =>
				follow(ref.notices, (notices) => this.arrived(notices ?? [])),
			);
		};
		runtime.listeners.add(changed);
		this.stop = () => runtime.listeners.delete(changed);
		changed();
	}
	private arrived(notices: Notice[]): void {
		this.notices = notices;
		const fresh = notices.filter((notice) => !this.seen.has(notice.id));
		for (const notice of notices) this.seen.add(notice.id);
		if (!fresh.length) return;
		// Notices pending from before this TUI opened are summarized once; later ones show as they arrive.
		if (this.first)
			this.runtime.notify(`${fresh.length} owner notice${fresh.length === 1 ? "" : "s"} · /notices`, "warning");
		else
			for (const notice of fresh)
				this.runtime.notify(`${sourceLabel(notice.source)}: ${lineText(notice.message)}`, "warning");
		this.first = false;
	}
	owner(): Held<typeof LogNotices> | undefined {
		const ref = this.service();
		return liveIn(ref, "owner");
	}
	render(): string[] {
		return [];
	}
	invalidate(): void {}
	dispose(): void {
		this.stop();
		this.scope?.dispose();
	}
}

const WATCH = "service:notices";
const watchOf = (ctx: TuiContext): NoticeWatch | undefined => {
	const surface = ctx.surface(WATCH);
	return surface instanceof NoticeWatch ? surface : undefined;
};
const time = (ms: number) => new Date(ms).toLocaleTimeString();

function openNotices(ctx: TuiContext): void {
	const watch = watchOf(ctx);
	if (!watch) return;
	const handle = ctx.overlay(
		"notices",
		new ListOverlay(ctx, {
			title: () => `Owner notices (${watch.notices.length})`,
			rows: () =>
				watch.notices.map((notice) => ({
					key: String(notice.id),
					label: notice.message,
					detail: `${sourceLabel(notice.source)} ${time(notice.time)}`,
					description: notice.message,
					color: "warning" as const,
				})),
			actions: [
				{
					id: "app.session.delete",
					label: "dismiss",
					run: (row) => {
						const service = watch.owner();
						if (row && service?.variant === "owner")
							void service
								.dismiss({ id: Number(row.key) }, BACKGROUND_CONTEXT)
								.catch((error: unknown) => ctx.notify(String(error), "error"));
					},
				},
			],
			onClose: () => handle.close(),
		}),
		{ width: "100%", anchor: "bottom-center" },
	);
}

/** `/logs [source]`: a source's lines, newest at the bottom; Tab picks another source. */
function openLogs(ctx: TuiContext, initial: string | undefined): void {
	let source = initial?.trim() || (ctx.identity.session ? `session:${ctx.identity.session}` : "server");
	let ref: Held<typeof Logs> | undefined;
	let lines: LogLine[] = [];
	let sources: string[] = [];
	let stops: (() => void)[] = [];
	const acquire = () => {
		for (const stop of stops.splice(0)) stop();
		ref?.release();
		lines = [];
		ref = ctx.host.hold(Logs, { source }, BACKGROUND_CONTEXT);
		const current = ref;
		stops = [
			follow(current.lines, (value) => {
				lines = value ?? [];
				ctx.requestRender();
			}),
			follow(current.sources, (value) => {
				sources = [...new Set(["server", "terminals", "dev", source, ...(value ?? []).map((entry) => entry.id)])];
				ctx.requestRender();
			}),
		];
		void whenLive(current).catch((error: unknown) =>
			ctx.notify(error instanceof Error ? error.message : String(error), "error"),
		);
	};
	acquire();
	const overlay = ctx.overlay(
		"logs",
		new ListOverlay(ctx, {
			title: () => `Logs · ${sourceLabel(source)} (${lines.length} line${lines.length === 1 ? "" : "s"})`,
			rows: () =>
				lines.map((line) => ({
					key: String(line.id),
					label: line.text,
					detail: `${line.level} ${time(line.time)}`,
					...(line.level === "stderr" || line.level === "error" ? { color: "error" as const } : {}),
				})),
			// The newest line selected: the list follows the tail until the reader moves up.
			follow: true,
			height: 18,
			actions: [
				{
					id: "tui.input.tab",
					label: "next source",
					run: () => {
						const next = sources[(sources.indexOf(source) + 1) % Math.max(1, sources.length)];
						if (!next || next === source) return;
						source = next;
						acquire();
					},
				},
			],
			onClose: () => {
				for (const stop of stops.splice(0)) stop();
				ref?.release();
				overlay.close();
			},
		}),
		{ width: "100%", anchor: "bottom-center" },
	);
}

export const LOG_COMMANDS: Record<string, TuiCommand> = {
	"p2.logs": {
		title: "Logs",
		category: "Owner",
		when: "owner && !overlay",
		slash: { name: "logs", argumentHint: "[source]" },
		run: (ctx, args) => openLogs(ctx, args),
	},
	"p2.notices": {
		title: "Owner notices",
		category: "Owner",
		when: "owner && !overlay",
		slash: { name: "notices" },
		run: (ctx) => openNotices(ctx),
	},
};

export default defineFacet((host) =>
	contribute(host, "p2.tui-logs", (self) => {
		self.contribute(TuiSlots, { [WATCH]: (runtime: TuiRuntime): TuiSurface => new NoticeWatch(runtime) });
		self.contribute(TuiCommands, LOG_COMMANDS);
	}),
);
