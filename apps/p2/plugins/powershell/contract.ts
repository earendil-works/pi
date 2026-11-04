import { bool } from "@earendil-works/pi-schema";
import { local, record } from "@p2/app/v1";

/**
 * Which of this worker's conversations are offered PowerShell (host-internal), by conversation ID: those working on
 * Windows (their location's machine) with the shell tool (`bash`) enabled.
 */
export const PowerShell = local("p2.powershell", {
	// 2: per conversation location.
	version: 2,
	params: {},
	members: { offered: record(bool()) },
});

/** The extension offering Durable's `powershell` tool. */
export const POWERSHELL_EXTENSION = "p2-powershell";
export const POWERSHELL_TOOL = "powershell";
