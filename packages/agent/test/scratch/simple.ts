import { homedir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai";
import { InMemorySessionStorage } from "../../src/harness/session/storage/memory.js";
import {
	AgentHarness,
	formatSkillsForSystemPrompt,
	loadSourcedPromptTemplates,
	loadSourcedSkills,
	type PromptTemplate,
	Session,
	type Skill,
} from "../../src/index.js";
import { NodeExecutionEnv } from "../../src/node.js";

type Source = { type: "project" | "user" | "path"; dir: string };
type SourcedSkill = Skill & { source: Source };
type SourcedPromptTemplate = PromptTemplate & { source: Source };

const env = new NodeExecutionEnv({ cwd: process.cwd() });
const source = (type: Source["type"], dir: string) => ({ path: dir, source: { type, dir } });
const { skills: sourcedSkills } = await loadSourcedSkills<Source, SourcedSkill>(
	env,
	[
		source("project", join(env.cwd, ".pi/skills")),
		source("user", join(homedir(), ".pi/agent/skills")),
		source("path", join(env.cwd, "../../../pi-skills")),
	],
	(skill, source) => ({ ...skill, source }),
);
const { promptTemplates: sourcedPromptTemplates } = await loadSourcedPromptTemplates<Source, SourcedPromptTemplate>(
	env,
	[source("project", join(env.cwd, ".pi/prompts")), source("user", join(homedir(), ".pi/agent/prompts"))],
	(promptTemplate, source) => ({ ...promptTemplate, source }),
);

const session = new Session(new InMemorySessionStorage());
const agent = new AgentHarness({
	env,
	session,
	model: getModel("openai", "gpt-5.5"),
	thinkingLevel: "low",
	systemPrompt: ({ env, resources }) =>
		[
			"You are a helpful assistant.",
			formatSkillsForSystemPrompt(resources.skills ?? []),
			`Current working directory: ${env.cwd}`,
		]
			.filter((part) => part.length > 0)
			.join("\n\n"),
	resources: {
		promptTemplates: sourcedPromptTemplates.map(({ promptTemplate }) => promptTemplate),
		skills: sourcedSkills.map(({ skill }) => skill),
	},
});

const response = await agent.prompt("What skills do you have? Any duplicates?");
console.log(response);
