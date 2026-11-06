import { contribute, defineFacet } from "@p2/app/v1";
import { Slots, TerminalIcon, ToolActivities, useNavigation, useObject, useOwner, useRoute } from "@p2/app/v1/web";
import { useState } from "react";
import { terminalActivity } from "./activity.tsx";
import { Terminals } from "./contract.ts";
import { setTerminalPlacement, TerminalPanel, TerminalView, terminalPlacement } from "./Terminal.tsx";

function Surface({ bottom }: { bottom: boolean }) {
	const nav = useNavigation();
	const route = useRoute();
	const [view] = useState(() => crypto.randomUUID());
	const owner = useOwner();
	const open = bottom ? route.terminal !== undefined : route.workspace?.tab === "terminal";
	const control = useObject(Terminals, route.session && open && owner ? { session: route.session, view } : undefined);
	if (!route.session || !open || !owner) return null;
	const session = route.session;
	const terminalId = bottom ? route.terminal : route.workspace?.terminal;
	const hide = () =>
		void nav.close((current) =>
			bottom ? { ...current, terminal: undefined, startTerminal: undefined } : { ...current, workspace: undefined },
		);
	const props = {
		control,
		conversation: route.conversation ?? 1,
		terminalId: terminalId || undefined,
		start: bottom ? route.startTerminal === true : route.workspace?.startTerminal === true,
		onTerminal: (id: string) => {
			// A late attachment never changes another session or reopens a hidden panel.
			const current = nav.route;
			if (
				current.session !== session ||
				(bottom ? current.terminal === undefined : current.workspace?.tab !== "terminal")
			)
				return;
			if (bottom) {
				if (current.terminal !== id || current.startTerminal)
					void nav.replace({ ...current, terminal: id, startTerminal: undefined }, current);
			} else if (current.workspace?.terminal !== id || current.workspace?.startTerminal) {
				void nav.replace(
					{
						...current,
						workspace: { ...current.workspace!, terminal: id, startTerminal: undefined },
					},
					current,
				);
			}
		},
		onMove: (id: string | undefined) => {
			setTerminalPlacement(bottom ? "side" : "bottom");
			void nav.replace(
				bottom
					? {
							...nav.route,
							terminal: undefined,
							startTerminal: undefined,
							// The workspace keeps its folder (Pi Mobile).
							workspace: { tab: "terminal", directory: nav.route.workspace?.directory ?? "", terminal: id },
						}
					: { ...nav.route, workspace: undefined, terminal: id ?? "", startTerminal: undefined },
			);
		},
		...(bottom ? { onHide: hide } : {}),
	};
	return bottom ? (
		<TerminalPanel key={session} {...props} />
	) : (
		<TerminalView key={session} {...props} placement="side" />
	);
}

function TerminalButton() {
	const nav = useNavigation();
	const route = useRoute();
	if (!useOwner() || !route.session) return null;
	const open = route.terminal !== undefined || route.workspace?.tab === "terminal";
	return (
		<button
			type="button"
			className={`icon-button workspace-toggle ${open ? "on" : ""}`}
			aria-label="Terminal"
			aria-pressed={open}
			onClick={() => {
				if (route.terminal !== undefined)
					void nav.close((current) => ({ ...current, terminal: undefined, startTerminal: undefined }));
				else if (route.workspace?.tab === "terminal")
					void nav.close((current) => ({ ...current, workspace: undefined }));
				else if (terminalPlacement() === "bottom") void nav.push({ ...route, terminal: "", startTerminal: true });
				else
					void nav.push({
						...route,
						workspace: { tab: "terminal", directory: route.workspace?.directory ?? "", startTerminal: true },
					});
			}}
		>
			<TerminalIcon size={20} />
		</button>
	);
}

function BottomTerminal() {
	return <Surface bottom />;
}
function WorkspaceTerminal() {
	return <Surface bottom={false} />;
}

export default defineFacet((host) => {
	contribute(host, "p2.web-terminals", (self) => {
		self.contribute(Slots, {
			"terminal-actions": TerminalButton,
			"chat-bottom": BottomTerminal,
			"workspace-terminal": WorkspaceTerminal,
		});
		self.contribute(ToolActivities, { terminal: terminalActivity });
	});
});
