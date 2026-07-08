from pi_mono.agent.harness.skills import formatSkillInvocation
from pi_mono.agent.harness.prompt_templates import formatPromptTemplateInvocation
from pi_mono.agent.harness.types import Skill, PromptTemplate


def test_formats_skill_invocations_with_additional_instructions():
    skill = Skill(
        name="inspect",
        description="Inspect things",
        content="Use inspection tools.",
        file_path="/project/.pi/skills/inspect/SKILL.md",
    )

    assert formatSkillInvocation(skill, "Check errors.") == (
        '<skill name="inspect" location="/project/.pi/skills/inspect/SKILL.md">\n'
        "References are relative to /project/.pi/skills/inspect.\n\n"
        "Use inspection tools.\n</skill>\n\n"
        "Check errors."
    )


def test_formats_prompt_template_invocations_with_positional_arguments():
    template = PromptTemplate(name="review", content="Review $1 with $ARGUMENTS")
    assert (
        formatPromptTemplateInvocation(template, ["a.ts", "care"]) == "Review a.ts with a.ts care"
    )
