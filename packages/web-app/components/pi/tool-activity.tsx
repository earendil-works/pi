import { CheckCircle2, CircleDashed, Terminal, XCircle } from "lucide-react";
import type * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { compactText } from "@/lib/utils";

export interface ToolActivityItem {
	id: string;
	name: string;
	status: "running" | "done" | "error";
	args?: Record<string, unknown>;
	output?: string;
}

export function ToolActivity({ items }: { items: ToolActivityItem[] }): React.ReactElement {
	const visible = items.slice(-7).reverse();
	return (
		<Card className="glass p-4">
			<div className="mb-3 flex items-center justify-between">
				<div>
					<h3 className="text-sm font-semibold">Tool activity</h3>
					<p className="text-xs text-muted-foreground">Live execution stream from the harness</p>
				</div>
				<Badge variant={items.some((item) => item.status === "running") ? "warning" : "outline"}>
					{items.some((item) => item.status === "running") ? "running" : "idle"}
				</Badge>
			</div>
			<div className="space-y-2">
				{visible.length === 0 ? (
					<div className="rounded-2xl border border-dashed p-4 text-xs text-muted-foreground">
						No tools yet. Ask pi to inspect or change the project.
					</div>
				) : (
					visible.map((item) => {
						const Icon =
							item.status === "running" ? CircleDashed : item.status === "error" ? XCircle : CheckCircle2;
						return (
							<div key={item.id} className="rounded-2xl border bg-background/35 p-3 text-xs">
								<div className="flex items-center justify-between gap-2">
									<div className="flex min-w-0 items-center gap-2 font-medium">
										<Icon className={item.status === "running" ? "size-3.5 animate-spin" : "size-3.5"} />
										<span className="truncate">{item.name}</span>
									</div>
									<Badge
										variant={
											item.status === "error" ? "error" : item.status === "running" ? "warning" : "success"
										}
									>
										{item.status}
									</Badge>
								</div>
								{item.args ? (
									<div className="mt-2 flex items-start gap-2 text-muted-foreground">
										<Terminal className="mt-0.5 size-3 shrink-0" />
										<span className="break-words">{compactText(JSON.stringify(item.args), 150)}</span>
									</div>
								) : null}
								{item.output ? (
									<p className="mt-2 text-muted-foreground">{compactText(item.output, 180)}</p>
								) : null}
							</div>
						);
					})
				)}
			</div>
		</Card>
	);
}
