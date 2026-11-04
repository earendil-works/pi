// Prompt templates and skills in the TUI (p2-tui-port.md 10.8): slash completion for `/name` and `/skill:name` from
// the viewed conversation's `PromptResources`, and their expansion on the session worker when the editor submits.

import type { Held } from "@p2/app/v1";
import { BACKGROUND_CONTEXT, contribute, defineFacet, statusOf } from "@p2/app/v1";
import type { TuiContext } from "@p2/app/v1/tui";
import {
	lineText,
	type TuiRuntime,
	TuiScope,
	type TuiSlashEntry,
	type TuiSlashSource,
	TuiSlashSources,
	TuiSlots,
	type TuiSurface,
} from "@p2/app/v1/tui";
import { PromptResources, type SkillInfo, type TemplateInfo } from "./contract.ts";

/** Holds the viewed conversation's `PromptResources` while this visitor may send there (no surface of its own). */
export class PromptSurface implements TuiSurface {
	readonly runtime: TuiRuntime;
	private scope: TuiScope | undefined;
	private viewed: string | undefined;
	private ref: (() => Held<typeof PromptResources>) | undefined;
	templates: readonly TemplateInfo[] = [];
	skills: readonly SkillInfo[] = [];
	private stop: () => void;
	constructor(runtime: TuiRuntime) {
		this.runtime = runtime;
		const changed = (): void => {
			// Viewers cannot send, so they never hold it (the worker would refuse them).
			const participant = runtime.role === "owner" || runtime.guestMode() === "full";
			const session = participant ? runtime.session : undefined;
			const conversation = runtime.conversation;
			const viewed = session === undefined ? undefined : `${session}#${conversation}`;
			if (viewed === this.viewed) return;
			this.scope?.dispose();
			this.scope = undefined;
			this.ref = undefined;
			this.templates = [];
			this.skills = [];
			this.viewed = viewed;
			if (!session) return;
			this.scope = new TuiScope(runtime);
			this.ref = this.scope.watch(PromptResources, { session, conversation }, (ref, follow) => {
				follow(ref.templates, (templates) => {
					this.templates = templates ?? [];
				});
				follow(ref.skills, (skills) => {
					this.skills = skills ?? [];
				});
			});
		};
		runtime.listeners.add(changed);
		this.stop = () => runtime.listeners.delete(changed);
		changed();
	}
	entries(): TuiSlashEntry[] {
		return [
			...this.templates.map((template) => ({
				name: template.name,
				description: lineText(template.description),
				...(template.argumentHint ? { argumentHint: lineText(template.argumentHint) } : {}),
			})),
			...this.skills.map((skill) => ({ name: `skill:${skill.name}`, description: lineText(skill.description) })),
		];
	}
	async expand(text: string): Promise<string | undefined> {
		const ref = this.ref?.();
		if (ref === undefined || statusOf(ref) !== "live" || ref.variant !== "participant") return undefined;
		return (await ref.expand({ text }, BACKGROUND_CONTEXT)).text;
	}
	render(): string[] {
		return [];
	}
	invalidate(): void {}
	dispose(): void {
		this.stop();
		this.scope?.dispose();
	}
}

const SLOT = "widget-above:prompt";
const surface = (ctx: TuiContext): PromptSurface | undefined => {
	const value = ctx.surface(SLOT);
	return value instanceof PromptSurface ? value : undefined;
};
const source: TuiSlashSource = {
	entries: (ctx) => surface(ctx)?.entries() ?? [],
	expand: async (ctx, text) => surface(ctx)?.expand(text),
};

export default defineFacet((host) =>
	contribute(host, "p2.tui-prompt", (self) => {
		self.contribute(TuiSlots, { [SLOT]: (runtime: TuiRuntime) => new PromptSurface(runtime) });
		self.contribute(TuiSlashSources, { prompt: source });
	}),
);
