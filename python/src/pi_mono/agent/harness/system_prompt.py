from pi_mono.agent.harness.types import Skill


def format_skills_for_system_prompt(skills: list[Skill]) -> str:
    visible_skills = []
    for s in skills:
        disable = False
        if isinstance(s, dict):
            disable = s.get("disableModelInvocation", s.get("disable_model_invocation", False))
        else:
            disable = getattr(s, "disable_model_invocation", False)
        if not disable:
            visible_skills.append(s)

    if not visible_skills:
        return ""

    lines = [
        "The following skills provide specialized instructions for specific tasks.",
        "Read the full skill file when the task matches its description.",
        "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
        "",
        "<available_skills>",
    ]

    for s in visible_skills:
        if isinstance(s, dict):
            name = s.get("name", "")
            desc = s.get("description", "")
            loc = s.get("filePath", s.get("file_path", ""))
        else:
            name = getattr(s, "name", "")
            desc = getattr(s, "description", "")
            loc = getattr(s, "file_path", "")

        lines.append("  <skill>")
        lines.append(f"    <name>{escapeXml(name)}</name>")
        lines.append(f"    <description>{escapeXml(desc)}</description>")
        lines.append(f"    <location>{escapeXml(loc)}</location>")
        lines.append("  </skill>")

    lines.append("</available_skills>")
    return "\n".join(lines)


def escapeXml(value: str) -> str:
    return (
        value.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&apos;")
    )


formatSkillsForSystemPrompt = format_skills_for_system_prompt
escape_xml = escapeXml
