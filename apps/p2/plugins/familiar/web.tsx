// The Familiar in the owner's page, named "Ask Pi": home (`/`) opens its session, as its row above the sidebar's "New
// session" does; either makes it on first use. The sidebar lists its session there only, not in any rollup.
import { BACKGROUND_CONTEXT, contribute, defineFacet, keptIn, liveIn } from "@p2/app/v1";
import {
	conversationRoute,
	NEW_SESSION,
	navigate,
	PiLogo,
	SideNavigation,
	Slots,
	useComposerState,
	useNavigation,
	useObject,
	useOwner,
	useReadable,
	useRoute,
} from "@p2/app/v1/web";
import { useContext, useEffect, useRef, useState } from "react";
import { Sessions } from "../sessions/contract.ts";
import { DrawerRowsContext, IconMarker, NavRow, UnreadMark } from "../sessions/contract.web.tsx";
import { FAMILIAR_TITLE, Familiar } from "./contract.ts";
import "./style.css";

/** The owner's row above "New session"; guests have none. */
function FamiliarRow() {
	return useOwner() ? <OwnerRow /> : null;
}

/**
 * The Familiar's row: the Pi logo (framed while its session works) and its name, bold with a dot for an unread answer,
 * selected while its session shows. It opens the session, which the server makes or restores first when it has to.
 */
function OwnerRow() {
	const held = useObject(Familiar, {});
	const familiar = liveIn(held, "owner");
	// As the server last said: while the connection is down or coming back, its row stays out of the rollups, as the
	// sidebar's rows stay.
	const session = useReadable(keptIn(held, "owner")?.session) ?? null;
	const { sessions, listApart } = useContext(DrawerRowsContext);
	const row = sessions.find((each) => each.id === session);
	const route = useRoute();
	const { fail, focusWhenOpen } = useComposerState();
	const [opening, setOpening] = useState(false);
	useEffect(() => listApart("familiar", session === null ? [] : [session]), [listApart, session]);
	const open = () => {
		// A live row opens at once, its composer focused as a session row's; otherwise the server makes or restores it
		// first, and which session it is shows only then.
		if (row && row.archivedAt === null) {
			const target = { session: row.id, conversation: row.main };
			focusWhenOpen(target);
			navigate(target);
			return;
		}
		// Not while one open runs, and not without the server (offline, there is nothing to make it).
		if (opening || !familiar) return;
		setOpening(true);
		void familiar
			.open(BACKGROUND_CONTEXT)
			.then(({ id }) => navigate({ session: id }))
			.catch(fail)
			.finally(() => setOpening(false));
	};
	const unread = row?.worker.unread === true;
	return (
		<SideNavigation.Item>
			<NavRow
				selected={row !== undefined && route.session === row.id}
				className="group-row"
				linkClassName="familiar-entry"
				title={opening ? "Opening…" : undefined}
				onActivate={open}
				marker={
					<IconMarker working={row !== undefined && row.worker.busy.length > 0}>
						<PiLogo compact />
					</IconMarker>
				}
				label={<span className={`session-title ${unread ? "unread" : ""}`}>{FAMILIAR_TITLE}</span>}
				details={unread && <UnreadMark />}
			/>
		</SideNavigation.Item>
	);
}

/** Home for the owner: the Familiar's session (made on first use); while the owner has it archived, the new-session screen. */
function FamiliarHome() {
	return useOwner() ? <OwnerHome /> : null;
}

/** Replaces home with the Familiar's session as soon as the server says which it is; shows nothing meanwhile. */
function OwnerHome() {
	const nav = useNavigation();
	const held = useObject(Familiar, {});
	const familiar = liveIn(held, "owner");
	const session = useReadable(keptIn(held, "owner")?.session);
	const rows = useReadable(liveIn(useObject(Sessions, {}), "owner")?.sessions);
	const { fail } = useComposerState();
	const opening = useRef(false);
	useEffect(() => {
		if (session === undefined || rows === undefined || opening.current) return;
		const current = nav.route;
		const row = session === null ? undefined : rows.find((each) => each.id === session);
		if (row?.archivedAt === null) void nav.replace(conversationRoute(current, row.id, row.main), current);
		// Archived by the owner: home leaves it archived; its row restores it.
		else if (row) void nav.replace(NEW_SESSION, current);
		else if (familiar) {
			opening.current = true;
			void familiar
				.open(BACKGROUND_CONTEXT)
				.then(({ id }) => nav.replace(conversationRoute(current, id), current))
				.catch(fail)
				.finally(() => {
					opening.current = false;
				});
		}
	}, [session, rows, familiar, nav, fail]);
	return null;
}

export default defineFacet((host) => {
	contribute(host, "p2.web-familiar", (self) => {
		self.contribute(Slots, { "sidebar-start:familiar": FamiliarRow, home: FamiliarHome });
	});
});
