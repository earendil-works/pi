import type * as React from "react";
import { cn } from "@/lib/utils";

export function ShineBorder({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
	return (
		<div
			aria-hidden="true"
			className={cn("pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit] opacity-70", className)}
			{...props}
		>
			<div className="absolute inset-y-0 -left-1/2 w-1/3 rotate-12 bg-gradient-to-r from-transparent via-white/45 to-transparent blur-xl [animation:shimmer_6s_ease-in-out_infinite] dark:via-white/12" />
		</div>
	);
}
