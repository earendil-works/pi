// The sheet a turn's activity opens (Sheet.tsx): a stack of pages. First the turn's timeline under
// its summary; one page deeper a step's detail (Detail.tsx); for a script one of its calls, or the runs of a repeated
// call, one more.

import { useState } from "react";
import { Drawer } from "../elanor-extra/drawer.tsx";
import { Timeline } from "../elanor-extra/timeline.tsx";
import { GroupDetail, StepDetail } from "./Detail.tsx";
import { KindIcon, LabelText } from "./Label.tsx";
import { describe, groupCalls, type Step, summary } from "./model.ts";
import { Sheet } from "./Sheet.tsx";

/** Opens the timeline at its end, on the newest steps: the reader usually looks for what happened last. */
const atEnd = (page: HTMLDivElement | null) => {
	if (page) page.scrollTop = page.scrollHeight;
};

/** Where the sheet is: the timeline, a step, or one entry of a script's calls. */
type Place = { step?: string; group?: number };

export function ActivitySheet({
	steps,
	open,
	onOpenChange,
	initialStep,
}: {
	steps: readonly Step[];
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Opens on this step's detail, over the timeline (Back leads to it). */
	initialStep?: string;
}) {
	const [place, setPlace] = useState<Place>(() =>
		initialStep && steps.some((each) => each.id === initialStep) ? { step: initialStep } : {},
	);
	const step = steps.find((each) => each.id === place.step);
	const groups = step?.kind === "tool" ? groupCalls(step.tool.calls ?? []) : [];
	const group = place.group === undefined ? undefined : groups[place.group];
	return (
		<Sheet
			testId="activity-sheet"
			open={open}
			onOpenChange={(next) => {
				onOpenChange(next);
				if (!next) setPlace({});
			}}
			onBack={() => setPlace(place.group === undefined ? {} : { step: place.step })}
		>
			<Drawer.Page key="timeline" ref={atEnd} title={summary(steps)} follow={steps.length}>
				<Timeline.Root data-testid="timeline">
					{steps.map((each) => {
						const { label, description, mono } = describe(each);
						return (
							<Timeline.Item
								key={each.id}
								data-testid="step"
								data-state={each.status}
								status={each.status}
								icon={<KindIcon kind={label.kind} />}
								title={<LabelText label={label} />}
								description={description}
								code={mono}
								onClick={() => setPlace({ step: each.id })}
							/>
						);
					})}
				</Timeline.Root>
			</Drawer.Page>
			{step && (
				<Drawer.Page key={`step:${step.id}`} title={<LabelText label={describe(step).label} />}>
					<StepDetail step={step} onGroup={(index) => setPlace({ step: step.id, group: index })} />
				</Drawer.Page>
			)}
			{step && group && (
				<Drawer.Page key={`group:${step.id}:${place.group}`} title={<LabelText label={group.label} />}>
					<GroupDetail group={group} />
				</Drawer.Page>
			)}
		</Sheet>
	);
}
