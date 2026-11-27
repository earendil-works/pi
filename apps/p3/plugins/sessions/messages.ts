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
		kindSession: "Session",
		kindDefaults: "Session defaults",
		notInSession: "You have no access to this session.",
		archived: "This session is archived.",
		noMachine: (machine: string) => `There is no machine ${machine} here.`,
		noWork: (machine: string) => `The agents here have no Work on machine ${machine}.`,
		notYourMachine: (machine: string) => `Machine ${machine} is not available to you here.`,
		notFullPath: "A folder is a full path, starting with /.",
		machine: "Machine",
		folder: "Folder",
		folderHint: "Where the agent works on that machine. Leave it empty for a folder of the session's own.",
	},
});
