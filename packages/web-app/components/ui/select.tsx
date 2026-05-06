import type * as React from "react";
import { cn } from "@/lib/utils";

export interface SelectOption {
	value: string;
	label: string;
	disabled?: boolean;
}

export interface SelectProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "children"> {
	options: SelectOption[];
	placeholder?: string;
}

export function Select({ className, options, placeholder, ...props }: SelectProps): React.ReactElement {
	return (
		<select
			className={cn(
				"h-10 rounded-full border border-input bg-background/65 px-3 py-2 text-sm outline-none backdrop-blur-xl transition-all focus-visible:border-ring focus-visible:ring-4 focus-visible:ring-ring/15 disabled:cursor-not-allowed disabled:opacity-50",
				className,
			)}
			{...props}
		>
			{placeholder ? <option value="">{placeholder}</option> : null}
			{options.map((option) => (
				<option key={option.value} value={option.value} disabled={option.disabled}>
					{option.label}
				</option>
			))}
		</select>
	);
}
