// Native catalog operations beneath the copied mobile Session sheet.
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import {
	closeLayers,
	conversationRoute,
	MoreIcon,
	openLayer,
	useComposerState,
	useNavigation,
	useObject,
	useReadable,
	useRoute,
	useSheet,
} from "@p2/app/v1/web";
import { directoryPickerLayer } from "../envs/contract.web.tsx";
import { Sessions } from "./contract.ts";
import { SessionSheet } from "./SessionSheet.tsx";
export function SessionOptions() {
	const nav = useNavigation(),
		route = useRoute();
	const service = useObject(Sessions, {}, { variant: "owner" }),
		rows = useReadable(service?.sessions);
	const session = rows?.find((row) => row.id === route.session),
		sessionSheet = useSheet("session");
	const { setError } = useComposerState();
	const perform = (operation: Promise<unknown> | undefined) =>
		void operation?.catch((error) => setError(error instanceof Error ? error.message : String(error)));
	if (!service || !session || route.conversation !== 1) return null;
	return (
		<>
			<button
				type="button"
				className="icon-button"
				aria-label="Session options"
				onClick={() => openLayer({ kind: "sheet", name: "session" })}
			>
				<MoreIcon />
			</button>
			{sessionSheet && (
				<SessionSheet
					session={session}
					onClose={closeLayers}
					onRename={(title) => perform(service?.rename({ id: session.id, title }, BACKGROUND_CONTEXT))}
					onPin={() => perform(service?.pin({ id: session.id, pinned: !session.pinned }, BACKGROUND_CONTEXT))}
					onShare={() => openLayer({ kind: "sheet", name: "share" })}
					onCwd={() => openLayer(directoryPickerLayer(session.env ?? null, session.cwd))}
					onArchive={() => {
						closeLayers();
						void nav.replace(conversationRoute(route, undefined));
						perform(service?.archive({ id: session.id }, BACKGROUND_CONTEXT));
					}}
				/>
			)}
		</>
	);
}
