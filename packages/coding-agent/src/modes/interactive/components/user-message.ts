import type { ImageContent, TextContent } from "@earendil-works/pi-ai/compat";
import {
	Box,
	Container,
	getCapabilities,
	getImageDimensions,
	Image,
	imageFallback,
	Markdown,
	type MarkdownTheme,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";
import { convertToPng } from "../../../utils/image-convert.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

export interface UserMessageOptions {
	showImages?: boolean;
	imageWidthCells?: number;
	requestRender?: () => void;
}

function normalizeContent(content: string | (TextContent | ImageContent)[]): (TextContent | ImageContent)[] {
	return typeof content === "string" ? [{ type: "text", text: content }] : content;
}

/**
 * Component that renders a user message
 */
export class UserMessageComponent extends Container {
	private content: (TextContent | ImageContent)[];
	private markdownTheme: MarkdownTheme;
	private outputPad: number;
	private showImages: boolean;
	private imageWidthCells: number;
	private requestRender: (() => void) | undefined;
	private convertedImages = new Map<number, { data: string; mimeType: string }>();

	constructor(
		content: string | (TextContent | ImageContent)[],
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		outputPad = 1,
		options: UserMessageOptions = {},
	) {
		super();
		this.content = normalizeContent(content);
		this.markdownTheme = markdownTheme;
		this.outputPad = outputPad;
		this.showImages = options.showImages ?? true;
		this.imageWidthCells = options.imageWidthCells ?? 60;
		this.requestRender = options.requestRender;
		this.rebuild();
		void this.maybeConvertImagesForKitty();
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		this.rebuild();
	}

	setShowImages(show: boolean): void {
		this.showImages = show;
		this.rebuild();
	}

	setImageWidthCells(width: number): void {
		this.imageWidthCells = Math.max(1, Math.floor(width));
		this.rebuild();
	}

	private async maybeConvertImagesForKitty(): Promise<void> {
		const caps = getCapabilities();
		if (caps.images !== "kitty") return;

		const images = this.content.filter((content): content is ImageContent => content.type === "image");
		for (const [index, image] of images.entries()) {
			if (!image.data || !image.mimeType || image.mimeType === "image/png" || this.convertedImages.has(index)) {
				continue;
			}
			const converted = await convertToPng(image.data, image.mimeType);
			if (converted) {
				this.convertedImages.set(index, converted);
				this.rebuild();
				this.requestRender?.();
			}
		}
	}

	private rebuild(): void {
		this.clear();
		const text = this.content
			.filter((content): content is TextContent => content.type === "text")
			.map((content) => content.text)
			.join("");
		const images = this.content.filter((content): content is ImageContent => content.type === "image");

		if (text) {
			const contentBox = new Box(this.outputPad, 1, (content: string) => theme.bg("userMessageBg", content));
			contentBox.addChild(
				new Markdown(
					text,
					0,
					0,
					this.markdownTheme,
					{
						color: (content: string) => theme.fg("userMessageText", content),
					},
					{ preserveOrderedListMarkers: true, preserveBackslashEscapes: true },
				),
			);
			this.addChild(contentBox);
		}

		for (const [index, image] of images.entries()) {
			if (!image.data || !image.mimeType) continue;
			if (this.children.length > 0) {
				this.addChild(new Spacer(1));
			}

			const dimensions = getImageDimensions(image.data, image.mimeType) ?? undefined;
			const caps = getCapabilities();
			if (!this.showImages || !caps.images) {
				this.addChild(
					new Text(theme.fg("userMessageText", imageFallback(image.mimeType, dimensions)), this.outputPad, 0),
				);
				continue;
			}

			const converted = this.convertedImages.get(index);
			const imageData = converted?.data ?? image.data;
			const imageMimeType = converted?.mimeType ?? image.mimeType;
			if (caps.images === "kitty" && imageMimeType !== "image/png") {
				this.addChild(
					new Text(theme.fg("userMessageText", imageFallback(image.mimeType, dimensions)), this.outputPad, 0),
				);
				continue;
			}

			this.addChild(
				new Image(
					imageData,
					imageMimeType,
					{ fallbackColor: (content: string) => theme.fg("userMessageText", content) },
					{ maxWidthCells: this.imageWidthCells },
					dimensions,
				),
			);
		}
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}
}
