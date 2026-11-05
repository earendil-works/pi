import type { ReactNode } from "react";

function Icon({ children, size = 20 }: { children: ReactNode; size?: number }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			{children}
		</svg>
	);
}

export const MenuIcon = () => (
	<Icon>
		<path d="M4 7h16M4 12h16M4 17h10" />
	</Icon>
);
export const PlusIcon = ({ size }: { size?: number }) => (
	<Icon size={size}>
		<path d="M12 5v14M5 12h14" />
	</Icon>
);
export const SendIcon = () => (
	<Icon>
		<path d="M12 19V5M5 12l7-7 7 7" />
	</Icon>
);
export const StopIcon = () => (
	<svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
		<rect x="3.5" y="3.5" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.75" />
	</svg>
);
export const CloseIcon = () => (
	<Icon>
		<path d="M6 6l12 12M18 6L6 18" />
	</Icon>
);
export const SearchIcon = ({ size = 16 }: { size?: number }) => (
	<Icon size={size}>
		<circle cx="11" cy="11" r="7" />
		<path d="M20 20l-3.5-3.5" />
	</Icon>
);
export const ChevronIcon = ({ size = 16 }: { size?: number }) => (
	<Icon size={size}>
		<path d="M9 6l6 6-6 6" />
	</Icon>
);
export const DownIcon = () => (
	<Icon size={18}>
		<path d="M12 5v14M5 12l7 7 7-7" />
	</Icon>
);
export const DownloadIcon = () => (
	<Icon size={18}>
		<path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
	</Icon>
);
export const MoreIcon = () => (
	<Icon>
		<circle cx="5" cy="12" r="1" />
		<circle cx="12" cy="12" r="1" />
		<circle cx="19" cy="12" r="1" />
	</Icon>
);
export const ArtifactIcon = () => (
	<Icon>
		<rect x="3.5" y="3.5" width="7" height="7" rx="1" />
		<circle cx="17" cy="7" r="3.5" />
		<path d="M7 13.5l4 7H3z" />
		<rect x="13.5" y="13.5" width="7" height="7" rx="3.5" />
	</Icon>
);
export const PinIcon = ({ size = 18 }: { size?: number }) => (
	<Icon size={size}>
		<path d="M12 17v5M8 3h8l-1 6 3 4H6l3-4z" />
	</Icon>
);
export const SparkIcon = ({ size = 18 }: { size?: number }) => (
	<Icon size={size}>
		<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
	</Icon>
);
export const FolderIcon = ({ size = 16 }: { size?: number }) => (
	<Icon size={size}>
		<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
	</Icon>
);
/** A window with a prompt. */
export const TerminalIcon = ({ size = 15 }: { size?: number }) => (
	<Icon size={size}>
		<rect x="2.5" y="4" width="19" height="16" rx="2" />
		<path d="M7 9.5l3 2.5-3 2.5M12.5 15H17" />
	</Icon>
);
/** Plus over minus: changed files. */
export const DiffIcon = () => (
	<Icon>
		<path d="M12 4v10M7 9h10M7 19h10" />
	</Icon>
);
export const CommentIcon = () => (
	<Icon>
		<path d="M20 15a2 2 0 0 1-2 2H8l-4 4V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z" />
	</Icon>
);
export const ReplyIcon = () => (
	<Icon size={16}>
		<path d="M9 14 4 9l5-5" />
		<path d="M4 9h11a5 5 0 0 1 5 5v3" />
	</Icon>
);
export const RefreshIcon = () => (
	<Icon>
		<path d="M20 12a8 8 0 1 1-2.34-5.66L20 8.5M20 4v4.5h-4.5" />
	</Icon>
);
export const FileIcon = () => (
	<Icon size={15}>
		<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
		<path d="M14 3v5h5" />
	</Icon>
);
/** A fork in a line: a `/tree` branch. */
export const BranchIcon = ({ size = 15 }: { size?: number }) => (
	<Icon size={size}>
		<circle cx="6" cy="5" r="2" />
		<circle cx="6" cy="19" r="2" />
		<circle cx="18" cy="7" r="2" />
		<path d="M6 7v10M18 9c0 5-12 3-12 8" />
	</Icon>
);
export const PencilIcon = () => (
	<Icon size={15}>
		<path d="M4 20h4L19 9l-4-4L4 16z" />
	</Icon>
);
/** Angle brackets: code mode scripts. */
export const CodeIcon = () => (
	<Icon size={15}>
		<path d="M8 7l-5 5 5 5M16 7l5 5-5 5" />
	</Icon>
);
export const ToolIcon = () => (
	<Icon size={15}>
		<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-2.4z" />
	</Icon>
);
export const CheckIcon = () => (
	<Icon size={14}>
		<path d="M5 12l5 5 9-10" />
	</Icon>
);
export const AlertIcon = () => (
	<Icon size={14}>
		<path d="M12 8v5M12 17h.01" />
		<circle cx="12" cy="12" r="9" />
	</Icon>
);
export const BotIcon = () => (
	<Icon size={15}>
		<rect x="4" y="8" width="16" height="12" rx="3" />
		<path d="M12 4v4M9 13h.01M15 13h.01M9 17h6" />
	</Icon>
);
export const UsersIcon = () => (
	<Icon size={13}>
		<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
		<circle cx="9" cy="7" r="4" />
	</Icon>
);
export const CopyIcon = () => (
	<Icon size={15}>
		<rect x="9" y="9" width="11" height="11" rx="2" />
		<path d="M5 15V6a2 2 0 0 1 2-2h8" />
	</Icon>
);
export const SunIcon = () => (
	<Icon size={16}>
		<circle cx="12" cy="12" r="4" />
		<path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
	</Icon>
);
export const MoonIcon = () => (
	<Icon size={16}>
		<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />
	</Icon>
);
/** Half-filled circle: follow the system light/dark setting. */
export const SystemThemeIcon = () => (
	<Icon size={16}>
		<circle cx="12" cy="12" r="8" />
		<path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" />
	</Icon>
);
export const AttachIcon = () => (
	<Icon size={16}>
		<path d="M20 11.5l-8.2 8.2a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7L9.4 17.3a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8" />
	</Icon>
);
/** A panel docked at the bottom of a window: the terminal's bottom position. */
export const PanelBottomIcon = () => (
	<Icon size={18}>
		<rect x="3" y="4" width="18" height="16" rx="2" />
		<path d="M3 14h18" />
	</Icon>
);
/** A panel docked at the side of a window: the terminal's side (workspace) position. */
export const PanelSideIcon = () => (
	<Icon size={18}>
		<rect x="3" y="4" width="18" height="16" rx="2" />
		<path d="M14 4v16" />
	</Icon>
);
/** A keyboard: the terminal's row of extra keys. */
export const KeyboardIcon = () => (
	<Icon size={18}>
		<rect x="2" y="6" width="20" height="12" rx="2" />
		<path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" />
	</Icon>
);
/** Hide a panel without closing what it shows. */
export const HideIcon = () => (
	<Icon size={18}>
		<path d="M6 9l6 6 6-6" />
	</Icon>
);
