// A turn's activity in the chat: one row with a large tap target. A wheel of the turn's steps (Elanor's Ticker): while
// the agent works the newest step faces the reader, breathing; a failed step is red. When the turn ends the wheel
// rolls to the summary. The reader can roll it back through the steps; a tap opens the turn's timeline in a sheet
// (ActivitySheet).

import { type ReactNode, useEffect, useId, useState } from "react";
import { Ticker } from "../elanor-extra/ticker.tsx";
import { ActivitySheet } from "./ActivitySheet.tsx";
import { CheckIcon, ChevronIcon, SparkIcon } from "./icons.tsx";
import { KindIcon, LabelText } from "./Label.tsx";
import { live, plain, type Step, summary } from "./model.ts";
import { closePanel, openPanel, usePanelOpen } from "./panel.ts";
import "./activity.css";

/** A step on the wheel: what it shows, its plain words for screen readers, and whether it failed. */
type Face = { key: string; label: string; content: ReactNode; failed?: boolean };

/** A duration as a reader says it: 12s, 1m 05s, 1h 02m. */
export function elapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** How long the turn has taken: counting while the agent works (from when the row appeared, until the first response
 * says when the work began), the total once it is done. */
export function Elapsed({ startedAt, endedAt, working }: { startedAt?: number; endedAt?: number; working: boolean }) {
	const [mounted] = useState(() => Date.now());
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!working) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [working]);
	const start = startedAt ?? (working ? mounted : undefined);
	const end = working ? now : endedAt;
	if (start === undefined || end === undefined) return null;
	return (
		<span className="activity-time" data-testid="activity-time">
			{elapsed(end - start)}
		</span>
	);
}

export function ActivityRow({
	steps,
	working,
	startedAt,
	endedAt,
}: {
	steps: readonly Step[];
	working: boolean;
	startedAt?: number;
	endedAt?: number;
}) {
	// One panel at a time (panel.ts): another turn's steps opening closes these.
	const id = useId();
	const open = usePanelOpen(id);
	const setOpen = (next: boolean) => (next ? openPanel(id) : closePanel(id));
	// The sheet is built when opened (a long transcript has many rows), anew each time (where it opens may differ),
	// and stays for its closing animation.
	const [opening, setOpening] = useState<{ count: number; step?: string }>();
	const done = summary(steps, { failures: false });
	/** Opens the steps: on the timeline, or on a step's detail when the reader rolled the wheel to it. */
	const show = (step?: string) => {
		setOpening((previous) => ({ count: (previous?.count ?? 0) + 1, ...(step ? { step } : {}) }));
		setOpen(true);
	};
	const faces: Face[] = steps.map((step) => {
		const label = live(step);
		return {
			key: step.id,
			label: plain(label),
			failed: step.status === "error",
			content: (
				<>
					<KindIcon kind={label.kind} />
					<LabelText label={label} />
				</>
			),
		};
	});
	if (!steps.length)
		faces.push({
			key: "waiting",
			label: "Working",
			content: (
				<>
					<SparkIcon />
					<span className="label-text">Working…</span>
				</>
			),
		});
	if (!working)
		faces.push({
			key: "done",
			label: done,
			content: (
				<>
					<CheckIcon />
					<span className="label-text">
						{done}
						<span className="label-extra">
							{" "}
							· {steps.length} {steps.length === 1 ? "step" : "steps"}
						</span>
					</span>
				</>
			),
		});
	return (
		<>
			{/* The row: the wheel is the button (a tap opens the steps, a drag rolls it); the rest of the row opens them
			    too, for a pointer. */}
			{/* biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: the wheel inside is the keyboard's control. */}
			<div
				className="activity activity-turn"
				data-testid="activity"
				data-state={working ? "working" : "done"}
				onClick={() => show()}
			>
				<Ticker.Root
					className="activity-ticker"
					active={working}
					onActivate={show}
					aria-label={`${faces.at(-1)?.label ?? "Working"}. Show the turn's steps`}
				>
					{faces.map((face) => (
						<Ticker.Item key={face.key} label={face.label} negative={face.failed}>
							{face.content}
						</Ticker.Item>
					))}
				</Ticker.Root>
				<Elapsed startedAt={startedAt} endedAt={endedAt} working={working} />
				<span className="activity-chevron" aria-hidden="true">
					<ChevronIcon />
				</span>
			</div>
			{opening && (
				<ActivitySheet
					key={opening.count}
					steps={steps}
					open={open}
					onOpenChange={setOpen}
					{...(opening.step ? { initialStep: opening.step } : {})}
				/>
			)}
		</>
	);
}
