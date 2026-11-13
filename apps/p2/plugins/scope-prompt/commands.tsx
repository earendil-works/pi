// The scope prompt's part of the command menu: "Prompt anywhere" switches pointing mode on (mode.ts), "Stop prompting
// anywhere" off; the owner's only, as the overlay is.
import { type Command, CommentIcon } from "@p2/app/v1/web";
import type { ReactNode } from "react";
import { setPointing, usePointing } from "./mode.ts";

/** The commands, by id. */
export const SCOPE_COMMANDS: Readonly<Record<string, Command>> = {
	"scope-prompt.start": {
		title: "Prompt anywhere",
		group: "Ask Pi",
		order: 70,
		icon: CommentIcon,
		keywords: ["point", "scope", "ask pi", "familiar", "pick"],
		owner: true,
		Shown: NotPointing,
		action: { kind: "run", run: () => setPointing(true) },
	},
	"scope-prompt.stop": {
		title: "Stop prompting anywhere",
		group: "Ask Pi",
		order: 70,
		icon: CommentIcon,
		keywords: ["point", "scope"],
		owner: true,
		Shown: Pointing,
		action: { kind: "run", run: () => setPointing(false) },
	},
};

function NotPointing({ children }: { children: ReactNode }) {
	return usePointing() ? null : children;
}

function Pointing({ children }: { children: ReactNode }) {
	return usePointing() ? children : null;
}
