import { bool, nul, num, obj, str, union } from "@earendil-works/pi-schema";
import { method, param, remote, sessionHost } from "@p2/app/v1";

/** A text preview reads at most this many bytes of a sent file (the rest is a download). */
export const MAX_SENT_PREVIEW = 256 * 1024;

/**
 * A sent file's text preview for clients that cannot use the `/download` route (the TUI's worker has no cookie). Same
 * authority as the route: anyone who may view the session. `text` is null for binary files (a NUL byte or invalid
 * UTF-8 in the first `MAX_SENT_PREVIEW` bytes).
 */
export const SentFiles = remote("p2.sent-files", {
	version: 1,
	params: { session: param.str() },
	hostAddress: sessionHost,
	variants: {
		reader: {
			methods: {
				preview: method(
					obj({ id: str({ maxLength: 64 }) }),
					obj({
						name: str(),
						size: num(),
						text: union([str(), nul()]),
						truncated: bool(),
					}),
				),
			},
		},
	},
});
