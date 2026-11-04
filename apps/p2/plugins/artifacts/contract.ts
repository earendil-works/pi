import { arr, bool, int, obj, str } from "@earendil-works/pi-schema";
import { ArtifactInfoSchema, method, param, remote, sessionHost } from "@p2/app/v1";

export { type ArtifactInfo, ArtifactInfoSchema } from "@p2/app/v1";

/** The complete per-conversation index, independent of compaction/reset and transcript paging. */
export const ArtifactList = remote("p2.artifact-list", {
	version: 1,
	params: { session: param.str(), conversation: param.int() },
	hostAddress: sessionHost,
	variants: { reader: { state: { artifacts: arr(ArtifactInfoSchema) } } },
});

/** Inline previews read at most this much of an artifact (the rest is a download). */
export const MAX_ARTIFACT_PREVIEW = 512 * 1024;

/**
 * An artifact's content for clients that cannot use the `/artifact` route (the TUI's worker has no cookie): text and
 * Markdown are shown inline, HTML and SVG as source. Same authority as the route: anyone who may view the session.
 * At most `MAX_ARTIFACT_PREVIEW` characters; `truncated` says there is more.
 */
export const ArtifactContent = remote("p2.artifact-content", {
	version: 1,
	params: { session: param.str() },
	hostAddress: sessionHost,
	variants: {
		reader: {
			methods: {
				read: method(
					obj({ name: str({ maxLength: 64 }), version: int({ minimum: 1 }) }),
					obj({ info: ArtifactInfoSchema, content: str(), truncated: bool() }),
				),
			},
		},
	},
});
