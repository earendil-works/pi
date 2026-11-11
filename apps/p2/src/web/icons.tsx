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
/** A padlock: a sandboxed environment. */
export const LockIcon = ({ size = 14 }: { size?: number }) => (
	<Icon size={size}>
		<rect x="5" y="11" width="14" height="10" rx="2" />
		<path d="M8 11V7a4 4 0 0 1 8 0v4" />
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
export const ReplyIcon = ({ size = 16 }: { size?: number }) => (
	<Icon size={size}>
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
/** Angle brackets: scripts. */
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
/** A gear: the server's settings. */
export const SettingsIcon = () => (
	<Icon size={16}>
		<path d="M12.2 2h-.4a2 2 0 0 0-2 2v.2a2 2 0 0 1-1 1.7l-.4.3a2 2 0 0 1-2 0l-.2-.1a2 2 0 0 0-2.7.7l-.2.4a2 2 0 0 0 .7 2.7l.2.1a2 2 0 0 1 1 1.7v.5a2 2 0 0 1-1 1.7l-.2.1a2 2 0 0 0-.7 2.7l.2.4a2 2 0 0 0 2.7.7l.2-.1a2 2 0 0 1 2 0l.4.3a2 2 0 0 1 1 1.7v.2a2 2 0 0 0 2 2h.4a2 2 0 0 0 2-2v-.2a2 2 0 0 1 1-1.7l.4-.3a2 2 0 0 1 2 0l.2.1a2 2 0 0 0 2.7-.7l.2-.4a2 2 0 0 0-.7-2.7l-.2-.1a2 2 0 0 1-1-1.7v-.5a2 2 0 0 1 1-1.7l.2-.1a2 2 0 0 0 .7-2.7l-.2-.4a2 2 0 0 0-2.7-.7l-.2.1a2 2 0 0 1-2 0l-.4-.3a2 2 0 0 1-1-1.7V4a2 2 0 0 0-2-2z" />
		<circle cx="12" cy="12" r="3" />
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
/** A box with a lid: archive a session. */
export const ArchiveIcon = ({ size = 16 }: { size?: number }) => (
	<Icon size={size}>
		<rect x="3" y="4" width="18" height="4" rx="1" />
		<path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4" />
	</Icon>
);
/** An arrow out of the archive box: restore an archived session. */
export const RestoreIcon = ({ size = 16 }: { size?: number }) => (
	<Icon size={size}>
		<rect x="3" y="4" width="18" height="4" rx="1" />
		<path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M12 17v-6M9.5 13.5 12 11l2.5 2.5" />
	</Icon>
);
/** Lines with bullets: a list to pick from (Switch session…). */
export const ListIcon = ({ size = 16 }: { size?: number }) => (
	<Icon size={size}>
		<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01" />
	</Icon>
);
/** A chip: a model. */
export const ModelIcon = ({ size = 16 }: { size?: number }) => (
	<Icon size={size}>
		<rect x="6" y="6" width="12" height="12" rx="2" />
		<path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" />
	</Icon>
);
/** A light bulb: the thinking level. */
export const ThinkingIcon = ({ size = 16 }: { size?: number }) => (
	<Icon size={size}>
		<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9V16h7v-2.1A6 6 0 0 0 12 3z" />
	</Icon>
);
/** Three linked nodes: share a session. */
export const ShareIcon = ({ size = 16 }: { size?: number }) => (
	<Icon size={size}>
		<circle cx="18" cy="5" r="3" />
		<circle cx="6" cy="12" r="3" />
		<circle cx="18" cy="19" r="3" />
		<path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4" />
	</Icon>
);
/** A window with a bar at its start: the sidebar (Show sidebar, Hide sidebar). */
export const SidebarIcon = ({ size = 16 }: { size?: number }) => (
	<Icon size={size}>
		<rect x="3" y="4" width="18" height="16" rx="2" />
		<path d="M9 4v16" />
	</Icon>
);
/** An eye: show a view. */
export const EyeIcon = ({ size = 16 }: { size?: number }) => (
	<Icon size={size}>
		<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
		<circle cx="12" cy="12" r="3" />
	</Icon>
);
/** An eye struck through: hide a view. */
export const EyeOffIcon = ({ size = 16 }: { size?: number }) => (
	<Icon size={size}>
		<path d="M10.6 5.1A9.8 9.8 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-2.2 3.2M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2M3 3l18 18" />
	</Icon>
);
/** A bookmark: a saved view. */
export const BookmarkIcon = ({ size = 16 }: { size?: number }) => (
	<Icon size={size}>
		<path d="M6 3h12v18l-6-4-6 4z" />
	</Icon>
);
/** A folder with a plus: a new session in a folder. */
export const FolderPlusIcon = ({ size = 16 }: { size?: number }) => (
	<Icon size={size}>
		<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
		<path d="M12 10v6M9 13h6" />
	</Icon>
);
/** A folder with an arrow into it: change a session's working directory. */
export const FolderMoveIcon = ({ size = 16 }: { size?: number }) => (
	<Icon size={size}>
		<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
		<path d="M8 13h7M12.5 10.5l2.5 2.5-2.5 2.5" />
	</Icon>
);
