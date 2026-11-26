// The boundary around an app's page: an app that throws while it renders shows its error in its place, and the top
// bar above it stays. Another page component (another app, or the app's plugin reloaded with a fix) renders again.

import { Component, type ComponentType, type ReactNode } from "react";
import styles from "./frame.module.css";

/** The page component the boundary renders, and the error it threw (none: `undefined`). */
type BoundaryState = { readonly Page: ComponentType; readonly failed: { readonly error: unknown } | undefined };

/** The props: the app's page component and its title, for the error. */
type BoundaryProps = { readonly Page: ComponentType; readonly title: string };

/** Renders `Page`, or the error it threw while rendering, until another page component comes. */
export class AppBoundary extends Component<BoundaryProps, BoundaryState> {
	constructor(props: BoundaryProps) {
		super(props);
		this.state = { Page: props.Page, failed: undefined };
	}

	/** A new page component starts without the old one's error. */
	static getDerivedStateFromProps(props: BoundaryProps, state: BoundaryState): Partial<BoundaryState> | null {
		return props.Page === state.Page ? null : { Page: props.Page, failed: undefined };
	}

	/** The page's error, kept until another page component comes. */
	static getDerivedStateFromError(error: unknown): Partial<BoundaryState> {
		return { failed: { error } };
	}

	render(): ReactNode {
		const { failed, Page } = this.state;
		if (failed === undefined) return <Page />;
		const message = failed.error instanceof Error ? failed.error.message : String(failed.error);
		return (
			<div className={styles.failure} data-app-error="" role="alert">
				<p className={styles.failureTitle}>{this.props.title} stopped with an error.</p>
				<pre className={styles.failureMessage}>{message}</pre>
			</div>
		);
	}
}
