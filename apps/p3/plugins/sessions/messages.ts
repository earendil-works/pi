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
		notFullPath: "A folder is a full path, starting with /.",
		tooManyMoved: (max: number) => `This session has ${max} conversations moved already: undo a move first.`,
		noMachineHere:
			"This device is not available to you here: the session starts on no machine, and its agent runs no commands until someone who may use a machine here moves it.",
		machine: "Machine",
		folder: "Folder",
		folderHint: "Where the agent works on that machine. Leave it empty for a folder of the session's own.",
	},
});
