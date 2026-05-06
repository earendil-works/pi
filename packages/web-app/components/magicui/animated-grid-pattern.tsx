import type * as React from "react";
import { cn } from "@/lib/utils";

export function AnimatedGridPattern({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
	return (
		<div
			aria-hidden="true"
			className={cn(
				"pointer-events-none absolute inset-0 overflow-hidden opacity-70 [mask-image:radial-gradient(ellipse_at_center,black,transparent_72%)]",
				className,
			)}
			{...props}
		>
			<div className="absolute inset-[-4rem] bg-[linear-gradient(to_right,var(--grid-color)_1px,transparent_1px),linear-gradient(to_bottom,var(--grid-color)_1px,transparent_1px)] bg-[size:48px_48px] [animation:grid-drift_22s_linear_infinite]" />
			<div className="absolute left-1/4 top-24 size-48 rounded-full bg-blue-500/10 blur-3xl" />
			<div className="absolute bottom-12 right-1/4 size-64 rounded-full bg-amber-500/10 blur-3xl" />
		</div>
	);
}
