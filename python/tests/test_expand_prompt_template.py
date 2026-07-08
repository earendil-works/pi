from pi_mono.agent.harness.prompt_templates import expand_prompt_template
from pi_mono.agent.harness.types import PromptTemplate


def test_expand_prompt_template_replaces_invocation():
    templates = [PromptTemplate(name="review", content="Review $1", description="")]
    assert expand_prompt_template("/review auth.py", templates) == "Review auth.py"


def test_expand_prompt_template_passthrough_for_unknown():
    assert expand_prompt_template("hello", []) == "hello"
    assert expand_prompt_template("/unknown arg", []) == "/unknown arg"
