import { BACKGROUND_CONTEXT, contribute, defineFacet, liveIn } from "@p2/app/v1";
import {
	navigate,
	OpenPeerConversation,
	Slots,
	useComposerState,
	useConnected,
	useObject,
	useReadable,
	useStatus,
} from "@p2/app/v1/web";
import type { ReactNode } from "react";
import { Sessions } from "../sessions/contract.ts";

function Attribution({ children }: { children?: ReactNode }) {
	const sessions = useObject(Sessions, {});
	const listed = useReadable(liveIn(sessions, "owner", "guest")?.sessions) ?? [];
	const owner = useStatus(sessions) === "live" ? liveIn(sessions, "owner") : undefined;
	// As Pi Mobile: peer labels link only while connected; errors go to the app's toast.
	const connected = useConnected();
	const { setError } = useComposerState();
	const open = (session: string): void => {
		const current = listed.find((entry) => entry.id === session);
		if (!current) {
			setError("The source conversation is unavailable");
			return;
		}
		if (current.archivedAt === null) navigate({ session });
		else
			void owner
				?.restore({ id: session }, BACKGROUND_CONTEXT)
				.then(() => navigate({ session }))
				.catch((error: unknown) => setError(error instanceof Error ? error.message : String(error)));
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
