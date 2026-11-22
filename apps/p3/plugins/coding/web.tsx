// The coding app's web facet: its page (`AppPages`, app `coding`). A sidebar with the sessions and a "New session"
// button, the selected session (`/coding/<session>`) in the transcript, and what the session holds in a dialog opened
// on demand. On a phone the sidebar is the first screen and a session (or the new session form) fills the screen with
// a back button.

import { Button, IconButton, Modal, Stack } from "@earendil-works/elanor-react";
import { CodingTools, defineFacet, Me, SessionInfo, thingOf } from "@earendil-works/p3/v1";
import {
	AddIcon,
	AppPages,
	ArrowBackIcon,
	CloseIcon,
	FolderIcon,
	NewSessionView,
	navigate,
	SessionListView,
	SessionThingsView,
	TranscriptView,
	useHold,
	usePageState,
	useRoute,
	useVariant,
	useView,
	useWatch,
} from "@earendil-works/p3/v1/web";
import { useState } from "react";
import styles from "./web.module.css";

/** The app's id: its pages live under `/coding`. */
const APP = "coding";

/** The things every new coding session gets: the coding tools, with their default options. */
const THINGS = [thingOf(CodingTools)];

export default defineFacet((_host, self) => self.contribute(AppPages, { app: APP, Page: CodingPage }));

/** The page: the sidebar, and the session, the new session form, or a hint to pick one. */
function CodingPage() {
	const session = useRoute().rest[0];
	// Page state: a reload of this plugin keeps the form open.
	const [creating, setCreating] = usePageState("coding.creating", false);
	const SessionList = useView(SessionListView);
	// Only the owner makes sessions through the base; a person works in the ones they are a member of.
	const owner = useWatch(useVariant(useHold(Me, {}), "me")?.me)?.kind === "owner";
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
					<OpenSession session={session} />
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
						things={THINGS}
					/>
				)}
			</div>
		</div>
	);
}

/** A session: its header (back, title, what it holds) and its transcript. */
function OpenSession(props: { readonly session: string }) {
	const Transcript = useView(TranscriptView);
	const row = useWatch(useVariant(useHold(SessionInfo, { session: props.session }), "info")?.session);
	const [holding, setHolding] = useState(false);
	const title = row === undefined ? "" : row.title === "" ? "New session" : row.title;
	return (
		<>
			<header className={styles.header}>
				<IconButton aria-label="Back to the sessions" className={styles.back} onClick={() => navigate(`/${APP}`)}>
					<ArrowBackIcon />
				</IconButton>
				<h2 className={styles.title} data-session-title="">
					{title}
				</h2>
				{row === undefined ? null : (
					<Button
						data-things-open=""
						density="compact"
						hierarchy="tertiary"
						iconStart={<FolderIcon />}
						onClick={() => setHolding(true)}
					>
						Session
					</Button>
				)}
			</header>
			<div className={styles.transcript}>
				{Transcript === undefined ? null : <Transcript key={props.session} session={props.session} />}
			</div>
			<ThingsDialog onClose={() => setHolding(false)} open={holding} session={props.session} />
		</>
	);
}

/** What the session holds, in a dialog (rendered only while open: its objects are held only then). */
function ThingsDialog(props: { readonly session: string; readonly open: boolean; readonly onClose: () => void }) {
	const SessionThings = useView(SessionThingsView);
	return (
		<Modal.Root
			onOpenChange={(open) => {
				if (!open) props.onClose();
			}}
			open={props.open}
		>
			<Modal.Portal>
				<Modal.Backdrop />
				<Modal.Viewport>
					<Modal.Popup className={styles.dialog} data-things-dialog="">
						<Stack align="start" direction="row" gap="auto">
							<Modal.Title>Session</Modal.Title>
							<Modal.Close render={<IconButton aria-label="Close" />}>
								<CloseIcon />
							</Modal.Close>
						</Stack>
						{props.open && SessionThings !== undefined ? <SessionThings session={props.session} /> : null}
					</Modal.Popup>
				</Modal.Viewport>
			</Modal.Portal>
		</Modal.Root>
	);
}
