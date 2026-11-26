// The sessions plugin's texts people see (decision 65): its ticks' labels, and what its refusals and denials say.
// Every facet that renders imports it; the server and the worker build them as data (`messages.message("…")`).

import { defineMessages } from "@earendil-works/p3/v1";

/** The sessions plugin's messages, by key. */
export const messages = defineMessages("sessions", {
	en: {
		tickRead: "Read",
		tickSend: "Send",
		tickStop: "Stop",
		tickManage: "Manage",
		tickUseDefaults: "Use",
		notInSession: "You have no access to this session.",
		noMachine: (machine: string) => `There is no machine ${machine} here.`,
		machine: "Machine",
		folder: "Folder",
		folderHint: "Where the agent works on that machine. Leave it empty for a folder of the session's own.",
	},
});
