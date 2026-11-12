// How the artifact tools show in the chat (nested in code mode's card): what each did with which artifact, and for
// `artifact_show` the artifact itself in place, right after the call (its pane, inline), mounted only while it is on
// screen so a long transcript runs no more pages than the person sees.
import {
	detailsOf,
	failureOf,
	SessionId,
	type Step,
	stringOf,
	type ToolActivity,
	type ToolView,
	useRegistry,
	ViewKinds,
} from "@p2/app/v1/web";
import { useContext, useEffect, useRef, useState } from "react";
import { useArtifacts } from "./use-artifacts.ts";

/** The artifact a call names: its ID from its arguments or its result. */
const idOf = (tool: ToolView): string => stringOf(tool.args.id) || stringOf(detailsOf(tool).id);

/** The activity of one artifact tool: its past and present words, naming the artifact when `named`. */
function artifactTool(done: string, doing: string, kind: "read" | "artifact", named = true): ToolActivity {
	const object = (step: Step) => (named ? stringOf(step.tool.args.title) || idOf(step.tool) : "");
	return {
		brief: "Working on artifacts",
		describe(step) {
			const name = object(step);
			return {
				label: { kind, verb: done, ...(name ? { object: name, style: "words" as const } : {}) },
				...(failureOf(step) ? { description: failureOf(step) } : {}),
			};
		},
		running(step) {
			const name = object(step);
			return { kind, verb: doing, ...(name ? { object: name, style: "words" as const } : {}) };
		},
		argument: (tool) => (named ? stringOf(tool.args.title) || idOf(tool) : ""),
		summary: (count) => (count === 1 ? "worked on an artifact" : `worked on artifacts ${count} times`),
	};
}

/** The artifact `artifact_show` named, in place: its pane inline, once it is (nearly) on screen. */
function ShownArtifact({ tool }: { tool: ToolView; inline: boolean }) {
	const session = useContext(SessionId);
	const id = idOf(tool);
	if (!session || !id) return null;
	return <InlineArtifact session={session} id={id} />;
}

/** The pane of artifact `id` in the transcript, mounted only while visible (its height kept while it is not). */
export function InlineArtifact({ session, id }: { session: string; id: string }) {
	const box = useRef<HTMLDivElement>(null);
	const [visible, setVisible] = useState(false);
	const [height, setHeight] = useState<number>();
	const { list } = useArtifacts(session);
	const kinds = useRegistry(ViewKinds);
	useEffect(() => {
		const element = box.current;
		if (!element) return;
		const observer = new IntersectionObserver(
			([entry]) => {
				if (!entry) return;
				// Leaving the screen keeps the pane's last height, so the transcript does not jump.
				if (!entry.isIntersecting) setHeight(element.getBoundingClientRect().height || undefined);
				setVisible(entry.isIntersecting);
			},
			{ rootMargin: "200px 0px" },
		);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	const summary = list?.find((each) => each.id === id);
	const Pane = summary ? kinds.get(summary.kind)?.Pane : undefined;
	return (
		<div
			ref={box}
			className="artifact-inline"
			data-artifact={id}
			style={visible || height === undefined ? undefined : { minHeight: height }}
		>
			{list && !summary ? (
				<p className="empty-note">No artifact "{id}" (it was deleted).</p>
			) : visible && Pane ? (
				<Pane session={session} item={id} inline editable={false} select={() => {}} annotations={[]} />
			) : null}
		</div>
	);
}

/** The artifact tools' activities, by tool name. */
export const ARTIFACT_ACTIVITIES: Readonly<Record<string, ToolActivity>> = {
	artifact_list: artifactTool("Listed artifacts", "Listing artifacts", "read", false),
	artifact_read: artifactTool("Read artifact", "Reading artifact", "read"),
	artifact_write: artifactTool("Wrote artifact", "Writing artifact", "artifact"),
	artifact_edit: artifactTool("Edited artifact", "Editing artifact", "artifact"),
	artifact_show: {
		...artifactTool("Showed artifact", "Showing artifact", "artifact"),
		hasResult: (tool) => (tool.status === "done" && idOf(tool) ? "inline" : false),
		Result: ShownArtifact,
	},
	artifact_open: artifactTool("Opened artifact", "Opening artifact", "artifact"),
	artifact_delete: artifactTool("Deleted artifact", "Deleting artifact", "artifact"),
	artifact_html_errors: artifactTool("Read the page's errors", "Reading the page's errors", "read"),
	artifact_html_logs: artifactTool("Read the page's logs", "Reading the page's logs", "read"),
	artifact_html_eval: artifactTool("Ran code in the page", "Running code in the page", "artifact"),
	artifact_html_state: artifactTool("Read the page's state", "Reading the page's state", "read"),
	artifact_html_set_state: artifactTool("Set the page's state", "Setting the page's state", "artifact"),
};
