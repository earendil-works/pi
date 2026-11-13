// The scope prompt (Overlay.tsx): in pointing mode (a double tap of Cmd, Ctrl elsewhere; Cmd+.; the command menu's
// "Prompt anywhere"; its button, Toggle.tsx) what is under the pointer is outlined, and a click opens a composer that
// asks the open conversation or the Familiar about it. An overlay over the whole page (`overlay:` slots); nothing else of the page
// changes. The worker facet carries a prompt's scope with its message (`ScopeStage`).
import { contribute, defineFacet } from "@p2/app/v1";
import { Commands, Slots } from "@p2/app/v1/web";
import { SCOPE_COMMANDS } from "./commands.tsx";
import { ScopePrompt } from "./Overlay.tsx";
import { ScopeToggle } from "./Toggle.tsx";
import "./style.css";

export default defineFacet((host) => {
	contribute(host, "p2.web-scope-prompt", (self) => {
		self.contribute(Slots, {
			"overlay:scope-prompt": ScopePrompt,
			"sidebar-header:scope-prompt": ScopeToggle,
			"topbar-start:scope-prompt": ScopeToggle,
		});
		self.contribute(Commands, SCOPE_COMMANDS);
	});
});
