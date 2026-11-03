// Owner notices (browser-safe): errors and results the server reports to the owner (refused reloads, failed workers),
// served by the logs plugin and shown by every owner page and TUI.

import { method, remote } from "@earendil-works/chord";
import { arr, num, obj, str } from "@earendil-works/pi-schema";
import { serverHost } from "./chord.ts";

export const NoticesSchema = arr(
	obj({
		id: num(),
		time: num(),
		source: str(),
		message: str(),
	}),
);

export const LogNotices = remote("p2.log-notices", {
	version: 1,
	params: {},
	hostAddress: serverHost,
	variants: {
		owner: {
			state: { notices: NoticesSchema },
			methods: { dismiss: method(obj({ id: num() })) },
		},
	},
});
