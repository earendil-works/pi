// Elanor's Timeline, built in p2 until Elanor's npm release has it (its 0.1.0 does not): ported from Elanor's source as
// vendored on the p2-elanor branch, with its styles in elanor-extra.css. Replace with `Timeline` from
// @earendil-works/elanor-react once it ships; the props are the same.
import { ChevronRightIcon } from "@earendil-works/elanor-icons-react";
import {
	type ComponentPropsWithRef,
	createContext,
	type ReactNode,
	type RefObject,
	useCallback,
	useContext,
	useEffect,
	useLayoutEffect,
	useRef,
} from "react";
import "./elanor-extra.css";

/** Whether the root has rendered once: items mounted after that arrive. */
const ReadyContext = createContext<RefObject<boolean> | null>(null);

const classes = (...names: (string | undefined)[]) => names.filter(Boolean).join(" ");

/**
 * A vertical list of steps on a rail, in order, such as the steps of a running task. Renders an `ol`. Items added after
 * the first render slide in.
 */
function TimelineRoot({ className, ...props }: ComponentPropsWithRef<"ol">) {
	const ready = useRef(false);
	useEffect(() => {
		ready.current = true;
	}, []);
	return (
		<ReadyContext value={ready}>
			<ol {...props} className={classes("el-timeline", className)} />
		</ReadyContext>
	);
}

export type TimelineItemStatus = "running" | "done" | "error";

const STATUS_LABELS: Record<TimelineItemStatus, string> = { running: "Running", done: "Done", error: "Failed" };

export interface TimelineItemProps extends Omit<ComponentPropsWithRef<"li">, "title" | "onClick" | "children"> {
	/** The step's state: `running` breathes, `error` is negative. Default `done`. */
	status?: TimelineItemStatus | undefined;
	/** The marker's accessible name; by default "Running", "Done" or "Failed", by status. */
	statusLabel?: string | undefined;
	/** The marker, such as an icon for the kind of step. A small dot without one. */
	icon?: ReactNode;
	/** The step's title, on one line, truncated with an ellipsis. */
	title: ReactNode;
	/** A line below the title, truncated with an ellipsis. */
	description?: ReactNode;
	/** Sets the description in the code font, for commands and output. */
	code?: boolean | undefined;
	/** Makes the step a button with a trailing chevron, for steps that open more detail. */
	onClick?: (() => void) | undefined;
}

/** One step: a marker on the rail beside its title, and an optional description. Renders an `li`. */
function TimelineItem({
	status = "done",
	statusLabel,
	icon,
	title,
	description,
	code = false,
	onClick,
	className,
	ref,
	...props
}: TimelineItemProps) {
	const ready = useContext(ReadyContext);
	const element = useRef<HTMLLIElement | null>(null);
	const itemRef = useCallback(
		(node: HTMLLIElement | null) => {
			element.current = node;
			if (typeof ref === "function") ref(node);
			else if (ref) ref.current = node;
		},
		[ref],
	);
	// An item mounted after the timeline first rendered slides in.
	useLayoutEffect(() => {
		if (ready?.current) element.current?.setAttribute("data-arriving", "");
	}, [ready]);
	const content = (
		<>
			<span
				className="el-timeline-marker"
				data-status={status}
				role="img"
				aria-label={statusLabel ?? STATUS_LABELS[status]}
			>
				{icon ?? <span className="el-timeline-dot" />}
			</span>
			<span className="el-timeline-body">
				<span className="el-timeline-text">
					<span className="el-timeline-title">{title}</span>
					{description != null && description !== false && (
						<span className="el-timeline-description" data-code={code || undefined}>
							{description}
						</span>
					)}
				</span>
				{onClick && (
					<span className="el-timeline-chevron">
						<ChevronRightIcon />
					</span>
				)}
			</span>
		</>
	);
	return (
		<li {...props} ref={itemRef} className={classes("el-timeline-item", className)} data-status={status}>
			{onClick ? (
				<button type="button" className="el-timeline-step" onClick={() => onClick()}>
					{content}
				</button>
			) : (
				<div className="el-timeline-step">{content}</div>
			)}
		</li>
	);
}

export const Timeline = { Root: TimelineRoot, Item: TimelineItem };
