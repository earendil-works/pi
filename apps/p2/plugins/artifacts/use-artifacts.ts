// A session's artifacts as the page holds them (`Artifacts`, as a reader or an editor): the live list, and reading and
// removing one, for the panes, the artifact kinds and the sheet.
import { liveWith } from "@p2/app/v1";
import { useObject, useReadable, useStatus } from "@p2/app/v1/web";
import { type ArtifactSummary, Artifacts } from "./contract.ts";

/** The session's artifacts: the list (undefined while it loads), the reader, and the editor (people who may send). */
export function useArtifacts(session: string | undefined) {
	const ref = useObject(Artifacts, session === undefined ? undefined : { session });
	useStatus(ref);
	const editor = liveWith(ref, "artifacts", "remove");
	const reader = liveWith(ref, "artifacts");
	const list: readonly ArtifactSummary[] | undefined = useReadable(reader?.artifacts);
	return { list, reader, editor };
}
