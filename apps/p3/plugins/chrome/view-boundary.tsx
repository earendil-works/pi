// The boundary around the main area's view: a view that throws while it renders shows its error in its place, and the
// chrome around it stays. Another target, or an apply that brings new views or components (a fix), renders again.

import { Component, type ReactNode } from "react";
import styles from "./frame.module.css";

/** What the boundary keeps: the key of what it shows, the code it shows it with, and the error that threw (if any). */
type BoundaryState = {
	readonly at: string;
	readonly code: readonly unknown[];
	readonly failed: { readonly error: unknown } | undefined;
};

/**
 * The props: what to render, its key and the code that draws it (the registries' values: an apply gives new ones),
 * either new starting without the old error; and the error's title.
 */
type BoundaryProps = {
	readonly at: string;
	readonly code: readonly unknown[];
	readonly title: string;
	readonly children: ReactNode;
};

/** Renders `children`, or the error they threw while rendering, until `at` or the code changes. */
export class ViewBoundary extends Component<BoundaryProps, BoundaryState> {
	constructor(props: BoundaryProps) {
		super(props);
		this.state = { at: props.at, code: props.code, failed: undefined };
	}

	/** Something else to show starts without the old one's error. */
	static getDerivedStateFromProps(props: BoundaryProps, state: BoundaryState): Partial<BoundaryState> | null {
		const same = props.at === state.at && props.code.every((value, index) => value === state.code[index]);
		return same ? null : { at: props.at, code: props.code, failed: undefined };
	}

	/** The view's error, kept until something else is shown. */
	static getDerivedStateFromError(error: unknown): Partial<BoundaryState> {
		return { failed: { error } };
	}

	render(): ReactNode {
		const { failed } = this.state;
		if (failed === undefined) return this.props.children;
		const message = failed.error instanceof Error ? failed.error.message : String(failed.error);
		return (
			<div className={styles.failure} data-view-error="" role="alert">
				<p className={styles.failureTitle}>{this.props.title}</p>
				<pre className={styles.failureMessage}>{message}</pre>
			</div>
		);
	}
}
