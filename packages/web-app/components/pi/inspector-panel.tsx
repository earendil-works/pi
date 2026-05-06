import { Activity, Brain, CircleDollarSign, Command, Gauge, Hammer, Layers3, ListTree, RotateCcw } from "lucide-react";
import type * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Select } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import type { WebState } from "@/lib/types";
import { compactText, formatCost, formatNumber, timeAgo } from "@/lib/utils";

interface InspectorPanelProps {
	state: WebState | null;
	onControl: (body: Record<string, unknown>) => Promise<void>;
	busy: boolean;
}

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }): React.ReactElement {
	return (
		<div className="rounded-2xl border bg-background/35 p-3">
			<div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
				{icon}
				{label}
			</div>
			<div className="text-sm font-semibold">{value}</div>
		</div>
	);
}

export function InspectorPanel({ state, onControl, busy }: InspectorPanelProps): React.ReactElement {
	const modelValue = state?.model ? `${state.model.provider}:::${state.model.id}` : "";
	const contextPercent = state?.stats.contextUsage?.percent ?? null;
	const thinkingOptions = state?.availableThinkingLevels.map((level) => ({ value: level, label: level })) ?? [];
	const modelOptions =
		state?.availableModels.map((model) => ({
			value: `${model.provider}:::${model.id}`,
			label: `${model.name || model.id} · ${model.provider}`,
		})) ?? [];

	return (
		<aside className="hidden min-h-0 w-[22rem] shrink-0 flex-col gap-4 xl:flex">
			<Card className="glass p-4">
				<div className="mb-4 flex items-start justify-between gap-3">
					<div>
						<h2 className="text-sm font-semibold">Harness</h2>
						<p className="mt-1 text-xs text-muted-foreground">{state ? state.cwd : "Connecting…"}</p>
					</div>
					<Badge variant={state?.isStreaming ? "warning" : "success"}>
						{state?.isStreaming ? "working" : "ready"}
					</Badge>
				</div>
				<div className="space-y-3">
					<Select
						value={modelValue}
						disabled={!state || modelOptions.length === 0 || busy}
						placeholder="No authenticated model"
						options={modelOptions}
						onChange={(event) => {
							const [provider, modelId] = event.target.value.split(":::");
							if (provider && modelId) void onControl({ action: "setModel", provider, modelId });
						}}
					/>
					<div className="grid grid-cols-2 gap-2">
						<Select
							value={state?.thinkingLevel ?? "off"}
							disabled={!state || busy}
							options={thinkingOptions}
							onChange={(event) => void onControl({ action: "setThinkingLevel", level: event.target.value })}
						/>
						<Button
							variant="outline"
							disabled={!state || busy}
							onClick={() => onControl({ action: "cycleModel" })}
						>
							<RotateCcw /> Cycle
						</Button>
					</div>
				</div>
			</Card>

			<Card className="glass p-4">
				<div className="mb-3 flex items-center justify-between">
					<h2 className="text-sm font-semibold">Session</h2>
					<Badge variant="outline">{state?.session.id.slice(0, 8) ?? "—"}</Badge>
				</div>
				<div className="grid grid-cols-2 gap-2">
					<StatCard
						icon={<Activity className="size-3.5" />}
						label="messages"
						value={formatNumber(state?.stats.totalMessages)}
					/>
					<StatCard
						icon={<Hammer className="size-3.5" />}
						label="tools"
						value={formatNumber(state?.stats.toolCalls)}
					/>
					<StatCard
						icon={<Brain className="size-3.5" />}
						label="tokens"
						value={formatNumber(state?.stats.tokens.total)}
					/>
					<StatCard
						icon={<CircleDollarSign className="size-3.5" />}
						label="cost"
						value={formatCost(state?.stats.cost)}
					/>
				</div>
				<div className="mt-4 space-y-2">
					<div className="flex items-center justify-between text-xs text-muted-foreground">
						<span className="flex items-center gap-1.5">
							<Gauge className="size-3" /> context
						</span>
						<span>{contextPercent === null ? "unknown" : `${contextPercent.toFixed(1)}%`}</span>
					</div>
					<Progress value={contextPercent} />
				</div>
			</Card>

			<Card className="glass min-h-0 flex-1 overflow-hidden p-4">
				<div className="mb-3 flex items-center justify-between">
					<h2 className="text-sm font-semibold">Sessions</h2>
					<Button size="sm" variant="outline" disabled={busy} onClick={() => onControl({ action: "newSession" })}>
						New
					</Button>
				</div>
				<div className="max-h-64 space-y-2 overflow-auto pr-1 scrollbar-elegant">
					{state?.sessions.length ? (
						state.sessions.map((session) => (
							<button
								key={session.path}
								type="button"
								disabled={busy || session.path === state.session.file}
								onClick={() => onControl({ action: "switchSession", sessionPath: session.path })}
								className="w-full rounded-2xl border bg-background/30 p-3 text-left text-xs transition hover:bg-secondary/45 disabled:opacity-60"
							>
								<div className="mb-1 flex items-center justify-between gap-2 font-medium">
									<span className="truncate">
										{session.name || compactText(session.firstMessage || "Untitled", 46)}
									</span>
									<span className="shrink-0 text-muted-foreground">{timeAgo(session.modified)}</span>
								</div>
								<div className="text-muted-foreground">
									{session.messageCount} messages · {session.id.slice(0, 8)}
								</div>
							</button>
						))
					) : (
						<div className="rounded-2xl border border-dashed p-4 text-xs text-muted-foreground">
							No saved sessions yet.
						</div>
					)}
				</div>
			</Card>

			<Card className="glass p-4">
				<div className="mb-3 grid grid-cols-2 gap-2 text-xs">
					<div className="rounded-2xl border bg-background/30 p-3">
						<div className="mb-1 flex items-center gap-2 text-muted-foreground">
							<Command className="size-3" /> commands
						</div>
						<div className="font-semibold">{state?.commands.length ?? 0}</div>
					</div>
					<div className="rounded-2xl border bg-background/30 p-3">
						<div className="mb-1 flex items-center gap-2 text-muted-foreground">
							<Layers3 className="size-3" /> active tools
						</div>
						<div className="font-semibold">{state?.tools.filter((tool) => tool.active).length ?? 0}</div>
					</div>
				</div>
				<Separator className="my-3" />
				<div className="flex items-center gap-2 text-xs text-muted-foreground">
					<ListTree className="size-3" /> Tree navigation is preserved in session files; branch UI can build on the
					exposed API.
				</div>
			</Card>
		</aside>
	);
}
