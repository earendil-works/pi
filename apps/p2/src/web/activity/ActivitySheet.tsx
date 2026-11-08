// A transcript block's activity in the right-hand panel, or p2's sheet on phones. Steps expand in place; choosing
// another block in the transcript replaces the panel's selection. Opening and closing it participate in Back.
import type { ImageContent } from "@earendil-works/pi-ai";
import { type ReactNode, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { getNavigation, Sheet, useRoute, useScrollMemory } from "../../runtime/web.tsx";
import { ToolActivityContext, WorkingDirectory } from "../chat-context.ts";
import { CloseIcon } from "../icons.tsx";
import type { Route } from "../navigation.ts";
import { clockTime, Time } from "../Time.tsx";
import { DetailProse, imageUrl, StepDetail } from "./Detail.tsx";
import { ChevronIcon, CommentIcon, SparkIcon } from "./icons.tsx";
import { KindIcon } from "./Label.tsx";
import {
	argumentOf,
	type ChatItem,
	describe,
	elapsed,
	plainText,
	sentence,
	stepState,
	type WheelEntry,
} from "./model.ts";
import "./activity.css";

type Activity = Extract<ChatItem, { type: "activity" }>;
type Place = NonNullable<Route["activity"]>;

/** Opens a block in the panel, optionally expanding the step selected on its wheel. */
export function openActivity(row: string, step?: string): void {
	const nav = getNavigation();
	const next = { ...nav.route, workspace: undefined, activity: { row, ...(step ? { step } : {}) } };
	// Switching blocks is a selection, not a growing stack of panels to close.
	if (nav.route.activity && !nav.route.workspace) void nav.replace(next);
	else void nav.push(next);
}

/** Closes only the activity panel, returning to the screen beneath it. */
function closeActivity(): void {
	void getNavigation().close((route) => ({ ...route, activity: undefined }));
}

/** A live duration, or the total once the run is done; unknown without either endpoint. */
export function useElapsed(startedAt: number | undefined, endedAt: number | undefined, working: boolean) {
	const [mounted] = useState(() => Date.now());
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!working) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [working]);
	const start = startedAt ?? (working ? mounted : undefined);
	const end = working ? now : endedAt;
	return start === undefined || end === undefined ? undefined : elapsed(end - start);
}

const wideSnapshot = () => window.matchMedia("(min-width: 700px)").matches;
const subscribeWidth = (changed: () => void) => {
	const media = window.matchMedia("(min-width: 700px)");
	media.addEventListener("change", changed);
	return () => media.removeEventListener("change", changed);
};

/** Keeps the selected block live even when its virtualized transcript row is offscreen. */
export function ActivityLayer({ rows }: { rows: readonly { item: ChatItem }[] }) {
	const route = useRoute();
	const place = route.activity;
	const wide = useSyncExternalStore(subscribeWidth, wideSnapshot);
	const [expanded, setExpanded] = useState<ReadonlyMap<string, ReadonlySet<string>>>(new Map());
	const item =
		place &&
		(rows.find((row) => row.item.type === "activity" && row.item.key === place.row)?.item ??
			(place.step
				? rows.find(
						(row) =>
							row.item.type === "activity" &&
							(row.item.steps.some((step) => step.id === place.step) ||
								row.item.entries?.some((entry) => entry.kind !== "call" && entry.id === place.step)),
					)?.item
				: undefined));
	if (!place || item?.type !== "activity" || route.workspace || (!wide && route.layers.length)) return null;
	const panel = (
		<ActivityPanel
			key={item.key}
			activity={item}
			place={place}
			wide={wide}
			expanded={expanded.get(item.key)}
			onExpanded={(steps) => setExpanded((before) => new Map(before).set(item.key, steps))}
		/>
	);
	if (!wide) return panel;
	const dock = document.getElementById("activity-dock");
	return dock ? createPortal(panel, dock) : null;
}

function ActivityPanel({
	activity,
	place,
	wide,
	expanded,
	onExpanded,
}: {
	activity: Activity;
	place: Place;
	wide: boolean;
	expanded: ReadonlySet<string> | undefined;
	onExpanded: (steps: ReadonlySet<string>) => void;
}) {
	const entries = activity.entries ?? activity.steps.map((step): WheelEntry => ({ kind: "call", step }));
	const running = entries.findLast((entry) => entry.kind === "call" && entry.step.status === "running");
	const initial = place.step ?? (running?.kind === "call" ? running.step.id : undefined);
	const open = expanded ?? new Set(initial ? [initial] : []);
	const body = useRef<HTMLDivElement>(null);
	const following = useRef(!place.step);
	const mounted = useRef(false);
	const revealed = useRef<string>(undefined);
	const time = useElapsed(activity.startedAt, activity.endedAt, activity.working);
	const count = `${entries.length} ${entries.length === 1 ? "step" : "steps"}`;
	useScrollMemory(body);
	useEffect(() => {
		if (!wide) return;
		const key = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.defaultPrevented || getNavigation().route.layers.length) return;
			event.preventDefault();
			closeActivity();
		};
		window.addEventListener("keydown", key);
		return () => window.removeEventListener("keydown", key);
	}, [wide]);
	useLayoutEffect(() => {
		const element = body.current;
		if (!element) return;
		const reveal = !mounted.current ? initial : place.step !== revealed.current ? place.step : undefined;
		if (!mounted.current && element.scrollTop > 0) following.current = false;
		if (following.current) element.scrollTop = element.scrollHeight;
		if (reveal) {
			const row = Array.from(element.querySelectorAll<HTMLElement>("[data-step-id]")).find(
				(each) => each.dataset.stepId === reveal,
			);
			// Keep the expanded call's header reachable even when its output is taller than the panel.
			row?.querySelector("button")?.scrollIntoView({ block: "nearest" });
			following.current = element.scrollHeight - element.clientHeight - element.scrollTop < 24;
		}
		revealed.current = place.step;
		mounted.current = true;
	});
	// A different face selected on the same block's wheel reveals that step without closing other details.
	// biome-ignore lint/correctness/useExhaustiveDependencies: selecting a face, not each manual expansion.
	useEffect(() => {
		if (place.step && !open.has(place.step)) onExpanded(new Set(open).add(place.step));
	}, [place.step]);
	const content = (
		<div
			className="activity-panel-body"
			ref={body}
			onScroll={() => {
				const element = body.current;
				if (element) following.current = element.scrollHeight - element.clientHeight - element.scrollTop < 24;
			}}
		>
			<StepList
				entries={entries}
				expanded={open}
				onStep={(id) => {
					following.current = false;
					const next = new Set(open);
					if (next.has(id)) next.delete(id);
					else next.add(id);
					onExpanded(next);
				}}
			/>
			{!entries.length && <p className="empty-note">Working…</p>}
		</div>
	);
	if (!wide)
		return (
			<Sheet
				title={[count, time].filter(Boolean).join(" · ")}
				onClose={closeActivity}
				className="activity-sheet"
				testId="activity-sheet"
			>
				{content}
			</Sheet>
		);
	return (
		<aside className="activity-panel" aria-label="Activity" data-testid="activity-sheet">
			<header className="activity-panel-head sheet-head">
				<h2>Activity</h2>
				<span className="activity-panel-meta">{[count, time].filter(Boolean).join(" · ")}</span>
				<button type="button" className="icon-button" onClick={closeActivity} aria-label="Close">
					<CloseIcon />
				</button>
			</header>
			{content}
		</aside>
	);
}

const WORDS = { thought: "Thought", text: "Note" } as const;

/** Thumbnails a collapsed row shows at most: the newest, the rest counted. */
const THUMBNAILS = { phone: 2, wide: 4 } as const;

/**
 * A step's images as small thumbnails in its row (what a read loaded, a script's `image()`), so the reader sees them
 * without expanding it: the last four, two below 700px, "+N" for the earlier ones. Decoration only: the row's name
 * stays its words. Both counts are rendered and CSS shows the one for the width (activity.css), so the transcript's
 * rows at detail 4 follow the same breakpoint as the panel.
 */
function StepThumbnails({ images }: { images: readonly ImageContent[] }) {
	if (!images.length) return null;
	return (
		<span className="step-thumbs" data-testid="step-thumbs" aria-hidden="true">
			{(["phone", "wide"] as const).map((width) =>
				images.length > THUMBNAILS[width] ? (
					<span key={width} className="step-thumbs-more" data-width={width}>
						+{images.length - THUMBNAILS[width]}
					</span>
				) : null,
			)}
			{images.slice(-THUMBNAILS.wide).map((image, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: a result's images never move.
				<img key={index} className="step-thumb" src={imageUrl(image)} alt="" decoding="async" />
			))}
		</span>
	);
}

/**
 * A block's steps, each with its images as thumbnails and, under its state, when it started: only where the clock
 * shows another minute than the step before it, so a run within a minute names its time once. In the panel their
 * details expand beneath their headers.
 */
export function StepList({
	entries,
	onStep,
	expanded,
}: {
	entries: readonly WheelEntry[];
	onStep: (id: string) => void;
	expanded?: ReadonlySet<string>;
}) {
	const tools = useContext(ToolActivityContext);
	const cwd = useContext(WorkingDirectory)?.replace(/\/+$/, "");
	let shownTime: string | undefined;
	return (
		<ul className="step-list" data-testid="timeline">
			{entries.map((entry) => {
				const step = entry.kind === "call" ? entry.step : undefined;
				const at = step?.tool.at;
				const label = at === undefined ? undefined : clockTime(at);
				const time = label === shownTime ? undefined : at;
				if (label) shownTime = label;
				const id = entry.kind === "call" ? entry.step.id : entry.id;
				const open = expanded?.has(id) ?? false;
				const argument = step
					? argumentOf(step.tool, tools, cwd)
					: plainText(sentence(entry.kind !== "call" ? entry.text : ""));
				const icon: ReactNode = step ? (
					<KindIcon kind={describe(step, tools).label.kind} />
				) : entry.kind === "thought" ? (
					<SparkIcon size={16} />
				) : (
					<CommentIcon />
				);
				return (
					<li
						key={id}
						data-testid="step"
						data-step-id={id}
						data-state={step?.status ?? "done"}
						data-kind={entry.kind === "call" ? undefined : entry.kind}
					>
						<button
							type="button"
							className="step-row"
							onClick={() => onStep(id)}
							aria-expanded={expanded ? open : undefined}
						>
							<span className="step-icon">{icon}</span>
							<span className="step-words">
								<span className="step-name">
									{step ? step.tool.name : WORDS[entry.kind === "thought" ? "thought" : "text"]}
								</span>
								{argument && <span className="step-argument">{argument}</span>}
							</span>
							{step && <StepThumbnails images={step.tool.images} />}
							<span className="step-end">
								<span className="step-state" data-state={step?.status ?? "done"}>
									{step ? stepState(step, tools) : entry.kind !== "call" && entry.live ? "● thinking" : ""}
								</span>
								{time !== undefined && <Time at={time} className="step-time" />}
							</span>
							<span className="step-chevron" aria-hidden="true">
								<ChevronIcon size={16} />
							</span>
						</button>
						{open && (
							<div className="activity-detail">
								{step ? (
									<StepDetail step={step} />
								) : entry.kind !== "call" ? (
									<DetailProse text={entry.text} />
								) : null}
							</div>
						)}
					</li>
				);
			})}
		</ul>
	);
}
