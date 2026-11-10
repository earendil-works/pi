// The Familiar's entry at the top of the owner's sidebar, above the rollups: opens its session, making it on first use.
// The sidebar lists its session here only, not in any rollup.
import { BACKGROUND_CONTEXT, contribute, defineFacet, keptIn, liveIn } from "@p2/app/v1";
import {
	navigate,
	Slots,
	SparkIcon,
	useComposerState,
	useConnected,
	useObject,
	useOwner,
	useReadable,
	useRoute,
} from "@p2/app/v1/web";
import { useContext, useEffect, useState } from "react";
import { DrawerRowsContext, SessionDot } from "../sessions/contract.web.tsx";
import { FAMILIAR_TITLE, Familiar } from "./contract.ts";
import "./style.css";

function FamiliarEntry() {
	return useOwner() ? <OwnerEntry /> : null;
}

function OwnerEntry() {
	const held = useObject(Familiar, {});
	const familiar = liveIn(held, "owner");
	// As the server last said: while the connection is down or coming back, its row stays out of the rollups, as the
	// sidebar's rows stay.
	const session = useReadable(keptIn(held, "owner")?.session) ?? null;
	const { sessions, listApart } = useContext(DrawerRowsContext);
	const row = sessions.find((each) => each.id === session);
	const route = useRoute();
	const connected = useConnected();
	const { fail } = useComposerState();
	const [opening, setOpening] = useState(false);
	useEffect(() => listApart("familiar", session === null ? [] : [session]), [listApart, session]);
	const open = () => {
		// A live row opens at once; otherwise the server makes or restores it first.
		if (row && row.archivedAt === null) {
			navigate({ session: row.id, conversation: row.main });
			return;
		}
		if (!familiar) return;
		setOpening(true);
		void familiar
			.open(BACKGROUND_CONTEXT)
			.then(({ id }) => navigate({ session: id }))
			.catch(fail)
			.finally(() => setOpening(false));
	};
	return (
		<div className="familiar-group">
			<button
				type="button"
				className={`session-main familiar-entry ${row && route.session === row.id ? "active" : ""}`}
				disabled={opening || (!row && !(familiar && connected))}
				onClick={open}
			>
				<SparkIcon size={16} />
				<span className="session-title">{row?.title ?? FAMILIAR_TITLE}</span>
				<span className="session-meta">
					{row ? <SessionDot worker={row.worker} /> : null}
					{opening ? "Opening…" : "Your sessions"}
				</span>
			</button>
		</div>
	);
}

export default defineFacet((host) => {
	contribute(host, "p2.web-familiar", (self) => {
		self.contribute(Slots, { "drawer-head:familiar": FamiliarEntry });
	});
});
