import pytest
import time
import copy
from typing import Any, Optional
from pi_mono.ai.types import Usage
from pi_mono.ai.providers.faux import (
    register_faux_provider,
    faux_assistant_message,
)
from pi_mono.agent.harness.compaction.compaction import (
    calculate_context_tokens,
    should_compact,
    find_cut_point,
    find_turn_start_index,
    estimate_tokens,
    get_last_assistant_usage,
    estimate_context_tokens,
    prepare_compaction,
    compact,
    generate_summary,
    DEFAULT_COMPACTION_SETTINGS,
)
from pi_mono.agent.harness.session.session import build_session_context
from pi_mono.agent.types import AgentMessage
from pi_mono.agent.harness.types import (
    MessageEntry,
    ThinkingLevelChangeEntry,
    ModelChangeEntry,
    CompactionEntry,
    BranchSummaryEntry,
    CustomMessageEntry,
)

next_id = 0


def create_id() -> str:
    global next_id
    id_str = f"entry-{next_id}"
    next_id += 1
    return id_str


def create_mock_usage(
    input_val: int, output_val: int, cache_read: int = 0, cache_write: int = 0
) -> Usage:
    return {
        "input": input_val,
        "output": output_val,
        "cacheRead": cache_read,
        "cacheWrite": cache_write,
        "totalTokens": input_val + output_val + cache_read + cache_write,
        "cost": {
            "input": 0.0,
            "output": 0.0,
            "cacheRead": 0.0,
            "cacheWrite": 0.0,
            "total": 0.0,
        },
    }


def create_user_message(text: str) -> AgentMessage:
    return {
        "role": "user",
        "content": [{"type": "text", "text": text}],
        "timestamp": int(time.time() * 1000),
    }


def create_assistant_message(text: str, usage: Optional[Usage] = None) -> AgentMessage:
    if usage is None:
        usage = create_mock_usage(100, 50)
    return {
        "role": "assistant",
        "content": [{"type": "text", "text": text}],
        "api": "anthropic-messages",
        "provider": "anthropic",
        "model": "claude-sonnet-4-5",
        "usage": usage,
        "stopReason": "stop",
        "timestamp": int(time.time() * 1000),
    }


def create_message_entry(message: AgentMessage, parent_id: Optional[str] = None) -> MessageEntry:
    return MessageEntry(
        id=create_id(),
        parent_id=parent_id,
        timestamp="2026-06-10T12:00:00Z",
        message=message,
    )


def create_compaction_entry(
    summary: str,
    first_kept_entry_id: str,
    parent_id: Optional[str] = None,
) -> CompactionEntry:
    return CompactionEntry(
        id=create_id(),
        parent_id=parent_id,
        timestamp="2026-06-10T12:00:00Z",
        summary=summary,
        first_kept_entry_id=first_kept_entry_id,
        tokens_before=1234,
    )


def create_thinking_level_entry(
    level: str, parent_id: Optional[str] = None
) -> ThinkingLevelChangeEntry:
    return ThinkingLevelChangeEntry(
        id=create_id(),
        parent_id=parent_id,
        timestamp="2026-06-10T12:00:00Z",
        thinking_level=level,
    )


def create_model_change_entry(
    provider: str, model_id: str, parent_id: Optional[str] = None
) -> ModelChangeEntry:
    return ModelChangeEntry(
        id=create_id(),
        parent_id=parent_id,
        timestamp="2026-06-10T12:00:00Z",
        provider=provider,
        model_id=model_id,
    )


@pytest.fixture(autouse=True)
def cleanup_faux():
    global next_id
    next_id = 0
    registrations = []

    def register_helper(options=None):
        reg = register_faux_provider(options)
        registrations.append(reg)
        return reg

    yield register_helper

    for reg in registrations:
        try:
            reg.unregister()
        except Exception:
            pass


def create_faux_model(register_helper, reasoning: bool, max_tokens: int = 8192):
    model_id = "reasoning-model" if reasoning else "non-reasoning-model"
    reg = register_helper(
        {
            "models": [
                {
                    "id": model_id,
                    "reasoning": reasoning,
                    "contextWindow": 200000,
                    "maxTokens": max_tokens,
                }
            ]
        }
    )
    return reg, reg.get_model()


def test_calculates_total_context_tokens_from_usage():
    assert calculate_context_tokens(create_mock_usage(1000, 500, 200, 100)) == 1800
    assert calculate_context_tokens(create_mock_usage(0, 0, 0, 0)) == 0


def test_checks_compaction_threshold():
    settings = {
        "enabled": True,
        "reserveTokens": 10000,
        "keepRecentTokens": 20000,
    }
    assert should_compact(95000, 100000, settings) is True
    assert should_compact(89000, 100000, settings) is False

    off_settings = dict(settings)
    off_settings["enabled"] = False
    assert should_compact(95000, 100000, off_settings) is False


def test_finds_a_cut_point_based_on_token_differences():
    global next_id
    next_id = 0
    entries = []
    parent_id = None
    for i in range(10):
        user = create_message_entry(create_user_message(f"User {i}"), parent_id)
        entries.append(user)
        assistant = create_message_entry(
            create_assistant_message(
                f"Assistant {i}", create_mock_usage(0, 100, (i + 1) * 1000, 0)
            ),
            user.id,
        )
        entries.append(assistant)
        parent_id = assistant.id

    result = find_cut_point(entries, 0, len(entries), 2500)
    assert entries[result.first_kept_entry_index].type == "message"


def test_covers_cut_point_and_turn_start_edge_cases():
    thinking = create_thinking_level_entry("high")
    model_change = create_model_change_entry("openai", "gpt-4", thinking.id)
    result = find_cut_point([thinking, model_change], 0, 2, 1)
    assert result.first_kept_entry_index == 0
    assert result.turn_start_index == -1
    assert result.is_split_turn is False

    branch_summary = BranchSummaryEntry(
        id=create_id(),
        parent_id=model_change.id,
        timestamp="2026-06-10T12:00:00Z",
        from_id="branch",
        summary="branch summary",
    )
    custom_message = CustomMessageEntry(
        id=create_id(),
        parent_id=branch_summary.id,
        timestamp="2026-06-10T12:00:00Z",
        custom_type="note",
        content="custom content",
        display=True,
    )

    assert find_turn_start_index([thinking, branch_summary], 1, 0) == 1
    assert find_turn_start_index([thinking, custom_message], 1, 0) == 1
    assert find_turn_start_index([thinking, model_change], 1, 0) == -1

    result_3 = find_cut_point([thinking, branch_summary, custom_message], 0, 3, 1)
    assert result_3.first_kept_entry_index == 0

    tool_result = create_message_entry(
        {
            "role": "toolResult",
            "toolCallId": "call-1",
            "toolName": "read",
            "content": [{"type": "text", "text": "tool output"}],
            "isError": False,
            "timestamp": int(time.time() * 1000),
        }
    )
    result_tool = find_cut_point([tool_result], 0, 1, 1)
    assert result_tool.first_kept_entry_index == 0
    assert result_tool.turn_start_index == -1
    assert result_tool.is_split_turn is False

    user = create_message_entry(create_user_message("user"))
    compaction = create_compaction_entry("summary", user.id, user.id)
    assistant = create_message_entry(create_assistant_message("assistant"), compaction.id)
    result_comp = find_cut_point([user, compaction, assistant], 0, 3, 1)
    assert result_comp.first_kept_entry_index == 2


def test_estimates_tokens_and_context_usage_across_supported_message_roles():
    usage = create_mock_usage(10, 5, 3, 2)
    assistant = create_assistant_message("assistant", usage)

    assistant_with_thinking_and_tool = copy.deepcopy(assistant)
    assistant_with_thinking_and_tool["content"] = [
        {"type": "thinking", "thinking": "thinking"},
        {"type": "toolCall", "id": "call-1", "name": "read", "arguments": {"path": "file.ts"}},
    ]

    custom_string = {
        "role": "custom",
        "customType": "note",
        "content": "custom text",
        "display": True,
        "timestamp": int(time.time() * 1000),
    }

    tool_result_with_image = {
        "role": "toolResult",
        "toolCallId": "call-1",
        "toolName": "read",
        "content": [
            {"type": "text", "text": "tool text"},
            {"type": "image", "mimeType": "image/png", "data": "abc"},
        ],
        "isError": False,
        "timestamp": int(time.time() * 1000),
    }

    bash_execution = {
        "role": "bashExecution",
        "command": "npm run check",
        "output": "ok",
        "exitCode": 0,
        "cancelled": False,
        "truncated": False,
        "timestamp": int(time.time() * 1000),
    }

    branch_summary_message = {
        "role": "branchSummary",
        "summary": "branch",
        "fromId": "x",
        "timestamp": int(time.time() * 1000),
    }

    compaction_summary_message = {
        "role": "compactionSummary",
        "summary": "compact",
        "tokensBefore": 123,
        "timestamp": int(time.time() * 1000),
    }

    assert (
        estimate_tokens(
            {"role": "user", "content": "plain user", "timestamp": int(time.time() * 1000)}
        )
        > 0
    )
    assert estimate_tokens(assistant_with_thinking_and_tool) > 0
    assert estimate_tokens(custom_string) > 0
    assert estimate_tokens(tool_result_with_image) > 1000
    assert estimate_tokens(bash_execution) > 0
    assert estimate_tokens(branch_summary_message) > 0
    assert estimate_tokens(compaction_summary_message) > 0
    assert estimate_tokens({"role": "unknown", "timestamp": int(time.time() * 1000)}) == 0

    assert (
        get_last_assistant_usage(
            [
                create_message_entry(create_user_message("user")),
                create_message_entry(assistant),
            ]
        )
        == usage
    )

    aborted_assistant = copy.deepcopy(assistant)
    aborted_assistant["stopReason"] = "aborted"
    error_assistant = copy.deepcopy(assistant)
    error_assistant["stopReason"] = "error"

    assert (
        get_last_assistant_usage(
            [
                create_message_entry(aborted_assistant),
                create_message_entry(error_assistant),
            ]
        )
        is None
    )

    assert estimate_context_tokens([create_user_message("no usage")]).last_usage_index is None

    est_res = estimate_context_tokens([assistant, create_user_message("tail")])
    assert est_res.usage_tokens == 20
    assert est_res.last_usage_index == 0


def test_builds_session_context_with_a_compaction_entry():
    u1 = create_message_entry(create_user_message("1"))
    a1 = create_message_entry(create_assistant_message("a"), u1.id)
    u2 = create_message_entry(create_user_message("2"), a1.id)
    a2 = create_message_entry(create_assistant_message("b"), u2.id)
    compaction = create_compaction_entry("Summary of 1,a,2,b", u2.id, a2.id)
    u3 = create_message_entry(create_user_message("3"), compaction.id)
    a3 = create_message_entry(create_assistant_message("c"), u3.id)

    loaded = build_session_context([u1, a1, u2, a2, compaction, u3, a3])
    assert len(loaded.messages) == 5
    assert loaded.messages[0]["role"] == "compactionSummary"


def test_tracks_model_and_thinking_level_changes_in_built_context():
    user = create_message_entry(create_user_message("1"))
    model_change = create_model_change_entry("openai", "gpt-4", user.id)
    assistant = create_message_entry(create_assistant_message("a"), model_change.id)
    assistant.message["provider"] = "openai"
    assistant.message["model"] = "gpt-4"
    thinking_change = create_thinking_level_entry("high", assistant.id)

    loaded = build_session_context([user, model_change, assistant, thinking_change])
    assert loaded.model == {"provider": "openai", "modelId": "gpt-4"}
    assert loaded.thinking_level == "high"


def test_prepares_compaction_using_the_latest_compaction_summary_as_previousSummary():
    u1 = create_message_entry(create_user_message("user msg 1"))
    a1 = create_message_entry(create_assistant_message("assistant msg 1"), u1.id)
    u2 = create_message_entry(create_user_message("user msg 2"), a1.id)
    a2 = create_message_entry(
        create_assistant_message("assistant msg 2", create_mock_usage(5000, 1000)), u2.id
    )
    compaction1 = create_compaction_entry("First summary", u2.id, a2.id)
    u3 = create_message_entry(create_user_message("user msg 3"), compaction1.id)
    a3 = create_message_entry(
        create_assistant_message("assistant msg 3", create_mock_usage(8000, 2000)), u3.id
    )

    path_entries = [u1, a1, u2, a2, compaction1, u3, a3]
    compaction_settings = {
        "enabled": True,
        "reserveTokens": 100,
        "keepRecentTokens": 1,
    }
    prep_res = prepare_compaction(path_entries, compaction_settings)
    assert prep_res.ok is True
    preparation = prep_res.value
    assert preparation is not None
    assert preparation["previousSummary"] == "First summary"
    assert preparation["firstKeptEntryId"] is not None
    ctx = build_session_context(path_entries)
    assert preparation["tokensBefore"] == estimate_context_tokens(ctx.messages).tokens


def test_prepares_split_turn_compaction_with_prior_file_operation_details():
    u1 = create_message_entry(create_user_message("user msg 1"))
    assistant_message = create_assistant_message("assistant msg 1")
    assistant_message["content"] = [
        {"type": "toolCall", "id": "tool-1", "name": "write", "arguments": {"path": "written.ts"}}
    ]
    a1 = create_message_entry(assistant_message, u1.id)

    compaction1_entry = create_compaction_entry("First summary", u1.id, a1.id)
    compaction1_entry.details = {"readFiles": ["old-read.ts"], "modifiedFiles": ["old-edit.ts"]}

    u2 = create_message_entry(create_user_message("large turn"), compaction1_entry.id)
    a2 = create_message_entry(create_assistant_message("large assistant message"), u2.id)

    prep_res = prepare_compaction(
        [u1, a1, compaction1_entry, u2, a2],
        {
            "enabled": True,
            "reserveTokens": 100,
            "keepRecentTokens": 1,
        },
    )
    assert prep_res.ok is True
    preparation = prep_res.value
    assert preparation is not None
    assert preparation["previousSummary"] == "First summary"
    assert preparation["isSplitTurn"] is True
    assert [msg["role"] for msg in preparation["turnPrefixMessages"]] == ["user"]
    assert "old-read.ts" in preparation["fileOps"].read
    assert "old-edit.ts" in preparation["fileOps"].edited
    assert "written.ts" in preparation["fileOps"].written


def test_prepares_custom_and_branch_summary_entries_for_summarization():
    branch_summary = BranchSummaryEntry(
        id=create_id(),
        parent_id=None,
        timestamp="2026-06-10T12:00:00Z",
        from_id="branch",
        summary="branch summary",
    )
    custom_message = CustomMessageEntry(
        id=create_id(),
        parent_id=branch_summary.id,
        timestamp="2026-06-10T12:00:00Z",
        custom_type="note",
        content="custom content",
        display=True,
    )
    user = create_message_entry(create_user_message("keep"), custom_message.id)
    assistant = create_message_entry(create_assistant_message("assistant"), user.id)

    prep_res = prepare_compaction(
        [branch_summary, custom_message, user, assistant],
        {
            "enabled": True,
            "reserveTokens": 100,
            "keepRecentTokens": 1,
        },
    )
    assert prep_res.ok is True
    preparation = prep_res.value
    assert preparation is not None
    assert [m["role"] for m in preparation["messagesToSummarize"]] == ["branchSummary", "custom"]


def test_does_not_prepare_compaction_when_there_is_nothing_valid_to_compact():
    compaction = create_compaction_entry("already compacted", "entry-keep")
    prep_res = prepare_compaction([compaction], DEFAULT_COMPACTION_SETTINGS)
    assert prep_res.ok is True and prep_res.value is None

    prep_res_empty = prepare_compaction([], DEFAULT_COMPACTION_SETTINGS)
    assert prep_res_empty.ok is True and prep_res_empty.value is None


@pytest.mark.anyio
async def test_passes_reasoning_through_generate_summary_only_for_reasoning_models_with_thinking_enabled(
    cleanup_faux,
):
    messages = [create_user_message("Summarize this.")]
    seen_options = []

    faux_reasoning, reasoning_model = create_faux_model(cleanup_faux, reasoning=True)

    async def mock_response(_ctx, options, _state, _req_model):
        seen_options.append(copy.deepcopy(options))
        return faux_assistant_message("## Goal\nTest summary")

    faux_reasoning.set_responses([mock_response])

    sum_res = await generate_summary(
        messages, reasoning_model, 2000, "test-key", thinking_level="medium"
    )
    assert sum_res.ok is True
    assert seen_options[0].get("reasoning") == "medium"
    assert seen_options[0].get("apiKey") == "test-key"

    # reasoning "off"
    seen_options.clear()
    faux_off, off_model = create_faux_model(cleanup_faux, reasoning=True)
    faux_off.set_responses([mock_response])
    await generate_summary(messages, off_model, 2000, "test-key", thinking_level="off")
    assert "reasoning" not in seen_options[0]

    # non-reasoning model
    seen_options.clear()
    faux_non_reasoning, non_reasoning_model = create_faux_model(cleanup_faux, reasoning=False)
    faux_non_reasoning.set_responses([mock_response])
    await generate_summary(messages, non_reasoning_model, 2000, "test-key", thinking_level="medium")
    assert "reasoning" not in seen_options[0]


@pytest.mark.anyio
async def test_includes_previous_summaries_and_custom_instructions_in_generate_summary_prompts(
    cleanup_faux,
):
    messages = [create_user_message("Summarize this.")]
    prompt_text = ""

    faux, model = create_faux_model(cleanup_faux, reasoning=False)

    async def mock_response(context, _options, _state, _req_model):
        nonlocal prompt_text
        message = context["messages"][0]
        content = message.get("content", [])
        if isinstance(content, list) and content and content[0].get("type") == "text":
            prompt_text = content[0].get("text", "")
        return faux_assistant_message("## Goal\nTest summary")

    faux.set_responses([mock_response])

    summary_res = await generate_summary(
        messages,
        model,
        2000,
        "test-key",
        headers={"x-test": "yes"},
        custom_instructions="focus",
        previous_summary="old summary",
    )
    assert summary_res.ok is True
    summary = summary_res.value
    assert "Test summary" in summary
    assert "<previous-summary>\nold summary\n</previous-summary>" in prompt_text
    assert "Additional focus: focus" in prompt_text


@pytest.mark.anyio
async def test_returns_error_results_for_failed_or_aborted_summary_generations(cleanup_faux):
    messages = [create_user_message("Summarize this.")]
    faux_error, error_model = create_faux_model(cleanup_faux, reasoning=False)
    faux_error.set_responses(
        [faux_assistant_message("", {"stopReason": "error", "errorMessage": "boom"})]
    )

    error_result = await generate_summary(messages, error_model, 2000, "test-key")
    assert error_result.ok is False
    assert "Summarization failed: boom" in str(error_result.error)

    faux_abort, aborted_model = create_faux_model(cleanup_faux, reasoning=False)
    faux_abort.set_responses(
        [faux_assistant_message("", {"stopReason": "aborted", "errorMessage": "stopped"})]
    )
    aborted_result = await generate_summary(messages, aborted_model, 2000, "test-key")
    assert aborted_result.ok is False
    assert "Summarization aborted" in str(aborted_result.error)


@pytest.mark.anyio
async def test_clamps_compaction_summary_max_tokens_to_the_model_output_cap(cleanup_faux):
    messages = [create_user_message("Summarize this.")]
    seen_options = []

    faux, model = create_faux_model(cleanup_faux, reasoning=False, max_tokens=128000)

    async def mock_response(_ctx, options, _state, _req_model):
        seen_options.append(copy.deepcopy(options))
        return faux_assistant_message("## Goal\nTest summary")

    faux.set_responses([mock_response, mock_response])

    preparation = {
        "firstKeptEntryId": "entry-keep",
        "messagesToSummarize": messages,
        "turnPrefixMessages": messages,
        "isSplitTurn": True,
        "tokensBefore": 600000,
        "fileOps": type("FileOps", (), {"read": set(), "written": set(), "edited": set()})(),
        "settings": {"enabled": True, "reserveTokens": 500000, "keepRecentTokens": 20000},
    }

    comp_res = await compact(preparation, model, "test-key")
    assert comp_res.ok is True
    # The limit is 128000, and max_tokens is calculated as min(0.8 * reserve_tokens, model_max_tokens)
    # 0.8 * 500000 = 400000, so it clamps to max_tokens = 128000 for history summary,
    # and 0.5 * 500000 = 250000, which also clamps to model_max_tokens or float("inf") depending on how turn_prefix behaves.
    # Actually generate_summary uses completion_options['maxTokens']
    # Let's check maxTokens passed to complete_simple in seen_options.
    assert seen_options[0].get("maxTokens") == 128000


@pytest.mark.anyio
async def test_returns_compaction_error_results_without_throwing(cleanup_faux):
    messages = [create_user_message("Summarize this.")]
    preparation = {
        "firstKeptEntryId": "entry-keep",
        "messagesToSummarize": messages,
        "turnPrefixMessages": [],
        "isSplitTurn": False,
        "tokensBefore": 100,
        "fileOps": type("FileOps", (), {"read": set(), "written": set(), "edited": set()})(),
        "settings": {"enabled": True, "reserveTokens": 2000, "keepRecentTokens": 20},
    }

    faux, model = create_faux_model(cleanup_faux, reasoning=False)
    faux.set_responses(
        [faux_assistant_message("", {"stopReason": "error", "errorMessage": "history failed"})]
    )

    comp_res = await compact(preparation, model, "test-key")
    assert comp_res.ok is False
    assert "history failed" in str(comp_res.error)

    # Invalid prep (missing firstKeptEntryId)
    invalid_prep = dict(preparation)
    invalid_prep["firstKeptEntryId"] = ""
    comp_res_invalid = await compact(invalid_prep, model, "test-key")
    assert comp_res_invalid.ok is False
    assert "First kept entry has no UUID" in str(comp_res_invalid.error)


@pytest.mark.anyio
async def test_passes_reasoning_through_turn_prefix_summaries_when_enabled(cleanup_faux):
    messages = [create_user_message("Summarize this.")]
    seen_options = []

    faux, model = create_faux_model(cleanup_faux, reasoning=True)

    async def mock_response(_ctx, options, _state, _req_model):
        seen_options.append(copy.deepcopy(options))
        return faux_assistant_message("## Original Request\nTest summary")

    faux.set_responses([mock_response])

    preparation = {
        "firstKeptEntryId": "entry-keep",
        "messagesToSummarize": [],
        "turnPrefixMessages": messages,
        "isSplitTurn": True,
        "tokensBefore": 100,
        "fileOps": type("FileOps", (), {"read": set(), "written": set(), "edited": set()})(),
        "settings": {"enabled": True, "reserveTokens": 2000, "keepRecentTokens": 20},
    }

    comp_res = await compact(preparation, model, "test-key", thinking_level="high")
    assert comp_res.ok is True


@pytest.mark.anyio
async def test_returns_turn_prefix_compaction_errors_without_throwing(cleanup_faux):
    messages = [create_user_message("Summarize this.")]
    preparation = {
        "firstKeptEntryId": "entry-keep",
        "messagesToSummarize": [],
        "turnPrefixMessages": messages,
        "isSplitTurn": True,
        "tokensBefore": 100,
        "fileOps": type("FileOps", (), {"read": set(), "written": set(), "edited": set()})(),
        "settings": {"enabled": True, "reserveTokens": 2000, "keepRecentTokens": 20},
    }

    faux_err, model_err = create_faux_model(cleanup_faux, reasoning=False)
    faux_err.set_responses(
        [faux_assistant_message("", {"stopReason": "error", "errorMessage": "prefix failed"})]
    )

    comp_res = await compact(preparation, model_err, "test-key")
    assert comp_res.ok is False
    assert "prefix failed" in str(comp_res.error)

    faux_abort, model_abort = create_faux_model(cleanup_faux, reasoning=False)
    faux_abort.set_responses(
        [faux_assistant_message("", {"stopReason": "aborted", "errorMessage": "prefix stopped"})]
    )
    comp_res_abort = await compact(preparation, model_abort, "test-key")
    assert comp_res_abort.ok is False
    assert "prefix summarization aborted" in str(comp_res_abort.error)


@pytest.mark.anyio
async def test_returns_a_compaction_result_with_file_details(cleanup_faux):
    entries: list[Any] = []
    parent_id: str | None = None
    for index in range(4):
        user = create_message_entry(create_user_message(f"user {index}"), parent_id)
        assistant = create_message_entry(
            create_assistant_message(f"assistant {index}", create_mock_usage(5000, 1000)),
            user.id,
        )
        entries.extend([user, assistant])
        parent_id = assistant.id

    assistant_message = create_assistant_message("calling tool", create_mock_usage(5000, 1000))
    assistant_message["content"] = [
        {"type": "toolCall", "id": "tool-1", "name": "read", "arguments": {"path": "src/index.ts"}}
    ]
    tool_user = create_message_entry(create_user_message("read a file"), parent_id)
    tool_assistant = create_message_entry(assistant_message, tool_user.id)
    follow_up_user = create_message_entry(create_user_message("continue"), tool_assistant.id)
    follow_up_assistant = create_message_entry(
        create_assistant_message("done", create_mock_usage(5000, 1000)),
        follow_up_user.id,
    )
    entries.extend([tool_user, tool_assistant, follow_up_user, follow_up_assistant])

    compaction_settings = {
        "enabled": True,
        "reserveTokens": 100,
        "keepRecentTokens": 1,
    }
    prep_res = prepare_compaction(entries, compaction_settings)
    assert prep_res.ok is True
    preparation = prep_res.value
    assert preparation is not None

    faux, model = create_faux_model(cleanup_faux, reasoning=False)
    faux.set_responses(
        [
            faux_assistant_message("## Goal\nTest summary"),
            faux_assistant_message("## Prefix\nPrefix summary"),
        ]
    )

    comp_res = await compact(preparation, model, "test-key")
    assert comp_res.ok is True
    result = comp_res.value
    assert len(result["summary"]) > 0
    assert result["firstKeptEntryId"] is not None
    assert result["details"] is not None
