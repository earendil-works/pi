import type * as React from "react";
import { cn } from "@/lib/utils";

export function Input({ className, type, ...props }: React.InputHTMLAttributes<HTMLInputElement>): React.ReactElement {
	return (
		<input
			type={type}
			className={cn(
				"flex h-10 w-full rounded-full border border-input bg-background/55 px-3 py-2 text-sm shadow-sm outline-none backdrop-blur-xl transition-all file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-4 focus-visible:ring-ring/15 disabled:cursor-not-allowed disabled:opacity-50",
				className,
			)}
			{...props}
		/>
	);
}
