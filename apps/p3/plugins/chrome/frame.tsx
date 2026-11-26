// The page's frame, the chrome's `PageRoot` (decisions 59, 64, 66, 74): the top bar, the navigator slot (the things
// plugin's `Navigator`, or another plugin's) and the main area with the route's target in its view, the gear opening
// its Settings view. A view that takes the whole page (`area: "page"`) gets it; the chrome keeps one corner button
// with the navigator and the gear. On a phone one screen at a time: a workspace with no view of its own shows the
// navigator first; everything else fills the screen with a back button. `/` goes to the person's first topmost
// workspace; `/me` is the person's own page.

import { IconButton } from "@earendil-works/elanor-react";
import { type ConnectionState, Me } from "@earendil-works/p3/v1";
import {
	ArrowBackIcon,
	navigate,
	PageConnection,
	type Route,
	redirect,
	SettingsIcon,
	type Target,
	targetPath,
	useComponent,
	useHold,
	useLive,
	useMessages,
	useRegistry,
	useRoute,
	useWatch,
} from "@earendil-works/p3/v1/web";
import { type ReactNode, useCallback, useEffect, useState } from "react";
// Other plugins' web contracts by path, never through `/v1/web`: a plugin applied to a running server meets the base
// its page started with, whose `/v1/web` may not have a newer contract yet (a component token would be `undefined`).
import { Navigator, Settings, type Shown, TargetView } from "../things/contract.web.tsx";
import { Roots } from "../things/workspace.ts";
import { CornerMenu } from "./corner-menu.tsx";
import styles from "./frame.module.css";
import { MePage } from "./me-page.tsx";
import { messages } from "./messages.ts";
import { TopBar } from "./top-bar.tsx";
import { ViewBoundary } from "./view-boundary.tsx";

/** Who the caller is, as `Me` answers: a person (the owner among them), or a session's agent (never a page). */
export type Caller =
	| { readonly kind: "person"; readonly id: string; readonly name: string; readonly owner: boolean }
	| { readonly kind: "agent"; readonly session: string };

/** What the bar and the corner button show: the route's target, the connection and the caller. */
export type ChromeProps = {
	readonly target: Target | undefined;
	readonly settings: boolean;
	readonly connection: ConnectionState;
	readonly caller: Caller | undefined;
};

/** The frame: the chrome around the route. */
export function Frame() {
	const route = useRoute();
	const me = useWatch(useLive(useHold(Me, {}))?.me);
	// A page is never a session's worker: `Me` answers it a person.
	const caller = me?.kind === "agent" ? undefined : me;
	const connection = useRegistry(PageConnection) ?? "connecting";
	const target = route.kind === "target" ? route.target : undefined;
	const settings = route.kind === "target" && route.settings;
	const chrome: ChromeProps = { target, settings, connection, caller };
	switch (route.kind) {
		case "landing":
			return <Shell chrome={chrome} main={<Landing />} screen="main" />;
		case "unknown":
			return <Shell chrome={chrome} main={<Note text="notFound" />} screen="main" />;
		case "me":
			return <Shell chrome={chrome} main={<MePage />} screen="main" />;
		case "target":
			return <TargetFrame chrome={chrome} route={route} />;
	}
}

/** `/`: the person's first topmost workspace, in place of `/` (a redirect); with none, says so. */
function Landing() {
	const [view] = useState(randomId);
	const roots = useWatch(useLive(useHold(Roots, { view }))?.list);
	const first = roots?.rows[0]?.workspace;
	useEffect(() => {
		if (first !== undefined) redirect(targetPath({ kind: "workspace", workspace: first }));
	}, [first]);
	return roots !== undefined && first === undefined ? <Note text="nothingYet" /> : null;
}

/** A target: in its view, or its Settings view at `/settings`; the view's area decides the frame. */
function TargetFrame(props: {
	readonly chrome: ChromeProps;
	readonly route: Extract<Route, { readonly kind: "target" }>;
}) {
	const { route } = props;
	const { t } = useMessages(messages);
	const View = useComponent(TargetView);
	const SettingsView = useComponent(Settings);
	const [shown, setShown] = useState<Shown | undefined>(undefined);
	const onShown = useCallback((next: Shown) => setShown(next), []);
	const at = targetPath(route.target, route.view === undefined ? {} : { view: route.view });
	const main = route.settings ? (
		SettingsView === undefined ? null : (
			<SettingsView target={route.target} />
		)
	) : View === undefined ? null : (
		<View onShown={onShown} target={route.target} {...(route.view === undefined ? {} : { view: route.view })} />
	);
	const framed = (
		<ViewBoundary at={route.settings ? `${at}/settings` : at} title={t("stopped")}>
			{main}
		</ViewBoundary>
	);
	if (!route.settings && shown === "page") {
		return (
			<div className={styles.frame} data-area="page">
				<main className={styles.page}>{framed}</main>
				<CornerMenu {...props.chrome} />
			</div>
		);
	}
	// On a phone, a workspace with no view of its own opens as its navigator; its Settings view is one step on.
	const navigatorFirst = route.target.kind === "workspace" && !route.settings && shown === "settings";
	return <Shell chrome={props.chrome} main={framed} screen={navigatorFirst ? "navigator" : "main"} />;
}

/** The bar, the navigator and the main area; `screen` says which a phone shows. */
function Shell(props: {
	readonly chrome: ChromeProps;
	readonly main: ReactNode;
	readonly screen: "navigator" | "main";
}) {
	const NavigatorView = useComponent(Navigator);
	const { target, settings } = props.chrome;
	return (
		<div className={styles.frame} data-area="main" data-screen={props.screen}>
			<TopBar {...props.chrome} />
			<div className={styles.body}>
				<aside className={styles.navigator}>
					{NavigatorView === undefined ? null : (
						<NavigatorView
							onMe={() => navigate("/me")}
							onOpen={(next) => navigate(targetPath(next))}
							target={target}
						/>
					)}
				</aside>
				<main className={styles.main}>
					<MainHead settings={settings} target={target} />
					{props.main}
				</main>
			</div>
		</div>
	);
}

/** Above the main area: on a phone the way back; the gear to the target's Settings view (or back from it). */
function MainHead(props: { readonly target: Target | undefined; readonly settings: boolean }) {
	const { t } = useMessages(messages);
	const { target, settings } = props;
	if (target === undefined) return null;
	const workspace: Target = { kind: "workspace", workspace: target.workspace };
	const back = settings ? targetPath(target) : targetPath(workspace);
	return (
		<div className={styles.mainHead}>
			<IconButton aria-label={t("back")} className={styles.back} data-back="" onClick={() => navigate(back)}>
				<ArrowBackIcon />
			</IconButton>
			<span className={styles.grow} />
			{settings ? null : (
				<IconButton
					aria-label={t("settings")}
					data-gear=""
					onClick={() => navigate(targetPath(target, { settings: true }))}
				>
					<SettingsIcon />
				</IconButton>
			)}
		</div>
	);
}

/** A line the chrome says in the main area. */
function Note(props: { readonly text: "nothingYet" | "notFound" }) {
	const { t } = useMessages(messages);
	return (
		<p className={styles.empty} data-empty="">
			{t(props.text)}
		</p>
	);
}

/** A fresh id for one mounted list (its `view`): two pages of one person never share it. */
function randomId(): string {
	return Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
