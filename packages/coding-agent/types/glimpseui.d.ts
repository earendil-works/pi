declare module "glimpseui" {
	export interface GlimpseWindow {
		on(event: string, callback: () => void): void;
	}

	export interface OpenOptions {
		width?: number;
		height?: number;
		title?: string;
	}

	export function open(html: string, options?: OpenOptions): GlimpseWindow;
}
