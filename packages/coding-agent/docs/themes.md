# Customize Pi with themes

Themes control the colors Pi uses in interactive mode and HTML exports. Pi includes `dark` and `light` themes. You can select one theme, follow your terminal's light or dark appearance, or create your own palette.

<a id="selecting-a-theme"></a>

## Choose a theme

Open `/settings` and select **Theme**. You can use one theme for every terminal appearance or choose separate themes for light and dark terminals.

The selection is saved as the `theme` [setting](settings.md#terminal-and-display):

```json
{
  "theme": "dark"
}
```

Automatic mode stores the light theme first and the dark theme second:

```json
{
  "theme": "light/dark"
}
```

When automatic mode is active, Pi changes themes when the terminal reports an appearance change. Theme names cannot contain `/` because Pi reserves it for this setting format.

Use `--use-theme` to choose the initial theme for one invocation without changing the saved setting:

```bash
pi --use-theme light
pi --use-theme light/dark
```

See [CLI resources](cli.md#resources) for the command-line option.

## Create a custom theme

Copy one of the [built-in themes](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/src/modes/interactive/theme) or create a new JSON file conforming to the [schema](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/modes/interactive/theme/theme-schema.json).

1. Save the file as `<agent-dir>/themes/my-theme.json`. The agent directory defaults to `~/.pi/agent`.
2. Set its `name` to `my-theme`.
3. Change values in `vars` and `colors`.
4. Select `my-theme` through `/settings`.

Use the theme name as the filename. Pi hot-reloads the active user theme only from `<agent-dir>/themes/<name>.json`. Run `/reload` after adding or changing a theme from any other source.

## Understand the theme file

| Property | Required | Responsibility |
|---|---|---|
| `$schema` | No | Enables editor validation and completion against Pi's published schema. |
| `name` | Yes | Identifies the theme in selectors and settings. It must be unique and cannot contain `/`. |
| `appearance` | No | `"dark"` or `"light"`: the background the theme is designed for. Pi detects it from the theme colors when omitted. |
| `vars` | No | Defines reusable color values. Variables can reference other variables. |
| `colors` | Yes | Assigns colors to terminal UI roles. The schema identifies required and optional roles. |
| `export` | No | Overrides page and panel backgrounds in HTML exports. |

A color can be written in five forms:

| Form | Example | Meaning |
|---|---|---|
| RGB hexadecimal | `"#0af"` or `"#00aaff"` | A three- or six-digit sRGB color. |
| OKLCH | `"oklch(62% 0.1 200)"` | Perceptual lightness, chroma, and hue. |
| 256-color index | `39` | An ANSI palette index from `0` through `255`. |
| Variable reference | `"primary"` | The value of an entry in `vars`. |
| Terminal default | `""` | The terminal's default foreground or background color. |

Terminal default colors render as the terminal's own colors. Where Pi needs a concrete value, such as HTML export or extension color math, it uses the default colors the terminal reports, or a black or white guess based on the theme's appearance.

Pi resolves chained variable references. A missing variable or circular reference makes the theme invalid. Pi uses truecolor when available, gamut-maps OKLCH to sRGB, and approximates colors for 256-color terminals. If colors differ from their source values, check your terminal's truecolor detection and contrast settings. See [Configure Your Terminal](terminal-setup.md#override-detected-capabilities).

Use the [theme JSON schema](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/modes/interactive/theme/theme-schema.json) for the exact properties, required colors, and accepted value types.

Pi reports invalid theme files during startup and `/reload`.

## Find the color to change

Theme colors describe interface roles rather than individual components. Use these groups to find the relevant part of the schema:

| Area | Color names |
|---|---|
| General interface | `accent`, `border*`, `text`, `muted`, `dim`, `success`, `error`, `warning` |
| Selection and fullscreen | `selectedBg`, `searchMatch*`, `scrollbar*` |
| Messages | `userMessage*`, `customMessage*`, `thinkingText` |
| Tool execution | `toolPendingBg`, `toolSuccessBg`, `toolErrorBg`, `toolTitle`, `toolOutput` |
| Markdown | `md*` |
| Tool diffs | `toolDiff*` |
| Syntax highlighting | `syntax*` |
| Editor modes | `thinking*`, `bashMode` |
| HTML export | `export.pageBg`, `export.cardBg`, `export.infoBg` |

The schema is the format reference. The built-in themes provide complete values that you can copy and adjust.

Five colors are optional and inherit another color when omitted:

| Optional color | Fallback |
|---|---|
| `scrollbarTrack` | `muted` |
| `scrollbarThumb` | `text` |
| `searchMatchBg` | `selectedBg` |
| `searchMatchText` | `text` |
| `thinkingMax` | `thinkingXhigh` |

If `export` colors are omitted, Pi derives HTML page and panel backgrounds from `userMessageBg`.

## Load a theme from a project or package

Place a project theme in `.pi/themes/`. Project themes load only after [project trust](security.md#understand-project-trust) is granted.

You can also load theme files and directories through the `themes` setting or distribute them in a Pi package. See [Configuration](configuration.md), [Settings](settings.md#resources), and [Pi Packages](packages.md).

Each loaded theme must have a unique name. Pi reports duplicate names as resource collisions.
