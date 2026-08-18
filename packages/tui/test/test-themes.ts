/**
 * Default themes for TUI tests using chalk
 */

import { Chalk } from "chalk";
import type { EditorTheme, MarkdownTheme, SelectListTheme } from "../src/index.ts";

const chalk = new Chalk({ level: 3 });

export const defaultSelectListTheme: SelectListTheme = {
	selectedPrefix: (text: string) => chalk.blue(text),
	selectedText: (text: string) => chalk.bold(text),
	description: (text: string) => chalk.dim(text),
	scrollInfo: (text: string) => chalk.dim(text),
	noMatch: (text: string) => chalk.dim(text),
};

export const defaultMarkdownTheme: MarkdownTheme = {
	heading: (text: string) => chalk.bold.cyan(text),
	link: (text: string) => chalk.blue(text),
	linkUrl: (text: string) => chalk.dim(text),
	code: (text: string) => chalk.yellow(text),
	codeBlock: (text: string) => chalk.green(text),
	codeBlockBorder: (text: string) => chalk.dim(text),
	quote: (text: string) => chalk.italic(text),
	quoteBorder: (text: string) => chalk.dim(text),
	hr: (text: string) => chalk.dim(text),
	listBullet: (text: string) => chalk.cyan(text),
	bold: (text: string) => chalk.bold(text),
	italic: (text: string) => chalk.italic(text),
	strikethrough: (text: string) => chalk.strikethrough(text),
	underline: (text: string) => chalk.underline(text),
};

export const defaultEditorTheme: EditorTheme = {
	borderColor: (text: string) => chalk.dim(text),
	selectList: defaultSelectListTheme,
};
