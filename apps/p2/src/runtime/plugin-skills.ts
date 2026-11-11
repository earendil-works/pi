// Plugins' skills (worker): a plugin contributes its skills directory (`pluginFile("skills")`), keyed by plugin. The
// prompt plugin lists them in `<available_skills>` after the environment's and the project's skills, only for
// conversations working on the server's own machine: the listing points straight at the plugin's files, which are never
// copied to other environments (docs/agent-plugins.md).
import { keyedRegistry } from "./chord.ts";

/** A plugin's skills: `dir`, a directory of skills in pi's layout (`<name>/SKILL.md`, or `.md` files). */
export type PluginSkillsEntry = { readonly dir: string };

/** The plugins' skills directories, by plugin name. */
export const PluginSkills = keyedRegistry<PluginSkillsEntry>("p2.plugin-skills");
