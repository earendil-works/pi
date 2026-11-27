// The toolbar above the board: for a drawer (Draw) the tool (pen, box, text), the colour, the text the text tool places
// and undoing their own last shape; clearing the board while Moderate gives `clear`, with or without Draw (a moderator
// who may not draw sees Clear alone). It holds no state of its own: the board view owns what is picked.

import { Button, Input, SegmentedControl } from "@earendil-works/elanor-react";
import { useMessages } from "@earendil-works/p3/v1/web";
import styles from "./board-view.module.css";
import type { Picked } from "./drawing.tsx";
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

/** What a drawer picks with the toolbar, and their undo (none while they have no shape on the board). */
type Picking = {
	readonly picked: Picked;
	readonly onPick: (picked: Picked) => void;
	readonly onUndo: (() => void) | undefined;
};

/** The toolbar: a drawer's `picking` (none without Draw), and Clear (`onClear`: none without Moderate). */
export function Toolbar(props: {
	readonly picking: Picking | undefined;
	readonly onClear: (() => void) | undefined;
	/** Whether the board has no shapes to clear. */
	readonly empty: boolean;
}) {
	const { t } = useMessages(messages);
	const { picking, onClear } = props;
	return (
		<div className={styles.toolbar} data-canvas-tools="">
			{picking === undefined ? null : <Picker {...picking} />}
			<div className={styles.actions}>
				{picking === undefined ? null : (
					<Button
						data-canvas-undo=""
						density="compact"
						disabled={picking.onUndo === undefined}
						hierarchy="tertiary"
						onClick={picking.onUndo}
					>
						{t("undo")}
					</Button>
				)}
				{onClear === undefined ? null : (
					<Button
						data-canvas-clear=""
						density="compact"
						disabled={props.empty}
						hierarchy="tertiary"
						onClick={onClear}
						semantic="negative"
					>
						{t("clear")}
					</Button>
				)}
			</div>
			{picking?.picked.tool === "text" ? (
				<Input
					aria-label={t("textToPlace")}
					className={styles.text}
					data-canvas-text=""
					onValueChange={(text) => picking.onPick({ ...picking.picked, text })}
					placeholder={t("textHint")}
					value={picking.picked.text}
				/>
			) : null}
		</div>
	);
}

/** The drawer's tool and colour. */
function Picker({ picked, onPick }: Picking) {
	const { t } = useMessages(messages);
	return (
		<>
			<SegmentedControl.Root
				aria-label={t("tool")}
				density="compact"
				onValueChange={(value) => value[0] !== undefined && onPick({ ...picked, tool: value[0] })}
				value={[picked.tool]}
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
						aria-pressed={picked.color === choice.value}
						aria-label={t(choice.name)}
						className={styles.color}
						data-color={choice.value}
						key={choice.value}
						onClick={() => onPick({ ...picked, color: choice.value })}
						style={{ background: choice.value }}
						type="button"
					/>
				))}
			</fieldset>
		</>
	);
}
