import type * as React from "react";
import { cn } from "@/lib/utils";

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
	ref?: React.Ref<HTMLTextAreaElement>;
}

export function Textarea({ className, ref, ...props }: TextareaProps): React.ReactElement {
	return (
		<textarea
			ref={ref}
			className={cn(
				"flex min-h-24 w-full resize-none rounded-[1.15rem] border border-input bg-background/55 px-4 py-3 text-base leading-relaxed shadow-sm outline-none backdrop-blur-xl transition-all placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-4 focus-visible:ring-ring/15 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
				className,
			)}
			{...props}
		/>
	);
}
