// A launcher action's result as a status line (p2-tui-port.md 3.6b). `denied` includes the visitor declining on the
// consent screen, which needs no notice; `failed` means the launcher showed its own error text (the worker never sees
// it).
import type { TuiContext, TuiGrantResult } from "../runtime/tui-context.ts";

export function grantNotice(ctx: Pick<TuiContext, "notify">, done: string, result: TuiGrantResult): void {
	if (result.ok) ctx.notify(done);
	else if (result.error === "failed") ctx.notify("The launcher could not do that (see its message)", "warning");
	else if (result.error !== "denied") ctx.notify(`Not done (${result.error})`, "warning");
}
