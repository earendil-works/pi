// A step's words with its kind's icon: a verb, then what it acted on (a file in bold, a command in the code font, the
// agent's own words as they are), then a quiet extra such as a count.
import type { ReactNode } from "react";
import {
	ArtifactIcon,
	BotIcon,
	CodeIcon,
	ConversationIcon,
	FileIcon,
	PencilIcon,
	PortIcon,
	RefreshIcon,
	SearchIcon,
	TerminalIcon,
	ToolIcon,
} from "./icons.tsx";
import type { Kind, Label } from "./model.ts";

const ICONS: Record<Kind, () => ReactNode> = {
	command: () => <TerminalIcon />,
	search: () => <SearchIcon />,
	handoff: () => <RefreshIcon />,
	read: () => <FileIcon />,
	edit: () => <PencilIcon />,
	script: () => <CodeIcon />,
	agent: () => <BotIcon />,
	artifact: () => <ArtifactIcon />,
	file: () => <FileIcon />,
	port: () => <PortIcon />,
	message: () => <ConversationIcon />,
	tool: () => <ToolIcon />,
};

export const KindIcon = ({ kind }: { kind: Kind }) => ICONS[kind]();

export function LabelText({ label }: { label: Label }) {
	return (
		<span className="label-text" data-kind={label.kind}>
			{label.verb && <span className="label-verb">{label.verb}</span>}
			{label.verb && label.object ? " " : null}
			{label.object && (
				<span className="label-object" data-style={label.style}>
					{label.object}
				</span>
			)}
			{label.extra && <span className="label-extra"> · {label.extra}</span>}
		</span>
	);
}
