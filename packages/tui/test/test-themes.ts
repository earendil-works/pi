/**
 * Default themes for TUI tests using chalk
 */

import { styleText } from "node:util";
import type { EditorTheme, MarkdownTheme, SelectListTheme } from "../src/index.ts";

export const defaultSelectListTheme: SelectListTheme = {
	selectedPrefix: (text: string) => styleText("blue", text),
	selectedText: (text: string) => styleText("bold", text),
	description: (text: string) => styleText("dim", text),
	scrollInfo: (text: string) => styleText("dim", text),
	noMatch: (text: string) => styleText("dim", text),
};

export const defaultMarkdownTheme: MarkdownTheme = {
	heading: (text: string) => styleText(["bold", "cyan"], text),
	link: (text: string) => styleText("blue", text),
	linkUrl: (text: string) => styleText("dim", text),
	code: (text: string) => styleText("yellow", text),
	codeBlock: (text: string) => styleText("green", text),
	codeBlockBorder: (text: string) => styleText("dim", text),
	quote: (text: string) => styleText("italic", text),
	quoteBorder: (text: string) => styleText("dim", text),
	hr: (text: string) => styleText("dim", text),
	listBullet: (text: string) => styleText("cyan", text),
	bold: (text: string) => styleText("bold", text),
	italic: (text: string) => styleText("italic", text),
	strikethrough: (text: string) => styleText("strikethrough", text),
	underline: (text: string) => styleText("underline", text),
};

export const defaultEditorTheme: EditorTheme = {
	borderColor: (text: string) => styleText("dim", text),
	selectList: defaultSelectListTheme,
};
