// The page's frame, the chrome's `PageRoot`: the route's app (the path's first segment; none, or one the caller may
// not enter: the first app of their catalog) with its chrome, the full top bar or one corner button as the app chose,
// and below it the app's page inside a boundary that shows the app's error and keeps the bar.

import { AppCatalog, type AppInfo, type ConnectionState, Me } from "@earendil-works/p3/v1";
import { PageConnection, redirect, useHold, useLive, useRegistry, useRoute, useWatch } from "@earendil-works/p3/v1/web";
import { useEffect, useState } from "react";
// Other plugins' web contracts by path, never through `/v1/web`: a plugin applied to a running server meets the base
// its page started with, whose `/v1/web` may not have a newer contract yet (a component token would be `undefined`).
import { AppPages } from "../apps/contract.web.ts";
import { AppBoundary } from "./app-boundary.tsx";
import { CornerMenu } from "./corner-menu.tsx";
import styles from "./frame.module.css";
import { InviteDialog } from "./invite.tsx";
import { MyThingsDialog } from "./my-things-dialog.tsx";
import { TopBar } from "./top-bar.tsx";

/** Who the caller is, as `Me` answers: a person (the owner among them), or a session's agent (never a page). */
export type Caller =
	| { readonly kind: "person"; readonly id: string; readonly name: string; readonly owner: boolean }
	| { readonly kind: "agent"; readonly session: string };

/** What the bar and the corner button show: the apps (`current` the route's), the connection and the caller. */
export type ChromeProps = {
	readonly apps: readonly AppInfo[];
	readonly current: AppInfo | undefined;
	readonly connection: ConnectionState;
	readonly caller: Caller | undefined;
	readonly onInvite: () => void;
	readonly onMyThings: () => void;
};

/** The frame: the chrome and the route's app page. */
export function Frame() {
	const route = useRoute();
	const apps = useWatch(useLive(useHold(AppCatalog, {}))?.apps);
	const me = useWatch(useLive(useHold(Me, {}))?.me);
	// A page is never a session's worker: `Me` answers it the owner or a person.
	const caller = me?.kind === "agent" ? undefined : me;
	const connection = useRegistry(PageConnection) ?? "connecting";
	const [inviting, setInviting] = useState(false);
	const current = apps?.find((app) => app.id === route.app);
	const first = apps?.[0]?.id;
	useEffect(() => {
		if (current === undefined && first !== undefined) redirect(`/${first}`);
	}, [current, first]);
	const [mine, setMine] = useState(false);
	const chrome: ChromeProps = {
		apps: apps ?? [],
		current,
		connection,
		caller,
		onInvite: () => setInviting(true),
		onMyThings: () => setMine(true),
	};
	return (
		<div className={styles.frame} data-chrome={current?.chrome ?? "bar"}>
			{current?.chrome === "button" ? <CornerMenu {...chrome} /> : <TopBar {...chrome} />}
			<main className={styles.page}>
				<AppPage apps={apps} current={current} />
			</main>
			{caller?.kind === "person" && caller.owner ? (
				<InviteDialog onClose={() => setInviting(false)} open={inviting} />
			) : null}
			{caller?.kind === "person" ? <MyThingsDialog onClose={() => setMine(false)} open={mine} /> : null}
		</div>
	);
}

/** The route's app page in its boundary, or why there is none. */
function AppPage(props: { readonly apps: readonly AppInfo[] | undefined; readonly current: AppInfo | undefined }) {
	const pages = useRegistry(AppPages);
	if (props.apps === undefined || pages === undefined) return null;
	if (props.apps.length === 0) return <p className={styles.empty}>There is no app for you on this Pi yet.</p>;
	if (props.current === undefined) return null;
	const Page = pages.get(props.current.id)?.value.Page;
	if (Page === undefined) return <p className={styles.empty}>{props.current.title} has no page on this Pi.</p>;
	return <AppBoundary Page={Page} title={props.current.title} />;
}
