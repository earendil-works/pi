// How the artifact tools show in the chat (nested in code mode's card): what each did with which artifact, and for
// `artifact_show` the artifact itself in place, right after the call (its pane, inline), mounted only while it is on
// screen so a long transcript runs no more pages than the person sees.

import { BACKGROUND_CONTEXT, type JsonValue } from "@p2/app/v1";
import {
	detailsOf,
	failureOf,
	SessionId,
	type Step,
	stringOf,
	type ToolActivity,
	type ToolView,
	useComposerState,
	useHost,
	useObject,
	useRegistry,
	ViewKinds,
} from "@p2/app/v1/web";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Views } from "../views/contract.ts";
import { type InlineSize, InlineSizeContext, inlineHeights } from "./inline-size.ts";
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

/**
 * The pane of artifact `id` in the transcript, as beside the chat: people who may send change it (an html page saves
 * its state) and select in it (`Views.selectInline`: it goes with their next message); viewers read it. It is mounted
 * only near the screen. Hysteresis keeps a card at the edge from
 * flipping: it mounts within a viewport of the screen and unmounts only past two. The card keeps the height its pane
 * last had (`inlineHeights`) while the pane is away and while a remounted pane settles, until the pane reports its real
 * height or `SETTLE_MS` pass, so scrolling back never collapses it under the reader.
 */
export function InlineArtifact({ session, id }: { session: string; id: string }) {
	const box = useRef<HTMLDivElement>(null);
	const host = useHost();
	const heights = inlineHeights(host);
	const key = `${session}/${id}`;
	const [mounted, setMounted] = useState(false);
	const [settled, setSettled] = useState(false);
	const isMounted = useRef(false);
	const { list, editor } = useArtifacts(session);
	const kinds = useRegistry(ViewKinds);
	// People who may send change it here as beside the chat; their selection goes with their next message.
	const views = useObject(Views, editor ? { session } : undefined, { variant: "editor" });
	const { fail } = useComposerState();
	useEffect(() => {
		const element = box.current;
		if (!element) return;
		const root = scrollRoot(element);
		let near = false;
		let far = false;
		const decide = () => {
			const next = near || (isMounted.current && far);
			if (next === isMounted.current) return;
			// Unmounting: what the card shows now is what it reserves until the pane is back.
			if (!next) {
				const height = element.getBoundingClientRect().height;
				if (height > 0) heights.set(key, height);
			}
			isMounted.current = next;
			if (next) setSettled(false);
			setMounted(next);
		};
		const watch = (margin: string, set: (inside: boolean) => void) =>
			new IntersectionObserver(
				(entries) => {
					const entry = entries.at(-1);
					if (!entry) return;
					set(entry.isIntersecting);
					decide();
				},
				{ root, rootMargin: `${margin} 0px` },
			);
		const mount = watch("100%", (inside) => {
			near = inside;
		});
		const keep = watch("200%", (inside) => {
			far = inside;
		});
		mount.observe(element);
		keep.observe(element);
		return () => {
			mount.disconnect();
			keep.disconnect();
		};
	}, [heights, key]);
	// A pane that never reports (an empty page, a deleted artifact) gives the reserve up after a while.
	useEffect(() => {
		if (!mounted || settled) return;
		const timer = setTimeout(() => setSettled(true), SETTLE_MS);
		return () => clearTimeout(timer);
	}, [mounted, settled]);
	// A new reserve each time the pane mounts again: `mounted` marks a new mount.
	// biome-ignore lint/correctness/useExhaustiveDependencies: see above.
	const size = useMemo<InlineSize>(
		() => ({
			initial: heights.get(key),
			report: (height) => {
				if (height > 0) heights.set(key, height);
				setSettled(true);
			},
		}),
		[heights, key, mounted],
	);
	const summary = list?.find((each) => each.id === id);
	const Pane = summary ? kinds.get(summary.kind)?.Pane : undefined;
	const select = useCallback(
		(selection: { summary: string; data?: JsonValue } | null) => {
			if (!views || !summary) return;
			views
				.selectInline(
					{ kind: summary.kind, item: id, title: summary.title.slice(0, 120), selection },
					BACKGROUND_CONTEXT,
				)
				.catch(fail);
		},
		[views, summary, id, fail],
	);
	const reserved = mounted && settled ? undefined : heights.get(key);
	return (
		<div
			ref={box}
			className="artifact-inline"
			data-artifact={id}
			style={reserved === undefined ? undefined : { minHeight: reserved }}
		>
			{list && !summary ? (
				<p className="empty-note">No artifact "{id}" (it was deleted).</p>
			) : mounted && Pane ? (
				<InlineSizeContext.Provider value={size}>
					<Pane
						session={session}
						item={id}
						inline
						editable={editor !== undefined}
						select={select}
						annotations={[]}
					/>
				</InlineSizeContext.Provider>
			) : null}
		</div>
	);
}

/** How long a remounted pane may take to report its height before its card gives up the reserved one. */
const SETTLE_MS = 1500;

/** The nearest scrolling ancestor of `element` (the transcript's scroller), or the viewport. */
function scrollRoot(element: HTMLElement): HTMLElement | null {
	for (let parent = element.parentElement; parent; parent = parent.parentElement) {
		const overflow = getComputedStyle(parent).overflowY;
		if (overflow === "auto" || overflow === "scroll" || overflow === "overlay") return parent;
	}
	return null;
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
