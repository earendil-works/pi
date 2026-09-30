/**
 * Wrapper for packages/coding-agent/src/modes/interactive/components/settings-selector.ts.
 *
 * Adds three rows to the /settings list: "Auto-compact threshold" (percent of
 * the effective context window at which auto-compaction triggers), "Context
 * floor" (minimum tokens of usable context the effective window is floored at),
 * and "Context window cap" (maximum window used for auto-compact math and the
 * footer meter; "No cap" uses the model's advertised window) — all persisted
 * via plus/src/context/threshold-setting.ts. Upstream's selector
 * builds its item list and dispatch closure privately inside the constructor,
 * so instead of forking that logic the subclass reaches into the constructed
 * SettingsList at runtime — its fields are TS-private (not ECMAScript #private)
 * and `filteredItems` aliases the same array until a search filter runs, so
 * in-place splices after super() show up everywhere. If upstream ever renames
 * those fields, the plus rows silently stop appearing; /settings still works
 * unchanged.
 */

export * from "../../../../coding-agent/src/modes/interactive/components/settings-selector.ts";

import type { SettingItem, SettingsList } from "@earendil-works/pi-tui";
import {
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent as UpstreamSettingsSelectorComponent,
} from "../../../../coding-agent/src/modes/interactive/components/settings-selector.ts";
import {
	formatAutoCompactThresholdPercent,
	formatContextFloorTokens,
	formatContextWindowCapTokens,
	getAutoCompactThresholdPercent,
	getContextFloorTokens,
	getContextWindowCapTokens,
	parseAutoCompactThresholdChoice,
	parseContextFloorChoice,
	parseContextWindowCapChoice,
	setAutoCompactThresholdPercent,
	setContextFloorTokens,
	setContextWindowCapTokens,
} from "../../context/threshold-setting.ts";

const THRESHOLD_ITEM_ID = "autocompact-threshold";
const THRESHOLD_VALUES = ["70%", "80%", "85%", "90%", "95%"];

const CONTEXT_FLOOR_ITEM_ID = "context-floor";
const CONTEXT_FLOOR_VALUES = ["13000", "16384", "24576", "32768", "65536"];

const CONTEXT_WINDOW_CAP_ITEM_ID = "context-window-cap";
const CONTEXT_WINDOW_CAP_VALUES = ["No cap", "131072", "262144", "524288", "1048576"];

/** Runtime shape of SettingsList's TS-private fields the injection relies on. */
interface SettingsListInternals {
	items: SettingItem[];
	onChange: (id: string, newValue: string) => void;
}

export class SettingsSelectorComponent extends UpstreamSettingsSelectorComponent {
	constructor(config: SettingsConfig, callbacks: SettingsCallbacks) {
		super(config, callbacks);

		const internals = (this as unknown as { settingsList: SettingsList })
			.settingsList as unknown as SettingsListInternals;
		const upstreamOnChange = internals.onChange;
		internals.onChange = (id, newValue) => {
			if (id === THRESHOLD_ITEM_ID) {
				setAutoCompactThresholdPercent(parseAutoCompactThresholdChoice(newValue));
				return;
			}
			if (id === CONTEXT_FLOOR_ITEM_ID) {
				setContextFloorTokens(parseContextFloorChoice(newValue));
				return;
			}
			if (id === CONTEXT_WINDOW_CAP_ITEM_ID) {
				setContextWindowCapTokens(parseContextWindowCapChoice(newValue));
				return;
			}
			upstreamOnChange(id, newValue);
		};
		internals.items.splice(1, 0, {
			id: THRESHOLD_ITEM_ID,
			label: "Auto-compact threshold",
			description:
				"Context fullness at which auto-compaction triggers, as a percent of the model's effective context window (default 80%).",
			currentValue: formatAutoCompactThresholdPercent(getAutoCompactThresholdPercent()),
			values: THRESHOLD_VALUES,
		});
		internals.items.splice(2, 0, {
			id: CONTEXT_FLOOR_ITEM_ID,
			label: "Context floor",
			description:
				"Minimum usable context for auto-compact math: the effective context window never drops below the output reserve plus this many tokens, even for small-context models (default 13000; only raises the built-in floor).",
			currentValue: formatContextFloorTokens(getContextFloorTokens()),
			values: CONTEXT_FLOOR_VALUES,
		});
		internals.items.splice(3, 0, {
			id: CONTEXT_WINDOW_CAP_ITEM_ID,
			label: "Context window cap",
			description:
				"Cap on the context window used for auto-compact math and the footer fullness meter: the window is the smaller of this and the model's advertised size. \"No cap\" (default) uses the model's full advertised context window.",
			currentValue: formatContextWindowCapTokens(getContextWindowCapTokens()),
			values: CONTEXT_WINDOW_CAP_VALUES,
		});
	}
}
