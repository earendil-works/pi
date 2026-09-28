/**
 * Wrapper for packages/coding-agent/src/modes/interactive/components/settings-selector.ts.
 *
 * Adds one row to the /settings list: "Auto-compact threshold" (percent of the
 * effective context window at which auto-compaction triggers, persisted via
 * plus/src/context/threshold-setting.ts). Upstream's selector builds its item
 * list and dispatch closure privately inside the constructor, so instead of
 * forking that logic the subclass reaches into the constructed SettingsList at
 * runtime — its fields are TS-private (not ECMAScript #private) and
 * `filteredItems` aliases the same array until a search filter runs, so an
 * in-place splice after super() shows up everywhere. If upstream ever renames
 * those fields, the threshold row silently stops appearing; /settings still
 * works unchanged.
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
	getAutoCompactThresholdPercent,
	parseAutoCompactThresholdChoice,
	setAutoCompactThresholdPercent,
} from "../../context/threshold-setting.ts";

const THRESHOLD_ITEM_ID = "autocompact-threshold";
const THRESHOLD_VALUES = ["70%", "80%", "85%", "90%", "95%"];

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
	}
}
