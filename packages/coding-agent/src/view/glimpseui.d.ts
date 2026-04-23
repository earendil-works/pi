declare module "glimpseui" {
	import { EventEmitter } from "node:events";

	export interface ScreenInfo {
		width: number;
		height: number;
	}

	export interface GlimpseWindowInfo {
		screen?: ScreenInfo;
		screens?: ScreenInfo[];
		appearance?: string;
		cursor?: { x: number; y: number };
		cursorTip?: { x: number; y: number } | null;
	}

	export interface OpenOptions {
		width?: number;
		height?: number;
		title?: string;
		frameless?: boolean;
		floating?: boolean;
		transparent?: boolean;
		clickThrough?: boolean;
		noDock?: boolean;
		hidden?: boolean;
		autoClose?: boolean;
		openLinks?: boolean;
		openLinksApp?: string;
		followCursor?: boolean;
		cursorOffset?: { x?: number; y?: number };
		cursorAnchor?: "top-left" | "top-right" | "left" | "right" | "bottom-left" | "bottom-right";
		followMode?: "snap" | "spring";
		x?: number;
		y?: number;
	}

	export class GlimpseWindow extends EventEmitter {
		send(js: string): void;
		setHTML(html: string): void;
		show(options?: { title?: string }): void;
		close(): void;
		loadFile(path: string): void;
		get info(): GlimpseWindowInfo | null;
		getInfo(): void;
		followCursor(enabled: boolean, anchor?: string, mode?: string): void;
		on(event: "ready", listener: (info: GlimpseWindowInfo) => void): this;
		on(event: "info", listener: (info: GlimpseWindowInfo) => void): this;
		on(event: "message", listener: (data: Record<string, unknown>) => void): this;
		on(event: "click", listener: () => void): this;
		on(event: "closed", listener: () => void): this;
		on(event: "error", listener: (err: Error) => void): this;
	}

	export function open(html: string, options?: OpenOptions): GlimpseWindow;

	export interface NativeHostInfo {
		path: string;
		platform: string;
		buildHint: string;
		extraArgs?: string[];
	}

	export function getNativeHostInfo(): NativeHostInfo;
	export function getFollowCursorSupport(): {
		supported: boolean;
		reason?: string;
	};
	export function supportsFollowCursor(): boolean;
}
