// The page never goes blank: the app's root error boundary shows what failed, with a reload and a reset of what this
// device saved for the open session (state an older version of the page may have written), and every failure the page
// sees (a render, an uncaught error or rejection, a pane's boundary) is reported to the server, which logs it and, for
// the owner, shows it among the owner's notices.
import { Component, type ErrorInfo, type ReactNode } from "react";
import { forgetSession } from "./conversation-cache.ts";

/** How many reports one page load sends at most: a failing loop must not flood the server. */
const MAX_REPORTS = 20;
const reported = new Set<string>();

/** Reports a failure of the page to the server (deduplicated, bounded, never throwing). */
export function reportClientError(error: unknown, where: string): void {
	const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	const key = `${where}\n${message}`;
	if (reported.has(key) || reported.size >= MAX_REPORTS) return;
	reported.add(key);
	const stack = error instanceof Error ? (error.stack ?? "") : "";
	try {
		void fetch("/client-error", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			credentials: "same-origin",
			keepalive: true,
			body: JSON.stringify({
				where,
				message: message.slice(0, 2000),
				stack: stack.slice(0, 4000),
				path: location.pathname,
				version: document.documentElement.dataset.webVersion ?? "",
			}),
		}).catch(() => {});
	} catch {
		// Reporting is best effort: the page's own recovery does not depend on it.
	}
}

/** Reports errors and rejections nothing caught, for the page's whole life. */
export function startErrorReports(): void {
	addEventListener("error", (event) => reportClientError(event.error ?? event.message, "window"));
	addEventListener("unhandledrejection", (event) => reportClientError(event.reason, "promise"));
}

/** The session the page's address names, if any. */
const sessionOfPage = (): string | undefined => /^\/s\/([0-9a-f-]+)/.exec(location.pathname)?.[1];

/**
 * Forgets what this device saved for `session` (its layout and panels, any key naming it, its cached conversations,
 * the tab's navigation and draft) and the service worker's kept page, so the next load starts from the server's state
 * with the current code.
 */
export async function resetSessionState(session: string): Promise<void> {
	try {
		for (const key of Object.keys(localStorage)) if (key.includes(session)) localStorage.removeItem(key);
		const panels: unknown = JSON.parse(localStorage.getItem("p2-session-panels") ?? "[]");
		if (Array.isArray(panels))
			localStorage.setItem(
				"p2-session-panels",
				JSON.stringify(panels.filter((entry) => !(Array.isArray(entry) && entry[0] === session))),
			);
		sessionStorage.removeItem("p2-navigation");
		sessionStorage.removeItem("p2-draft");
	} catch {}
	await forgetSession(session).catch(() => {});
	try {
		await caches?.delete("p2-app-shell");
	} catch {}
}

/** The app's root boundary: a failure anywhere shows itself with a way out, instead of an empty page. */
export class AppBoundary extends Component<{ children: ReactNode }, { error?: unknown }> {
	override state: { error?: unknown } = {};

	static getDerivedStateFromError(error: unknown): { error: unknown } {
		return { error };
	}

	override componentDidCatch(error: unknown, info: ErrorInfo): void {
		reportClientError(
			error instanceof Error && info.componentStack ? withComponents(error, info.componentStack) : error,
			"render",
		);
	}

	override render() {
		if (this.state.error === undefined) return this.props.children;
		return <PageFailed error={this.state.error} />;
	}
}

/** `error` with the component stack React gives (where in the page it failed) added to its stack. */
function withComponents(error: Error, components: string): Error {
	const copy = new Error(error.message);
	copy.name = error.name;
	copy.stack = `${error.stack ?? ""}\nComponents:${components}`;
	return copy;
}

/** What the person sees when the page failed: the error, Reload, and a reset of the open session's saved state. */
function PageFailed({ error }: { error: unknown }) {
	const session = sessionOfPage();
	const message = error instanceof Error ? error.message : String(error);
	return (
		<div className="hero page-failed" role="alert" data-testid="page-failed">
			<h2>This page failed</h2>
			<p className="muted">{message}</p>
			<p className="muted">The error was reported to the server.</p>
			<p>
				<button type="button" className="primary" onClick={() => location.reload()}>
					Reload
				</button>{" "}
				{session && (
					<button type="button" onClick={() => void resetSessionState(session).finally(() => location.reload())}>
						Reset this device's saved state for this session
					</button>
				)}
			</p>
		</div>
	);
}
