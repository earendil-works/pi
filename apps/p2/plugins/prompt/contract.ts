// The session's prompt templates and skills for participants (p2-tui-port.md 10.8), served by the session worker.

import { arr, obj, opt, type Static, str, union } from "@earendil-works/pi-schema";
import { literal, method, param, remote, sessionHost } from "@p2/app/v1";

export const TemplateInfoSchema = obj({
	name: str(),
	description: str(),
	argumentHint: opt(str()),
	/** p2's data directory (`~/.pi/p2/prompts` on a remote environment) or the project's `.pi/prompts`. */
	source: union([literal("global"), literal("project")]),
});
export type TemplateInfo = Static<typeof TemplateInfoSchema>;
export const SkillInfoSchema = obj({ name: str(), description: str() });
export type SkillInfo = Static<typeof SkillInfoSchema>;

/**
 * Prompt templates (`/name args`) and skills (`/skill:name args`) where a session's conversation works (the session's
 * location, or a subagent's own), read-only and reloaded when their files change (like AGENTS.md); `expand` turns a
 * typed command into the text to send, on the worker, so templates and skills on a remote environment work and every
 * client expands alike. Participants only.
 */
export const PromptResources = remote("p2.prompt-resources", {
	// 2: per conversation.
	version: 2,
	params: { session: param.str(), conversation: param.int({ min: 1 }) },
	hostAddress: sessionHost,
	variants: {
		participant: {
			state: { templates: arr(TemplateInfoSchema), skills: arr(SkillInfoSchema) },
			methods: {
				/**
				 * pi's expansion: `/skill:name args` becomes the skill block plus the args, `/name args` the template with
				 * its arguments substituted. Other text, unknown names and unreadable skills come back unchanged.
				 */
				expand: method(
					obj({ text: str({ maxLength: 1_000_000 }) }),
					obj({ text: str(), skill: opt(obj({ name: str() })) }),
				),
			},
		},
	},
});
