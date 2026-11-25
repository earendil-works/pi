// PowerShell's TUI facet: its card is the shared shell card with PowerShell's prompt.
import { contribute, defineFacet } from "@p2/app/v1";
import { createShellRenderers, TuiToolRenderers } from "@p2/app/v1/tui";
import { POWERSHELL_TOOL } from "./contract.ts";

/** PowerShell's card. */
export const powershellRenderers = createShellRenderers("PS>");

export default defineFacet((host) => {
	contribute(host, "p2.tui-powershell", (self) => {
		self.contribute(TuiToolRenderers, { [POWERSHELL_TOOL]: powershellRenderers });
	});
});
