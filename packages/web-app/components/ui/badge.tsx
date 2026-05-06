import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
	"inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors",
	{
		variants: {
			variant: {
				default: "border-transparent bg-primary text-primary-foreground",
				secondary: "border-transparent bg-secondary text-secondary-foreground",
				outline: "border-border text-foreground",
				success: "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
				warning: "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300",
				error: "border-red-500/20 bg-red-500/10 text-red-700 dark:text-red-300",
				blue: "border-blue-500/20 bg-blue-500/10 text-blue-700 dark:text-blue-300",
			},
		},
		defaultVariants: {
			variant: "default",
		},
	},
);

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps): React.ReactElement {
	return <div className={cn(badgeVariants({ variant, className }))} {...props} />;
}
