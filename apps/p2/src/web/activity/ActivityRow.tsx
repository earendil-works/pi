// A run of tool calls in the chat: one row with a large tap target. A wheel of the run's calls (Elanor's Ticker): while
// the agent works the newest call faces the reader, breathing; a failed call is red. When the run ends the wheel rolls
// to the summary. The reader can roll it back through the calls; a tap opens them in a sheet (ActivitySheet), on the
// call the wheel shows when the reader rolled it there.

import { type MouseEvent, type ReactNode, useContext } from "react";
import { ToolActivityContext } from "../chat-context.ts";
import { Ticker } from "../elanor-extra/ticker.tsx";
import { openActivity, useElapsed } from "./ActivitySheet.tsx";
import { CheckIcon, ChevronIcon, SparkIcon } from "./icons.tsx";
import { KindIcon, LabelText } from "./Label.tsx";
import { live, plain, type Step, summary } from "./model.ts";
import "./activity.css";

/** A step on the wheel: what it shows, its plain words for screen readers, and whether it failed. */
type Face = { key: string; label: string; content: ReactNode; failed?: boolean };

/** How long the run has taken: counting while the agent works, the total once it is done. */
export function Elapsed({ startedAt, endedAt, working }: { startedAt?: number; endedAt?: number; working: boolean }) {
	const time = useElapsed(startedAt, endedAt, working);
	if (time === undefined) return null;
	return (
		<span className="activity-time" data-testid="activity-time">
			{time}
		</span>
	);
}

export function ActivityRow({
	rowKey,
	steps,
	working,
	startedAt,
	endedAt,
}: {
	/** The row's key: the sheet's route layer names it. */
	rowKey: string;
	steps: readonly Step[];
	working: boolean;
	startedAt?: number;
	endedAt?: number;
}) {
	const tools = useContext(ToolActivityContext);
	const done = summary(steps, tools, { failures: false });
	/** Opens the calls: the list, or a call's detail over it when the reader rolled the wheel to that call. */
	const show = (step?: string) => openActivity(rowKey, steps.some((each) => each.id === step) ? step : undefined);
	/** A tap beside the wheel; the wheel's own tap (its button) is `onActivate`. */
	const tap = (event: MouseEvent) => {
		if (!(event.target instanceof Element && event.target.closest(".activity-ticker"))) show();
	};
	const faces: Face[] = steps.map((step) => {
		const label = live(step, tools);
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
		// The row: the wheel is the button (a tap opens the calls, a drag rolls it); the rest of the row opens them
		// too, for a pointer.
		// biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: the wheel inside is the keyboard's control.
		<div
			className="activity activity-turn"
			data-testid="activity"
			data-state={working ? "working" : "done"}
			onClick={tap}
		>
			<Ticker.Root
				className="activity-ticker"
				active={working}
				onActivate={show}
				aria-label={`${faces.at(-1)?.label ?? "Working"}. Show the steps`}
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
	);
}
