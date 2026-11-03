import { arr, num, obj, type Static, str, union } from "@earendil-works/pi-schema";
import { literal, param, remote, serverHost } from "@p2/app/v1";

export const LogLineSchema = obj({
	id: num(),
	time: num(),
	level: union([literal("stdout"), literal("stderr"), literal("event"), literal("error")]),
	text: str(),
});
export type LogLine = Static<typeof LogLineSchema>;
export const LogSourcesSchema = arr(obj({ id: str(), lines: num(), updatedAt: num() }));

export { LogNotices, NoticesSchema } from "@p2/app/v1";

/** Owner-only diagnostics. Changing source acquires a new view, not a new worker. */
export const Logs = remote("p2.logs", {
	version: 1,
	params: { source: param.str({ max: 128 }) },
	hostAddress: serverHost,
	variants: {
		owner: { state: { sources: LogSourcesSchema, lines: arr(LogLineSchema) } },
	},
});
