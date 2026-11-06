// The sheet a run of tool calls opens: p2's own sheet (runtime Sheet) as a route layer, so Back closes it like every
// other sheet. Its first page lists the run's calls, one row each; a call's row opens its detail (Detail.tsx) one
// layer up, and a script's call one more; Back (the browser's, Android's or the header's) leads down again. The
// transcript renders it (`ActivityLayer`), so it follows the run live while the wheel's row is scrolled away.
import { type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { closeLayers, getNavigation, type Layer, Sheet, useSheet } from "../../runtime/web.tsx";
import { ToolActivityContext, WorkingDirectory } from "../chat-context.ts";
import {
	ArtifactIcon,
	BotIcon,
	ChevronIcon,
	CodeIcon,
	CommentIcon,
	FileIcon,
	PencilIcon,
	RefreshIcon,
	SearchIcon,
	TerminalIcon,
	ToolIcon,
} from "../icons.tsx";
import { GroupDetail, StepDetail } from "./Detail.tsx";
import {
	argumentOf,
	type ChatItem,
	describe,
	elapsed,
	groupCalls,
	type Kind,
	type Label,
	type Step,
	stepState,
} from "./model.ts";
import "./activity.css";

type Activity = Extract<ChatItem, { type: "activity" }>;
/** Where the sheet is: the run (its row's key), a call of it, one entry of a script's calls. */
type Place = { row: string; step?: string; group?: number };

const SHEET = "activity";
const layer = (place: Place): Layer => ({ kind: "sheet", name: SHEET, locator: JSON.stringify(place) });

/**
 * Opens a run's calls: its list, and with `step` that call's detail over it (the reader rolled the wheel to it), so
 * Back leads to the list first. Both steps are computed from the route now: queued pushes see it unchanged.
 */
export function openActivity(row: string, step?: string): void {
	const nav = getNavigation();
	const list = { ...nav.route, layers: [...nav.route.layers, layer({ row })] };
	void nav.push(list);
	if (step) void nav.push({ ...list, layers: [...list.layers, layer({ row, step })] });
}

/** One page up within the sheet: a call's detail, a script's call. */
const open = (place: Place) => {
	const nav = getNavigation();
	void nav.push({ ...nav.route, layers: [...nav.route.layers, layer(place)] });
};

/** The page under the top one: what the header's Back does, as the browser's Back would. */
const back = () => void getNavigation().close((route) => ({ ...route, layers: route.layers.slice(0, -1) }));

/** A layer's place: its locator is this module's JSON, read back from the browser's history state. */
function placeOf(locator: string | undefined): Place | undefined {
	try {
		const value: unknown = JSON.parse(locator ?? "");
		if (!value || typeof value !== "object" || !("row" in value) || typeof value.row !== "string") return;
		const { row, step, group } = value as Record<string, unknown>;
		return {
			row: row as string,
			...(typeof step === "string" ? { step } : {}),
			...(typeof group === "number" ? { group } : {}),
		};
	} catch {
		return;
	}
}

/**
 * How long a run has taken: counting while the agent works (from when it was first shown, until its first response says
 * when the work began), the total once it is done; undefined while neither is known.
 */
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

/** The sheet of one of this transcript's runs, while the top layer is one. */
export function ActivityLayer({ rows }: { rows: readonly { item: ChatItem }[] }) {
	const top = useSheet(SHEET);
	const place = top && placeOf(top.locator);
	const item = place && rows.find((row) => row.item.type === "activity" && row.item.key === place.row)?.item;
	return item?.type === "activity" && place ? <ActivitySheet activity={item} place={place} /> : null;
}

/** A label as a page's title: "Ran a script · 3 calls". */
const heading = (label: Label) =>
	[[label.verb, label.object].filter(Boolean).join(" "), label.extra].filter(Boolean).join(" · ");

function ActivitySheet({ activity, place }: { activity: Activity; place: Place }) {
	const tools = useContext(ToolActivityContext);
	const { steps } = activity;
	const step = place.step === undefined ? undefined : steps.find((each) => each.id === place.step);
	const group = step && place.group !== undefined ? groupCalls(step.tool.calls ?? [], tools)[place.group] : undefined;
	const time = useElapsed(activity.startedAt, activity.endedAt, activity.working);
	const count = `${steps.length} ${steps.length === 1 ? "step" : "steps"}`;
	const title = group
		? heading(group.label)
		: step
			? heading(describe(step, tools).label)
			: [count, time].filter(Boolean).join(" · ");
	return (
		<Sheet
			title={title}
			onClose={closeLayers}
			{...(step ? { onBack: back } : {})}
			className="activity-sheet"
			testId="activity-sheet"
		>
			{group ? (
				<div className="activity-detail">
					<GroupDetail group={group} />
				</div>
			) : step ? (
				<div className="activity-detail">
					<StepDetail step={step} onGroup={(index) => open({ row: activity.key, step: step.id, group: index })} />
				</div>
			) : (
				<StepList steps={steps} onStep={(id) => open({ row: activity.key, step: id })} />
			)}
		</Sheet>
	);
}

const ICONS: Record<Kind, () => ReactNode> = {
	command: () => <TerminalIcon />,
	search: () => <SearchIcon />,
	handoff: () => <RefreshIcon />,
	read: () => <FileIcon />,
	edit: () => <PencilIcon />,
	script: () => <CodeIcon />,
	agent: () => <BotIcon />,
	artifact: () => <ArtifactIcon />,
	file: () => <FileIcon />,
	port: () => <ToolIcon />,
	message: () => <CommentIcon />,
	tool: () => <ToolIcon />,
};

/** The run's calls, one row each: icon, the tool and its main argument, how it went, a way into its detail. */
function StepList({ steps, onStep }: { steps: readonly Step[]; onStep: (id: string) => void }) {
	const tools = useContext(ToolActivityContext);
	const cwd = useContext(WorkingDirectory)?.replace(/\/+$/, "");
	const list = useRef<HTMLUListElement>(null);
	// Opened on the newest calls: the reader usually looks for what happened last. Not when the page's remembered
	// scroll position (Back from a call) already placed it.
	useEffect(() => {
		const body = list.current?.parentElement;
		if (body && body.scrollTop === 0) body.scrollTop = body.scrollHeight;
	}, []);
	return (
		<ul className="step-list" data-testid="timeline" ref={list}>
			{steps.map((step) => {
				const argument = argumentOf(step.tool, tools, cwd);
				return (
					<li key={step.id} data-testid="step" data-state={step.status}>
						<button type="button" className="step-row" onClick={() => onStep(step.id)}>
							<span className="step-icon">{ICONS[describe(step, tools).label.kind]()}</span>
							<span className="step-words">
								<span className="step-name">{step.tool.name}</span>
								{argument && <span className="step-argument">{argument}</span>}
							</span>
							<span className="step-state" data-state={step.status}>
								{stepState(step, tools)}
							</span>
							<span className="step-chevron" aria-hidden="true">
								<ChevronIcon size={16} />
							</span>
						</button>
					</li>
				);
			})}
		</ul>
	);
}
