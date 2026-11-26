// The page's frame, the chrome's `PageRoot` (decisions 59, 64, 66, 74): the top bar, the navigator slot (the things
// plugin's `Navigator`, or another plugin's) and the main area with the route's target in its view, the gear opening
// its Settings view. A view that takes the whole page (`area: "page"`) gets it; the chrome keeps one corner button
// with the navigator and the gear. Both areas are one tree, so a view keeps its place (and its state) when the chrome
// learns its area. On a phone one screen at a time: a workspace with no view of its own shows the navigator first;
// everything else fills the screen with a back button. `/` goes to the person's first topmost workspace; `/me` is
// the person's own page.

import { IconButton } from "@earendil-works/elanor-react";
import { type ConnectionState, Me } from "@earendil-works/p3/v1";
import {
	ArrowBackIcon,
	Components,
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
	usePageState,
	useRegistry,
	useRoute,
	useWatch,
} from "@earendil-works/p3/v1/web";
import { type ReactNode, useEffect, useState } from "react";
// Other plugins' web contracts by path, never through `/v1/web`: a plugin applied to a running server meets the base
// its page started with, whose `/v1/web` may not have a newer contract yet (a component token would be `undefined`).
import { Navigator, Settings, type Shown, TargetView, useScreenId, Views } from "../things/contract.web.tsx";
import { Roots } from "../things/workspace.ts";
import { CornerMenu } from "./corner-menu.tsx";
import styles from "./frame.module.css";
import { MePage } from "./me-page.tsx";
import { messages } from "./messages.ts";
import { TopBar } from "./top-bar.tsx";
import { ViewBoundary } from "./view-boundary.tsx";

/**
 * What the bar shows: the route's target, the view it chose (`?view=`, kept through the gear and Back), the
 * connection and the person's name (`Me`; none until known).
 */
export type ChromeProps = {
	readonly target: Target | undefined;
	readonly view: string | undefined;
	readonly settings: boolean;
	readonly connection: ConnectionState;
	readonly person: string | undefined;
	readonly phone: Phone;
};

/** Which screen a phone shows for one address, when the person chose it (Back, or an entry of the navigator). */
type PhoneScreen = { readonly at: string; readonly screen: "navigator" | "main" };

/** What `Shell` needs to let a phone switch between the navigator and the main area. */
type Phone = {
	/** The address the page is at (path and query): a choice holds for it only. */
	readonly at: string;
	readonly chosen: PhoneScreen | null;
	readonly choose: (chosen: PhoneScreen) => void;
};

/** The frame: the chrome around the route. */
export function Frame() {
	const route = useRoute();
	// Kept as page state: a reload of this plugin keeps the phone's screen.
	const [chosen, choose] = usePageState<PhoneScreen | null>("chrome.phone-screen", null);
	const phone: Phone = { at: location.pathname + location.search, chosen, choose };
	const me = useWatch(useLive(useHold(Me, {}))?.me);
	// A page is never a session's worker: `Me` answers it a person.
	const person = me?.kind === "person" ? me.name : undefined;
	const connection = useRegistry(PageConnection) ?? "connecting";
	const target = route.kind === "target" ? route.target : undefined;
	const settings = route.kind === "target" && route.settings;
	const view = route.kind === "target" ? route.view : undefined;
	const chrome: ChromeProps = { target, view, settings, connection, person, phone };
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
	const roots = useWatch(useLive(useHold(Roots, { view: useScreenId() }))?.list);
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
	// What draws the view: an apply gives these new values, and the boundary tries the view again with them.
	const views = useRegistry(Views);
	const components = useRegistry(Components);
	const SettingsView = useComponent(Settings);
	const [shown, setShown] = useState<Shown | undefined>(undefined);
	const at = targetPath(route.target, { view: route.view });
	const main = route.settings ? (
		SettingsView === undefined ? null : (
			<SettingsView target={route.target} />
		)
	) : View === undefined ? null : (
		<View onShown={setShown} target={route.target} view={route.view} />
	);
	const framed = (
		<ViewBoundary at={route.settings ? `${at}/settings` : at} code={[views, components]} title={t("stopped")}>
			{main}
		</ViewBoundary>
	);
	if (!route.settings && shown === "page") return <Shell chrome={props.chrome} main={framed} screen="page" />;
	// On a phone, a workspace with no view of its own opens as its navigator; its Settings view is one step on.
	const navigatorFirst = route.target.kind === "workspace" && !route.settings && shown === "settings";
	return <Shell chrome={props.chrome} main={framed} screen={navigatorFirst ? "navigator" : "main"} />;
}

/**
 * The bar, the navigator and the main area; `screen` says which of the two a phone shows, or `page`: the main area
 * alone with the corner button. `main` keeps its place in the tree whatever `screen` says.
 */
function Shell(props: {
	readonly chrome: ChromeProps;
	readonly main: ReactNode;
	readonly screen: "navigator" | "main" | "page";
}) {
	const NavigatorView = useComponent(Navigator);
	const { target, view, settings, phone } = props.chrome;
	const page = props.screen === "page";
	// What the person chose for this address wins over the default (a phone shows one of the two; a desktop both).
	const screen = page || phone.chosen?.at !== phone.at ? props.screen : phone.chosen.screen;
	/** Opens `path` in the main area: on a phone the main area comes forward, also for the address it is at. */
	const open = (path: string) => {
		phone.choose({ at: path, screen: "main" });
		if (path !== phone.at) navigate(path);
	};
	return (
		<div className={styles.frame} data-area={page ? "page" : "main"} data-screen={screen}>
			{page ? null : <TopBar {...props.chrome} />}
			<div className={styles.body}>
				{page ? null : (
					<aside className={styles.navigator}>
						{NavigatorView === undefined ? null : (
							<NavigatorView
								onMe={() => open("/me")}
								onOpen={(next) => open(targetPath(next))}
								target={target}
							/>
						)}
					</aside>
				)}
				<main className={styles.main}>
					{page ? null : <MainHead phone={phone} settings={settings} target={target} view={view} />}
					{props.main}
				</main>
			</div>
			{page ? <CornerMenu target={target} view={view} /> : null}
		</div>
	);
}

/**
 * Above the main area: on a phone the way back (from a Settings view to the target, from a thing, person or group to
 * its workspace, from a workspace's own view to the navigator, from anywhere else to `/`); the gear to the target's
 * Settings view.
 */
function MainHead(props: {
	readonly target: Target | undefined;
	readonly view: string | undefined;
	readonly settings: boolean;
	readonly phone: Phone;
}) {
	const { t } = useMessages(messages);
	const { target, view, settings, phone } = props;
	const back = () => {
		if (target === undefined) return navigate("/");
		if (settings) return navigate(targetPath(target, { view }));
		if (target.kind !== "workspace") return navigate(targetPath({ kind: "workspace", workspace: target.workspace }));
		// A workspace's own view: its navigator is the screen before it, at the same address.
		phone.choose({ at: phone.at, screen: "navigator" });
	};
	return (
		<div className={styles.mainHead}>
			<IconButton aria-label={t("back")} className={styles.back} data-back="" onClick={back}>
				<ArrowBackIcon />
			</IconButton>
			<span className={styles.grow} />
			{settings || target === undefined ? null : (
				<IconButton
					aria-label={t("settings")}
					data-gear=""
					onClick={() => navigate(targetPath(target, { settings: true, view }))}
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
