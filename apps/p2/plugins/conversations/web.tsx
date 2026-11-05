import { BACKGROUND_CONTEXT, contribute, defineFacet, liveIn } from "@p2/app/v1";
import {
	navigate,
	OpenPeerConversation,
	Slots,
	useComposerState,
	useConnected,
	useObject,
	useReadable,
} from "@p2/app/v1/web";
import type { ReactNode } from "react";
import { Sessions } from "../sessions/contract.ts";

function Attribution({ children }: { children?: ReactNode }) {
	const sessions = useObject(Sessions, {});
	const listed = useReadable(liveIn(sessions, "owner", "guest")?.sessions) ?? [];
	const owner = liveIn(sessions, "owner");
	// As Pi Mobile: peer labels link only while connected; errors go to the app's toast.
	const connected = useConnected();
	const { setError, fail } = useComposerState();
	const open = (session: string): void => {
		const current = listed.find((entry) => entry.id === session);
		if (!current) {
			setError("The source conversation is unavailable");
			return;
		}
		if (current.archivedAt === null) navigate({ session });
		// An archived source opens once restored (the view refuses an archived session).
		else
			void owner
				?.restore({ id: session }, BACKGROUND_CONTEXT)
				.then(() => navigate({ session }))
				.catch(fail);
	};
	return (
		<OpenPeerConversation.Provider value={owner && connected ? open : undefined}>
			{children}
		</OpenPeerConversation.Provider>
	);
}

export default defineFacet((host) => {
	contribute(host, "p2.web-conversations", (self) => {
		self.contribute(Slots, { "chat-attribution": Attribution });
	});
});
