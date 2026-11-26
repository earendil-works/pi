// A labelled pick of one of a few values (an environment, a kind of thing, a person, an access): Elanor's dropdown
// with its items, for the views' forms.

import { Dropdown } from "@earendil-works/elanor-react";

/** One value to pick, with what the dropdown shows for it. */
export type ChoiceItem = { readonly value: string; readonly label: string };

/** A dropdown labelled `label` over `items`, showing `value` (none: `null`); `onChange` gets the picked value. */
export function Choice(props: {
	readonly label: string;
	readonly items: readonly ChoiceItem[];
	readonly value: string | null;
	readonly onChange: (value: string) => void;
	readonly name: string;
}) {
	return (
		<Dropdown.Root
			items={props.items}
			onValueChange={(value: string | null) => {
				if (value !== null) props.onChange(value);
			}}
			value={props.value}
		>
			<Dropdown.Label>{props.label}</Dropdown.Label>
			<Dropdown.Trigger data-field={props.name}>
				<Dropdown.Value />
				<Dropdown.Icon />
			</Dropdown.Trigger>
			<Dropdown.Portal>
				<Dropdown.Positioner>
					<Dropdown.Popup>
						<Dropdown.List>
							{props.items.map((item) => (
								<Dropdown.Item data-choice={item.value} key={item.value} value={item.value}>
									<Dropdown.ItemText>{item.label}</Dropdown.ItemText>
									<Dropdown.ItemIndicator />
								</Dropdown.Item>
							))}
						</Dropdown.List>
					</Dropdown.Popup>
				</Dropdown.Positioner>
			</Dropdown.Portal>
		</Dropdown.Root>
	);
}
