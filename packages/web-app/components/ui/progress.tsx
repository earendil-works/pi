import type * as React from "react";
import { cn } from "@/lib/utils";

export function Progress({
	value,
	className,
	...props
}: React.HTMLAttributes<HTMLDivElement> & { value?: number | null }): React.ReactElement {
	const clamped = Math.max(0, Math.min(100, value ?? 0));
	return (
		<div className={cn("relative h-2 w-full overflow-hidden rounded-full bg-secondary", className)} {...props}>
			<div
				className="h-full rounded-full bg-primary transition-all duration-500 ease-out"
				style={{ width: `${clamped}%` }}
			/>
		</div>
	);
}
