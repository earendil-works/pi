// pi's footer (coding-agent interactive/components/footer.ts) on p2 data, registered as the runtime's `footer` slot.
// Provenance (p2-tui-port.md section 1.16): token and cost stats are the viewed conversation's (`pi.usage`), the cache
// hit rate is its latest committed response's, context tokens are its active-context estimate, and the context window
// comes from the owner's model catalog, else from the conversation's guest-safe model metadata (`Chat.model`, P3);
// without either, tokens show without a percentage. The session total (children and tools included,
// `SessionMetrics`) is labeled "session". `/session` lists the same numbers with their scopes.

import type { Usage } from "@earendil-works/pi-ai";
import type { AgentState, ConversationView, UsageState } from "@earendil-works/pi-durable";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { BACKGROUND_CONTEXT, followRegistry, liveIn } from "@p2/app/v1";
import {
	cacheHitRate,
	formatTokens,
	grantNotice,
	lineText,
	type SessionChild,
	spread,
	TextOverlay,
	type TuiRuntime,
	TuiScope,
	TuiSessionSources,
	type TuiSurface,
	tuiFacet,
} from "@p2/app/v1/tui";
import type { ActiveStats } from "@p2/app/v1/worker";
import { Chat, type ModelMeta } from "../chat/contract.ts";
import { type ModelInfo, Models } from "../models/contract.ts";
import { type Session, Sessions } from "../sessions/contract.ts";
import { SessionMetrics, SessionStatus, WorkerControl } from "./contract.ts";

export { formatTokens };

/** Conversation totals of `pi.usage` (DTUI `totalUsage`): its models' and tools' usage. */
export function conversationUsage(view: ConversationView | null | undefined) {
	const state = view?.docs["pi.usage"] as unknown as UsageState | undefined;
	const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	for (const usage of [...Object.values(state?.models ?? {}), ...Object.values(state?.tools ?? {})]) {
		total.input += usage.input;
		total.output += usage.output;
		total.cacheRead += usage.cacheRead;
		total.cacheWrite += usage.cacheWrite;
		total.cost += usage.cost.total;
	}
	return total;
}

export class FooterSurface implements TuiSurface {
	readonly scope: TuiScope;
	private active: TuiScope | undefined;
	private models: TuiScope | undefined;
	private identity: string | undefined;
	private session: string | undefined;
	private sessions: Session[] = [];
	private catalog: ModelInfo[] = [];
	private view: ConversationView | null | undefined;
	/** The active context's numbers (`Chat.stats`). */
	private stats: ActiveStats | null | undefined;
	private usage: Usage | null | undefined;
	private clients: number | undefined;
	private workerError: string | undefined;
	private model: ModelMeta | null = null;
	private stop: () => void;
	private children: Readonly<Record<string, SessionChild[]>> = {};
	private stopSources: (() => void)[] = [];
	private stopRegistry: () => void;
	readonly runtime: TuiRuntime;
	constructor(runtime: TuiRuntime) {
		this.runtime = runtime;
		this.scope = new TuiScope(runtime);
		// Subagent names for the crumb, from the subagents plugin when it is installed.
		this.stopRegistry = followRegistry(runtime.host, TuiSessionSources, (table) => {
			for (const stop of this.stopSources.splice(0)) stop();
			for (const source of table.values())
				if (source.children)
					this.stopSources.push(
						source.children(runtime, (children) => {
							this.children = children;
							runtime.tui.requestRender();
						}),
					);
		});
		this.scope.watch(Sessions, {}, (ref, follow) => {
			const viewer = liveIn(ref, "owner", "guest");
			if (viewer)
				follow(viewer.sessions, (sessions) => {
					this.sessions = sessions;
				});
		});
		const changed = (): void => {
			// The model catalog is owner-only (plugins/models/server.ts): guests never request it.
			if (runtime.role === "owner" && !this.models) {
				this.models = new TuiScope(runtime);
				this.models.watch(Models, {}, (ref, follow) =>
					follow(ref.models, (models) => {
						this.catalog = models ?? [];
					}),
				);
				// A failed session worker (the web's "Session unavailable" with Retry), owner only.
				this.models.watch(SessionStatus, {}, (ref, follow) => {
					if (ref.variant === "reader")
						follow(ref.statuses, (statuses) => {
							const error = this.session ? statuses[this.session]?.error : undefined;
							if (error && error !== this.workerError)
								runtime.notify(`Session worker failed: ${lineText(error)} · /retry-worker`, "error");
							this.workerError = error;
						});
				});
			}
			if (this.identity === runtime.identity) return;
			this.active?.dispose();
			this.active = undefined;
			this.identity = runtime.identity;
			this.session = runtime.session;
			this.view = undefined;
			this.stats = undefined;
			this.usage = undefined;
			this.clients = undefined;
			this.model = null;
			const session = runtime.session;
			if (!session) return;
			this.active = new TuiScope(runtime);
			this.active.watch(Chat, { session, conversation: runtime.conversation }, (ref, follow) => {
				follow(ref.view, (view) => {
					this.view = view;
				});
				follow(ref.stats, (stats) => {
					this.stats = stats;
				});
				follow(ref.model, (model) => {
					this.model = model ?? null;
				});
			});
			this.active.watch(SessionMetrics, { session, viewer: runtime.name }, (ref, follow) => {
				follow(ref.usage, (usage) => {
					this.usage = usage;
				});
				follow(ref.clients, (clients) => {
					this.clients = clients ?? undefined;
				});
			});
		};
		runtime.listeners.add(changed);
		this.stop = () => runtime.listeners.delete(changed);
		changed();
	}
	/** The viewed conversation's model and thinking level (`pi.agent`). */
	private agent(): AgentState | undefined {
		return this.view?.docs["pi.agent"] as AgentState | undefined;
	}
	render(width: number): string[] {
		const theme = this.runtime.theme.current;
		const session = this.sessions.find((row) => row.id === this.session);
		const agent = this.agent();
		const stats = this.stats;
		// Line 1: where (env:cwd), the session title, and a subagent's conversation.
		let where = session ? `${session.env ? `${session.env}:` : ""}${session.cwd}` : "";
		// pi's `cwd (branch)`: the git branch from a plugin's `footer:` slot (the workspace's), when one is mounted.
		const branch = session ? this.runtime.slots("footer:").flatMap((surface) => surface.render(width))[0] : undefined;
		if (branch) where += ` (${branch})`;
		if (session?.title) where += `${where ? " • " : ""}${session.title}`;
		// The subagent crumb (the web's top-bar crumb): the session › the shown subagent conversation.
		if (this.runtime.conversation !== 1) {
			const child = this.children[this.session ?? ""]?.find(
				(row) => row.conversationId === this.runtime.conversation,
			);
			where += ` › ${child ? child.name : `conversation ${this.runtime.conversation}`}`;
		}
		if (!this.session) where = "No session";
		const pwdLine = truncateToWidth(theme.fg("dim", lineText(where)), width, theme.fg("dim", "..."));
		// Line 2: conversation stats, context, session total; model and thinking on the right.
		const usage = conversationUsage(this.view);
		const parts: string[] = [];
		if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
		if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
		if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
		if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
		const hit = stats?.latestAssistantUsage && cacheHitRate(stats.latestAssistantUsage);
		if ((usage.cacheRead || usage.cacheWrite) && hit !== undefined) parts.push(`CH${(hit * 100).toFixed(1)}%`);
		if (usage.cost) parts.push(`$${usage.cost.toFixed(3)}`);
		const model = agent?.model ?? session?.model;
		const info = this.catalog.find((row) => row.provider === model?.provider && row.modelId === model?.modelId);
		let context = "";
		if (stats) {
			const tokens = stats.contextTokens;
			const window = info?.contextWindow ?? this.model?.contextWindow ?? 0;
			if (window > 0) {
				const percent = (tokens / window) * 100;
				const text = `${percent.toFixed(1)}%/${formatTokens(window)}`;
				context = percent > 90 ? theme.fg("error", text) : percent > 70 ? theme.fg("warning", text) : text;
			} else context = `${formatTokens(tokens)} ctx`;
		}
		if (context) parts.push(context);
		if (this.usage && this.usage.cost.total > usage.cost + 0.0005)
			parts.push(`session $${this.usage.cost.total.toFixed(3)}`);
		const thinking = agent?.thinkingLevel ?? session?.thinkingLevel;
		const modelName = model ? lineText(model.modelId) : "no-model";
		const right = model
			? `${modelName}${thinking ? (thinking === "off" ? " • thinking off" : ` • ${lineText(thinking)}`) : ""}`
			: modelName;
		const withProvider = model ? `(${lineText(model.provider)}) ${right}` : right;
		const left = parts.join(" ");
		const line = spread(left, withProvider, width).includes(withProvider)
			? spread(left, withProvider, width)
			: spread(left, right, width);
		// Dim every part separately: colored context text ends with a reset that would clear an outer dim.
		const styled = line
			.split(context || "\u0000")
			.map((part) => theme.fg("dim", part))
			.join(context);
		return [pwdLine, styled];
	}
	/** `/session`: the footer's numbers with their scopes (section 1.16), and the session's facts. */
	sessionInfo(): string[] {
		const theme = this.runtime.theme.current;
		const session = this.sessions.find((row) => row.id === this.session);
		if (!session) return [theme.fg("muted", "No session")];
		const agent = this.agent();
		const stats = this.stats;
		const usage = conversationUsage(this.view);
		const model = agent?.model ?? session.model;
		const window =
			this.catalog.find((row) => row.provider === model.provider && row.modelId === model.modelId)?.contextWindow ??
			this.model?.contextWindow;
		const row = (label: string, value: string) => `  ${theme.fg("dim", label.padEnd(26))} ${lineText(value)}`;
		const hit = stats?.latestAssistantUsage && cacheHitRate(stats.latestAssistantUsage);
		const tokens = (value: { input: number; output: number; cacheRead: number; cacheWrite: number }) =>
			`↑${formatTokens(value.input)} ↓${formatTokens(value.output)} R${formatTokens(value.cacheRead)} W${formatTokens(value.cacheWrite)}`;
		return [
			theme.bold("Session"),
			row("Title", session.title || "Untitled"),
			row("ID", session.id),
			row("Directory", `${session.env ? `${session.env}:` : ""}${session.cwd}`),
			row("Conversation", String(this.runtime.conversation)),
			row("Model", `${model.provider}/${model.modelId}`),
			row("Thinking", agent?.thinkingLevel ?? session.thinkingLevel),
			row("Viewers", this.clients === undefined ? "?" : String(this.clients)),
			"",
			theme.bold("This conversation"),
			row("Tokens", tokens(usage)),
			row("Cost", `$${usage.cost.toFixed(4)}`),
			row("Cache hit (latest answer)", hit === undefined || !hit ? "-" : `${(hit * 100).toFixed(1)}%`),
			row(
				"Context (estimate)",
				stats
					? `${formatTokens(stats.contextTokens)}${window ? ` of ${formatTokens(window)} (${((stats.contextTokens / window) * 100).toFixed(1)}%)` : ""}`
					: "-",
			),
			"",
			theme.bold("Whole session (children and tools)"),
			row("Tokens", this.usage ? tokens(this.usage) : "-"),
			row("Cost", this.usage ? `$${this.usage.cost.total.toFixed(4)}` : "-"),
		];
	}
	invalidate(): void {}
	dispose(): void {
		this.stop();
		this.stopRegistry();
		for (const stop of this.stopSources.splice(0)) stop();
		this.scope.dispose();
		this.models?.dispose();
		this.active?.dispose();
	}
}
export default tuiFacet("footer", (runtime) => new FooterSurface(runtime), {
	"p2.worker.retry": {
		title: "Retry the session worker",
		category: "Owner",
		when: "owner && !overlay",
		slash: { name: "retry-worker" },
		run: (ctx) => {
			const session = ctx.identity.session;
			if (!session) return;
			return ctx.host.root(async (root) => {
				const control = await root.get(WorkerControl, { session });
				if (control.variant !== "owner") return;
				await control.restart(root);
				ctx.notify("Retrying the session worker");
			}, BACKGROUND_CONTEXT);
		},
	},
	"p2.dev.reload": {
		title: "Reload changed plugins (dev server)",
		category: "Owner",
		when: "owner && !overlay",
		slash: { name: "dev-reload" },
		// The dev channel is an owner HTTP route (`/__p2_dev`) that the launcher reaches with its own sign-in: a
		// launcher action (section 3.2), not a request from this worker.
		// The launcher's consent screen confirms; the server answers with what it reloaded (or why it did not).
		run: async (ctx) => {
			const result = await ctx.grant("devCommand", { action: "reload" });
			const value = result.ok && result.value && typeof result.value === "object" ? result.value : undefined;
			const text = value && "message" in value && typeof value.message === "string" ? lineText(value.message) : "";
			grantNotice(ctx, text.slice(0, 200) || "Plugin reload requested", result);
		},
	},
	"p2.session.info": {
		title: "Session information",
		category: "Session",
		when: "!overlay",
		slash: { name: "session" },
		run: (ctx) => {
			const footer = ctx.surface("footer");
			if (!(footer instanceof FooterSurface)) return;
			const handle = ctx.overlay(
				"session",
				new TextOverlay(
					ctx,
					"Session",
					() => footer.sessionInfo(),
					() => handle.close(),
				),
				{ width: "90%", anchor: "top-center", offsetY: 1 },
			);
		},
	},
});
