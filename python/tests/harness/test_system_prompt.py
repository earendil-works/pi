from pi_mono.agent.harness.system_prompt import formatSkillsForSystemPrompt

visibleSkill = {
    "name": "visible",
    "description": "Use <this> & that",
    "content": "visible content",
    "filePath": "/skills/visible/SKILL.md",
}

secondSkill = {
    "name": "second",
    "description": "Second skill",
    "content": "second content",
    "filePath": "/skills/second/SKILL.md",
}

disabledSkill = {
    "name": "hidden",
    "description": "Hidden",
    "content": "hidden content",
    "filePath": "/skills/hidden/SKILL.md",
    "disableModelInvocation": True,
}


def test_formats_visible_skills_in_order_and_skips_model_disabled_skills():
    expected = (
        "The following skills provide specialized instructions for specific tasks.\n"
        "Read the full skill file when the task matches its description.\n"
        "When a skill file references a relative path, resolve it against the skill directory "
        "(parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.\n\n"
        "<available_skills>\n"
        "  <skill>\n"
        "    <name>visible</name>\n"
        "    <description>Use &lt;this&gt; &amp; that</description>\n"
        "    <location>/skills/visible/SKILL.md</location>\n"
        "  </skill>\n"
        "  <skill>\n"
        "    <name>second</name>\n"
        "    <description>Second skill</description>\n"
        "    <location>/skills/second/SKILL.md</location>\n"
        "  </skill>\n"
        "</available_skills>"
    )
    assert formatSkillsForSystemPrompt([visibleSkill, disabledSkill, secondSkill]) == expected


def test_returns_an_empty_string_when_no_skills_are_model_visible():
    assert formatSkillsForSystemPrompt([disabledSkill]) == ""


def test_escapes_xml_in_all_model_visible_skill_fields():
    result = formatSkillsForSystemPrompt(
        [
            {
                "name": "a&b",
                "description": "Quote \"double\" and 'single'",
                "content": "content",
                "filePath": '/skills/<bad>&"quote"/SKILL.md',
            }
        ]
    )
    expected = (
        "    <name>a&amp;b</name>\n"
        "    <description>Quote &quot;double&quot; and &apos;single&apos;</description>\n"
        "    <location>/skills/&lt;bad&gt;&amp;&quot;quote&quot;/SKILL.md</location>"
    )
    assert expected in result
