import type * as React from "react";
import { cn } from "@/lib/utils";

export function Separator({
	className,
	orientation = "horizontal",
	...props
}: React.HTMLAttributes<HTMLDivElement> & { orientation?: "horizontal" | "vertical" }): React.ReactElement {
	return (
		<div
			className={cn("shrink-0 bg-border", orientation === "horizontal" ? "h-px w-full" : "h-full w-px", className)}
			{...props}
		/>
	);
}
