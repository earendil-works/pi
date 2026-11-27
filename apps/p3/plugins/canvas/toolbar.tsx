// A drawer's toolbar above the board: the tool (pen, box, text), the colour, undoing their own last shape, clearing
// the board (only while Moderate gives `clear`), and the text the text tool places. It holds no state of its own: the
// board view owns what is picked.

import { Button, Input, SegmentedControl } from "@earendil-works/elanor-react";
import { useMessages } from "@earendil-works/p3/v1/web";
import styles from "./board-view.module.css";
import type { Tool } from "./drawing.ts";
import { messages } from "./messages.ts";

/**
 * The colours a drawer picks from, by the key of their name. A shape's colour is data (stored as picked, drawn on
 * white paper in every theme), so these are fixed values, not the app's variables.
 */
export const COLORS = [
	{ name: "ink", value: "#1f2328" },
	{ name: "red", value: "#cf222e" },
	{ name: "blue", value: "#0969da" },
	{ name: "green", value: "#1a7f37" },
	{ name: "orange", value: "#bc4c00" },
] as const;

/** What the toolbar shows and what it changes. */
export type ToolbarProps = {
	readonly tool: Tool;
	readonly onTool: (tool: Tool) => void;
	readonly color: string;
	readonly onColor: (color: string) => void;
	readonly text: string;
	readonly onText: (text: string) => void;
	/** Undoes the drawer's own last shape; none while there is none. */
	readonly onUndo: (() => void) | undefined;
	/** Clears the board; none without Moderate. */
	readonly onClear: (() => void) | undefined;
	/** Whether the board has shapes to clear. */
	readonly empty: boolean;
};

/** The drawer's toolbar. */
export function Toolbar(props: ToolbarProps) {
	const { t } = useMessages(messages);
	return (
		<div className={styles.toolbar} data-canvas-tools="">
			<SegmentedControl.Root
				aria-label={t("tool")}
				density="compact"
				onValueChange={(value) => value[0] !== undefined && props.onTool(value[0])}
				value={[props.tool]}
			>
				<SegmentedControl.Item data-tool="pen" value="pen">
					{t("pen")}
				</SegmentedControl.Item>
				<SegmentedControl.Item data-tool="rect" value="rect">
					{t("box")}
				</SegmentedControl.Item>
				<SegmentedControl.Item data-tool="text" value="text">
					{t("text")}
				</SegmentedControl.Item>
			</SegmentedControl.Root>
			<fieldset aria-label={t("colour")} className={styles.colors}>
				{COLORS.map((choice) => (
					<button
						aria-pressed={props.color === choice.value}
						aria-label={t(choice.name)}
						className={styles.color}
						data-color={choice.value}
						key={choice.value}
						onClick={() => props.onColor(choice.value)}
						style={{ background: choice.value }}
						type="button"
					/>
				))}
			</fieldset>
			<div className={styles.actions}>
				<Button
					data-canvas-undo=""
					density="compact"
					disabled={props.onUndo === undefined}
					hierarchy="tertiary"
					onClick={props.onUndo}
				>
					{t("undo")}
				</Button>
				{props.onClear === undefined ? null : (
					<Button
						data-canvas-clear=""
						density="compact"
						disabled={props.empty}
						hierarchy="tertiary"
						onClick={props.onClear}
						semantic="negative"
					>
						{t("clear")}
					</Button>
				)}
			</div>
			{props.tool === "text" ? (
				<Input
					aria-label={t("textToPlace")}
					className={styles.text}
					data-canvas-text=""
					onValueChange={props.onText}
					placeholder={t("textHint")}
					value={props.text}
				/>
			) : null}
		</div>
	);
}
