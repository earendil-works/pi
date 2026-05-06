"use client";

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
	Bot,
	Command,
	GitBranch,
	Loader2,
	Moon,
	PanelLeft,
	PanelRight,
	Plus,
	RefreshCw,
	Sparkles,
	Sun,
	TriangleAlert,
	X,
} from "lucide-react";
import type * as React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Composer } from "@/components/pi/composer";
import { InspectorPanel } from "@/components/pi/inspector-panel";
import { MessageView } from "@/components/pi/message-view";
import { ToolActivity, type ToolActivityItem } from "@/components/pi/tool-activity";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import type { ChatImageInput, ChatStreamEvent, WebCommand, WebState } from "@/lib/types";
import { cn, compactText, formatCost } from "@/lib/utils";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null;
}

function isAgentMessage(value: unknown): value is AgentMessage {
	return isRecord(value) && typeof value.role === "string";
}

function eventType(event: unknown): string | undefined {
	return isRecord(event) && typeof event.type === "string" ? event.type : undefined;
}

function textFromToolResult(result: unknown): string | undefined {
	if (!isRecord(result)) return undefined;
	const content = result.content;
	if (!Array.isArray(content)) return undefined;
	return content
		.map((part) => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : ""))
		.join("\n")
		.trim();
}

function messageKey(message: AgentMessage): string {
	const record = message as unknown as JsonRecord;
	return `${String(record.role)}:${String(record.timestamp ?? "pending")}:${String(record.toolCallId ?? "")}`;
}

function upsertMessage(messages: AgentMessage[], next: AgentMessage): AgentMessage[] {
	const key = messageKey(next);
	const index = messages.findIndex((message) => messageKey(message) === key);
	if (index === -1) return [...messages, next];
	return messages.map((message, messageIndex) => (messageIndex === index ? next : message));
}

function updateActivity(items: ToolActivityItem[], next: ToolActivityItem): ToolActivityItem[] {
	const index = items.findIndex((item) => item.id === next.id);
	if (index === -1) return [...items, next];
	return items.map((item, itemIndex) => (itemIndex === index ? { ...item, ...next } : item));
}

function modelLabel(state: WebState | null): string {
	if (!state?.model) return "No model";
	return `${state.model.name || state.model.id}`;
}

function BrandMark(): React.ReactElement {
	return (
		<div className="relative flex size-11 items-center justify-center rounded-2xl border bg-primary text-primary-foreground shadow-xl">
			<div className="absolute inset-1 rounded-[0.9rem] border border-white/12" />
			<Bot className="size-5" />
		</div>
	);
}

function EmptyState({ onPrompt }: { onPrompt: (prompt: string) => void }): React.ReactElement {
	const prompts = [
		"Inspect this repo and explain the architecture.",
		"Find the smallest safe improvement and implement it.",
		"Run the relevant tests and fix what breaks.",
		"Review my uncommitted changes like a maintainer.",
	];
	return (
		<div className="mx-auto flex max-w-3xl flex-col items-center justify-center px-6 py-16 text-center">
			<div className="mb-5 flex size-16 items-center justify-center rounded-[1.35rem] border bg-card shadow-sm backdrop-blur-xl">
				<Sparkles className="size-7 text-accent" />
			</div>
			<h1 className="max-w-2xl text-balance text-4xl font-semibold tracking-tight md:text-5xl">
				A calmer surface for serious agent work.
			</h1>
			<p className="mt-4 max-w-xl text-pretty text-sm leading-7 text-muted-foreground">
				This is pi outside the terminal: same harness, same sessions, same tools, now with room for context,
				streaming, model control, and session management.
			</p>
			<div className="mt-8 grid w-full gap-2 sm:grid-cols-2">
				{prompts.map((prompt) => (
					<button
						key={prompt}
						type="button"
						className="rounded-2xl border bg-card/60 p-4 text-left text-sm shadow-sm backdrop-blur-xl transition hover:-translate-y-0.5 hover:bg-card"
						onClick={() => onPrompt(prompt)}
					>
						{prompt}
					</button>
				))}
			</div>
		</div>
	);
}

function Rail({
	state,
	error,
	onRefresh,
	collapsed,
}: {
	state: WebState | null;
	error?: string;
	onRefresh: () => Promise<void>;
	collapsed: boolean;
}): React.ReactElement {
	const commands = state?.commands.slice(0, 9) ?? [];
	return (
		<aside className={cn("hidden min-h-0 shrink-0 flex-col gap-4 lg:flex", collapsed ? "w-20" : "w-80")}>
			<Card className="glass p-4">
				<div className={cn("flex items-center gap-3", collapsed && "justify-center")}>
					<BrandMark />
					{collapsed ? null : (
						<div className="min-w-0">
							<div className="flex items-center gap-2">
								<h1 className="text-lg font-semibold tracking-tight">pi web</h1>
								<span className="pulse-dot size-2 rounded-full bg-emerald-500" />
							</div>
							<p className="truncate text-xs text-muted-foreground">{state?.cwd ?? "Starting runtime…"}</p>
						</div>
					)}
				</div>
				{collapsed ? null : (
					<>
						<Separator className="my-4" />
						<div className="grid grid-cols-2 gap-2 text-xs">
							<div className="rounded-2xl border bg-background/30 p-3">
								<div className="text-muted-foreground">model</div>
								<div className="mt-1 truncate font-medium">{modelLabel(state)}</div>
							</div>
							<div className="rounded-2xl border bg-background/30 p-3">
								<div className="text-muted-foreground">thinking</div>
								<div className="mt-1 font-medium">{state?.thinkingLevel ?? "—"}</div>
							</div>
						</div>
					</>
				)}
			</Card>

			{collapsed ? null : (
				<>
					{error ? (
						<Card className="border-red-500/20 bg-red-500/10 p-4 text-sm text-red-700 dark:text-red-300">
							<div className="mb-2 flex items-center gap-2 font-medium">
								<TriangleAlert className="size-4" /> Runtime notice
							</div>
							<p>{error}</p>
						</Card>
					) : null}

					<Card className="glass p-4">
						<div className="mb-3 flex items-center justify-between">
							<div className="flex items-center gap-2 text-sm font-semibold">
								<Command className="size-4" /> Slash commands
							</div>
							<Button size="icon-sm" variant="ghost" onClick={() => onRefresh()}>
								<RefreshCw />
							</Button>
						</div>
						<div className="space-y-2">
							{commands.length > 0 ? (
								commands.map((command) => (
									<CommandRow key={`${command.source}-${command.name}`} command={command} />
								))
							) : (
								<div className="rounded-2xl border border-dashed p-4 text-xs text-muted-foreground">
									Project prompt templates and skills appear here.
								</div>
							)}
						</div>
					</Card>

					<Card className="glass p-4">
						<div className="mb-3 flex items-center gap-2 text-sm font-semibold">
							<GitBranch className="size-4" /> Queue
						</div>
						<div className="space-y-2 text-xs">
							<QueueLine label="steering" items={state?.queue.steering ?? []} />
							<QueueLine label="follow-up" items={state?.queue.followUp ?? []} />
						</div>
					</Card>
				</>
			)}
		</aside>
	);
}

function CommandRow({ command }: { command: WebCommand }): React.ReactElement {
	return (
		<div className="rounded-2xl border bg-background/30 p-3 text-xs">
			<div className="flex items-center justify-between gap-2">
				<div className="truncate font-medium">/{command.name}</div>
				<Badge variant="outline">{command.source}</Badge>
			</div>
			{command.description ? (
				<p className="mt-1 text-muted-foreground">{compactText(command.description, 92)}</p>
			) : null}
		</div>
	);
}

function QueueLine({ label, items }: { label: string; items: readonly string[] }): React.ReactElement {
	return (
		<div className="rounded-2xl border bg-background/30 p-3">
			<div className="mb-1 flex items-center justify-between">
				<span className="font-medium">{label}</span>
				<Badge variant="outline">{items.length}</Badge>
			</div>
			<p className="text-muted-foreground">{items[0] ? compactText(items[0], 96) : "empty"}</p>
		</div>
	);
}

function Header({
	state,
	onControl,
	onToggleLeft,
	onToggleRight,
	onToggleTheme,
	theme,
}: {
	state: WebState | null;
	onControl: (body: Record<string, unknown>) => Promise<void>;
	onToggleLeft: () => void;
	onToggleRight: () => void;
	onToggleTheme: () => void;
	theme: "light" | "dark";
}): React.ReactElement {
	return (
		<div className="glass flex items-center justify-between gap-3 rounded-[1.4rem] px-4 py-3">
			<div className="flex min-w-0 items-center gap-3">
				<Button variant="ghost" size="icon-sm" className="hidden lg:inline-flex" onClick={onToggleLeft}>
					<PanelLeft />
				</Button>
				<div className="min-w-0">
					<div className="flex items-center gap-2 text-sm font-semibold">
						<span
							className={cn(
								"size-2 rounded-full",
								state?.isStreaming ? "pulse-dot bg-amber-500" : "bg-emerald-500",
							)}
						/>
						<span className="truncate">{state?.session.name || "Working session"}</span>
					</div>
					<div className="mt-0.5 truncate text-xs text-muted-foreground">
						{modelLabel(state)} · {state?.stats.totalMessages ?? 0} messages · {formatCost(state?.stats.cost)}
					</div>
				</div>
			</div>
			<div className="flex items-center gap-2">
				<Button variant="outline" size="sm" onClick={() => onControl({ action: "newSession" })}>
					<Plus /> New
				</Button>
				<Button variant="ghost" size="icon-sm" onClick={onToggleTheme}>
					{theme === "dark" ? <Sun /> : <Moon />}
				</Button>
				<Button variant="ghost" size="icon-sm" className="hidden xl:inline-flex" onClick={onToggleRight}>
					<PanelRight />
				</Button>
			</div>
		</div>
	);
}

export function PiConsole(): React.ReactElement {
	const [state, setState] = useState<WebState | null>(null);
	const [messages, setMessages] = useState<AgentMessage[]>([]);
	const [activities, setActivities] = useState<ToolActivityItem[]>([]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const [leftCollapsed, setLeftCollapsed] = useState(false);
	const [rightCollapsed, setRightCollapsed] = useState(false);
	const [theme, setTheme] = useState<"light" | "dark">("light");
	const composerRef = useRef<HTMLTextAreaElement | null>(null);
	const bottomRef = useRef<HTMLDivElement | null>(null);

	const syncState = useCallback((next: WebState) => {
		setState(next);
		setMessages(next.messages);
	}, []);

	const refreshState = useCallback(async () => {
		const response = await fetch("/api/state", { cache: "no-store" });
		const body: unknown = await response.json();
		if (!response.ok || !isRecord(body)) {
			throw new Error(isRecord(body) && typeof body.error === "string" ? body.error : "Failed to load state");
		}
		syncState(body as unknown as WebState);
	}, [syncState]);

	useEffect(() => {
		void refreshState().catch((loadError: unknown) =>
			setError(loadError instanceof Error ? loadError.message : String(loadError)),
		);
	}, [refreshState]);

	useEffect(() => {
		const saved = localStorage.getItem("pi-web-theme");
		const nextTheme =
			saved === "dark" || (!saved && window.matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light";
		setTheme(nextTheme);
		document.documentElement.classList.toggle("dark", nextTheme === "dark");
	}, []);

	useEffect(() => {
		bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
	});

	const control = useCallback(
		async (body: Record<string, unknown>) => {
			setBusy(true);
			setError(undefined);
			try {
				const response = await fetch("/api/control", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				});
				const json: unknown = await response.json();
				if (!response.ok || !isRecord(json)) {
					throw new Error(isRecord(json) && typeof json.error === "string" ? json.error : "Control action failed");
				}
				syncState(json as unknown as WebState);
			} catch (controlError) {
				setError(controlError instanceof Error ? controlError.message : String(controlError));
			} finally {
				setBusy(false);
			}
		},
		[syncState],
	);

	const handleStreamEvent = useCallback(
		(event: ChatStreamEvent): void => {
			switch (event.type) {
				case "state":
					syncState(event.state);
					break;
				case "preflight":
					if (!event.success) setError("Prompt was rejected before it reached the model.");
					break;
				case "agent_event": {
					const agentEvent = event.event as unknown;
					const type = eventType(agentEvent);
					if (type === "message_start" || type === "message_update" || type === "message_end") {
						const message = isRecord(agentEvent) ? agentEvent.message : undefined;
						if (isAgentMessage(message)) {
							setMessages((current) => upsertMessage(current, message));
						}
					} else if (type === "queue_update" && isRecord(agentEvent)) {
						setState((current) =>
							current
								? {
										...current,
										queue: {
											steering: Array.isArray(agentEvent.steering)
												? agentEvent.steering.filter((item): item is string => typeof item === "string")
												: [],
											followUp: Array.isArray(agentEvent.followUp)
												? agentEvent.followUp.filter((item): item is string => typeof item === "string")
												: [],
										},
									}
								: current,
						);
					} else if (
						type === "thinking_level_changed" &&
						isRecord(agentEvent) &&
						typeof agentEvent.level === "string"
					) {
						setState((current) =>
							current ? { ...current, thinkingLevel: agentEvent.level as WebState["thinkingLevel"] } : current,
						);
					} else if (type === "tool_execution_start" && isRecord(agentEvent)) {
						setActivities((current) =>
							updateActivity(current, {
								id: String(agentEvent.toolCallId),
								name: typeof agentEvent.toolName === "string" ? agentEvent.toolName : "tool",
								status: "running",
								args: isRecord(agentEvent.args) ? agentEvent.args : undefined,
							}),
						);
					} else if (type === "tool_execution_update" && isRecord(agentEvent)) {
						setActivities((current) =>
							updateActivity(current, {
								id: String(agentEvent.toolCallId),
								name: typeof agentEvent.toolName === "string" ? agentEvent.toolName : "tool",
								status: "running",
								output: textFromToolResult(agentEvent.partialResult),
							}),
						);
					} else if (type === "tool_execution_end" && isRecord(agentEvent)) {
						setActivities((current) =>
							updateActivity(current, {
								id: String(agentEvent.toolCallId),
								name: typeof agentEvent.toolName === "string" ? agentEvent.toolName : "tool",
								status: agentEvent.isError === true ? "error" : "done",
								output: textFromToolResult(agentEvent.result),
							}),
						);
					}
					break;
				}
				case "done":
					syncState(event.state);
					break;
				case "error":
					setError(event.error);
					if (event.state) syncState(event.state);
					break;
			}
		},
		[syncState],
	);

	const submitMessage = useCallback(
		async (message: string, images: ChatImageInput[], streamingBehavior?: "steer" | "followUp") => {
			setBusy(true);
			setError(undefined);
			try {
				const response = await fetch("/api/chat", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ message, images, streamingBehavior }),
				});
				if (!response.ok || !response.body) {
					const body: unknown = await response.json().catch(() => ({}));
					throw new Error(isRecord(body) && typeof body.error === "string" ? body.error : "Prompt failed");
				}
				const reader = response.body.getReader();
				const decoder = new TextDecoder();
				let buffer = "";
				let done = false;
				while (!done) {
					const chunk = await reader.read();
					done = chunk.done;
					buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !done });
					const lines = buffer.split("\n");
					buffer = lines.pop() ?? "";
					for (const line of lines) {
						if (!line.trim()) continue;
						handleStreamEvent(JSON.parse(line) as ChatStreamEvent);
					}
				}
				if (buffer.trim()) handleStreamEvent(JSON.parse(buffer) as ChatStreamEvent);
			} catch (submitError) {
				setError(submitError instanceof Error ? submitError.message : String(submitError));
			} finally {
				setBusy(false);
				void refreshState().catch(() => undefined);
			}
		},
		[handleStreamEvent, refreshState],
	);

	const toggleTheme = useCallback(() => {
		setTheme((current) => {
			const next = current === "dark" ? "light" : "dark";
			document.documentElement.classList.toggle("dark", next === "dark");
			localStorage.setItem("pi-web-theme", next);
			return next;
		});
	}, []);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
				event.preventDefault();
				composerRef.current?.focus();
			}
			if (event.key === "Escape" && state?.isStreaming) {
				void control({ action: "abort" });
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [control, state?.isStreaming]);

	const visibleMessages = useMemo(() => messages.filter(isAgentMessage), [messages]);

	return (
		<div className="relative z-10 flex h-screen p-3 md:p-4">
			<div className="mx-auto flex min-h-0 w-full max-w-[1680px] gap-4">
				<Rail state={state} error={error} onRefresh={refreshState} collapsed={leftCollapsed} />

				<section className="flex min-w-0 flex-1 flex-col gap-4">
					<Header
						state={state}
						onControl={control}
						onToggleLeft={() => setLeftCollapsed((value) => !value)}
						onToggleRight={() => setRightCollapsed((value) => !value)}
						onToggleTheme={toggleTheme}
						theme={theme}
					/>

					<div className="glass min-h-0 flex-1 overflow-hidden rounded-[1.6rem]">
						<div className="flex h-full flex-col">
							<div className="flex-1 overflow-auto p-4 scrollbar-elegant md:p-6">
								{state?.modelFallbackMessage ? (
									<div className="mb-4 rounded-2xl border border-amber-500/20 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200">
										{state.modelFallbackMessage}
									</div>
								) : null}
								{visibleMessages.length === 0 ? (
									<EmptyState onPrompt={(prompt) => void submitMessage(prompt, [])} />
								) : (
									<div className="mx-auto flex max-w-5xl flex-col gap-5">
										{visibleMessages.map((message, index) => (
											<MessageView key={`${messageKey(message)}-${index}`} message={message} />
										))}
										{busy && state?.isStreaming ? (
											<div className="flex items-center gap-2 text-sm text-muted-foreground">
												<Loader2 className="size-4 animate-spin" /> pi is working
											</div>
										) : null}
										<div ref={bottomRef} />
									</div>
								)}
							</div>
							<div className="border-t p-3 md:p-4">
								<Composer
									state={state}
									busy={busy}
									onSubmit={submitMessage}
									onAbort={() => control({ action: "abort" })}
									ref={composerRef}
								/>
							</div>
						</div>
					</div>
				</section>

				{rightCollapsed ? null : (
					<div className="hidden min-h-0 flex-col gap-4 xl:flex">
						<InspectorPanel state={state} onControl={control} busy={busy} />
						<ToolActivity items={activities} />
					</div>
				)}
			</div>

			<div className="fixed bottom-4 left-4 z-20 flex gap-2 lg:hidden">
				<Button variant="outline" size="icon" onClick={() => void refreshState()}>
					<RefreshCw />
				</Button>
				<Button variant="outline" size="icon" onClick={toggleTheme}>
					{theme === "dark" ? <Sun /> : <Moon />}
				</Button>
				{state?.isStreaming ? (
					<Button variant="destructive" size="icon" onClick={() => void control({ action: "abort" })}>
						<X />
					</Button>
				) : (
					<Button variant="outline" size="icon" onClick={() => void control({ action: "newSession" })}>
						<Plus />
					</Button>
				)}
			</div>

			{state ? null : (
				<div className="fixed inset-0 z-30 grid place-items-center bg-background/30 backdrop-blur-sm">
					<Card className="glass flex items-center gap-3 p-5">
						<Loader2 className="size-5 animate-spin" />
						<span className="text-sm font-medium">Starting pi runtime…</span>
					</Card>
				</div>
			)}

			<div className="pointer-events-none fixed bottom-4 right-4 hidden rounded-full border bg-background/60 px-3 py-1 text-xs text-muted-foreground backdrop-blur-xl md:block">
				<kbd>⌘K</kbd> focus · <kbd>⌘↵</kbd> send · <kbd>Esc</kbd> abort
			</div>
		</div>
	);
}
