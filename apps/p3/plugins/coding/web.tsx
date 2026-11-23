// The coding app's web facet: its page (`AppPages`, app `coding`). A sidebar with the sessions and a "New session"
// button, and the selected session (`/coding/<session>`, a thing of it opened as a pane: `/coding/<session>/<thing>`;
// `open-session.tsx`). On a phone the sidebar is the first screen and a session (or the new session form) fills the
// screen with a back button.

import { Button, IconButton } from "@earendil-works/elanor-react";
import { defineFacet, Me } from "@earendil-works/p3/v1";
import {
	AddIcon,
	AppPages,
	ArrowBackIcon,
	NewSessionView,
	navigate,
	SessionListView,
	useHold,
	usePageState,
	useRoute,
	useVariant,
	useView,
	useWatch,
} from "@earendil-works/p3/v1/web";
import { OpenSession } from "./open-session.tsx";
import styles from "./web.module.css";

/** The app's id: its pages live under `/coding`. */
const APP = "coding";

export default defineFacet((_host, self) => self.contribute(AppPages, { app: APP, Page: CodingPage }));

/** The page: the sidebar, and the session, the new session form, or a hint to pick one. */
function CodingPage() {
	const route = useRoute();
	const session = route.rest[0];
	// Page state: a reload of this plugin keeps the form open.
	const [creating, setCreating] = usePageState("coding.creating", false);
	const SessionList = useView(SessionListView);
	// Only the owner makes sessions through the base; a person works in the ones they are a member of.
	const me = useWatch(useVariant(useHold(Me, {}), "me")?.me);
	const owner = me?.kind === "person" && me.owner;
	const screen = session !== undefined || creating ? "main" : "list";
	return (
		<div className={styles.app} data-screen={screen}>
			<aside aria-label="Sessions" className={styles.sidebar}>
				{owner ? (
					<Button
						className={styles.newSession}
						data-new-session-open=""
						hierarchy="secondary"
						iconStart={<AddIcon />}
						onClick={() => setCreating(true)}
					>
						New session
					</Button>
				) : null}
				{SessionList === undefined ? null : (
					<SessionList
						app={APP}
						onOpen={(id) => {
							setCreating(false);
							navigate(`/${APP}/${id}`);
						}}
						selected={creating ? undefined : session}
					/>
				)}
			</aside>
			<section className={styles.main}>
				{creating && owner ? (
					<Creating onBack={() => setCreating(false)} />
				) : session === undefined ? (
					<p className={styles.hint}>Open a session, or start a new one.</p>
				) : (
					<OpenSession active={route.rest[1]} app={APP} session={session} />
				)}
			</section>
		</div>
	);
}

/** The new session form, with a back button; a made session opens. */
function Creating(props: { readonly onBack: () => void }) {
	const NewSession = useView(NewSessionView);
	return (
		<div className={styles.scroll}>
			<div className={styles.form}>
				<IconButton aria-label="Back to the sessions" className={styles.back} onClick={props.onBack}>
					<ArrowBackIcon />
				</IconButton>
				{NewSession === undefined ? null : (
					<NewSession
						app={APP}
						onCreated={(id) => {
							props.onBack();
							navigate(`/${APP}/${id}`);
						}}
					/>
				)}
			</div>
		</div>
	);
}
