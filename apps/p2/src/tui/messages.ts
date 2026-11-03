// A whole transcript as one component outside a runtime (tests, previews): the chat screen's TranscriptView with the
// built-in dark theme and the current keymap's hints. The chat surface itself keeps one TranscriptView per screen.
import { getKeybindings, type Keybinding } from "@earendil-works/pi-tui";
import type { Transcript } from "../web/transcript.ts";
import { TranscriptView } from "./components/transcript.ts";
import { formatKeyText } from "./render-context.ts";
import { ThemeRef } from "./theme/ref.ts";
import { BUILTIN_THEMES, createTheme } from "./theme/theme.ts";
import { resolveToolRenderers } from "./tools/index.ts";

export function transcriptComponent(
	transcript: Transcript,
	showThinking: boolean,
	expandedTools: boolean,
	options: { theme?: ThemeRef; cwd?: string } = {},
): TranscriptView {
	const theme = options.theme ?? new ThemeRef(createTheme(BUILTIN_THEMES.dark!, "truecolor"));
	const view = new TranscriptView(
		{
			theme,
			keyText: (id) =>
				formatKeyText(
					getKeybindings()
						.getKeys(id as Keybinding)
						.join("/"),
				),
			requestRender: () => {},
			cwd: options.cwd ?? "",
			markdownTransformers: [],
			toolRenderers: (name) => resolveToolRenderers(name, new Map(), new Map()),
			entryRenderers: new Map(),
		},
		{ expanded: expandedTools, showThinking },
	);
	view.sync(transcript);
	return view;
}
