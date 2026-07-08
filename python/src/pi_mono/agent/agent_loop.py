import asyncio
import inspect
import time
from typing import Any, Callable, Coroutine, List, Union, TypedDict, cast

from pi_mono.ai.stream import stream_simple
from pi_mono.ai.types import (
    AssistantMessage,
    Context,
    Tool,
    ToolResultMessage,
    ToolCall,
    SimpleStreamOptions,
)
from pi_mono.agent.types import (
    AgentContext,
    AgentEvent,
    AgentLoopConfig,
    AgentMessage,
    AgentTool,
    AgentToolCall,
    AgentToolResult,
    BeforeToolCallResult,
    BeforeToolCallContext,
    AfterToolCallResult,
    AfterToolCallContext,
    StreamFn,
    PrepareNextTurnContext,
    ShouldStopAfterTurnContext,
)
from pi_mono.utils.abort_signals import AbortSignal
from pi_mono.utils.event_stream import EventStream
from pi_mono.utils.validation import validate_tool_arguments

AgentEventSink = Callable[[AgentEvent], Union[None, Coroutine[Any, Any, None]]]


async def maybe_await(val: Any) -> Any:
    if inspect.isawaitable(val):
        return await val
    return val


def create_agent_stream() -> EventStream[AgentEvent, List[AgentMessage]]:
    return EventStream[AgentEvent, List[AgentMessage]](
        is_complete=lambda event: event["type"] == "agent_end",
        extract_result=lambda event: event["messages"] if event["type"] == "agent_end" else [],  # type: ignore
    )


def agent_loop(
    prompts: List[AgentMessage],
    context: AgentContext,
    config: AgentLoopConfig,
    signal: AbortSignal | None = None,
    stream_fn: StreamFn | None = None,
) -> EventStream[AgentEvent, List[AgentMessage]]:
    stream = create_agent_stream()

    async def run() -> None:
        try:
            messages = await run_agent_loop(
                prompts,
                context,
                config,
                lambda event: stream.push(event),
                signal,
                stream_fn,
            )
            stream.end(messages)
        except Exception:
            stream.end([])
            raise

    asyncio.create_task(run())
    return stream


def agent_loop_continue(
    context: AgentContext,
    config: AgentLoopConfig,
    signal: AbortSignal | None = None,
    stream_fn: StreamFn | None = None,
) -> EventStream[AgentEvent, List[AgentMessage]]:
    if not context.get("messages"):
        raise ValueError("Cannot continue: no messages in context")

    if context["messages"][-1].get("role") == "assistant":
        raise ValueError("Cannot continue from message role: assistant")

    stream = create_agent_stream()

    async def run() -> None:
        try:
            messages = await run_agent_loop_continue(
                context,
                config,
                lambda event: stream.push(event),
                signal,
                stream_fn,
            )
            stream.end(messages)
        except Exception:
            stream.end([])
            raise

    asyncio.create_task(run())
    return stream


async def run_agent_loop(
    prompts: List[AgentMessage],
    context: AgentContext,
    config: AgentLoopConfig,
    emit: AgentEventSink,
    signal: AbortSignal | None = None,
    stream_fn: StreamFn | None = None,
) -> List[AgentMessage]:
    new_messages = list(prompts)
    current_context: AgentContext = {
        **context,
        "messages": list(context.get("messages", [])) + prompts,
    }

    await maybe_await(emit({"type": "agent_start"}))
    await maybe_await(emit({"type": "turn_start"}))
    for prompt in prompts:
        await maybe_await(emit({"type": "message_start", "message": prompt}))
        await maybe_await(emit({"type": "message_end", "message": prompt}))

    await run_loop(current_context, new_messages, config, signal, emit, stream_fn)
    return new_messages


async def run_agent_loop_continue(
    context: AgentContext,
    config: AgentLoopConfig,
    emit: AgentEventSink,
    signal: AbortSignal | None = None,
    stream_fn: StreamFn | None = None,
) -> List[AgentMessage]:
    if not context.get("messages"):
        raise ValueError("Cannot continue: no messages in context")

    if context["messages"][-1].get("role") == "assistant":
        raise ValueError("Cannot continue from message role: assistant")

    new_messages: List[AgentMessage] = []
    current_context: AgentContext = {
        **context,
        "messages": list(context["messages"]),
    }

    await maybe_await(emit({"type": "agent_start"}))
    await maybe_await(emit({"type": "turn_start"}))

    await run_loop(current_context, new_messages, config, signal, emit, stream_fn)
    return new_messages


async def run_loop(
    initial_context: AgentContext,
    new_messages: List[AgentMessage],
    initial_config: AgentLoopConfig,
    signal: AbortSignal | None,
    emit: AgentEventSink,
    stream_fn: StreamFn | None,
) -> None:
    current_context = initial_context
    config = initial_config
    first_turn = True

    get_steering = config.get("getSteeringMessages")
    pending_messages: List[AgentMessage] = await maybe_await(get_steering()) if get_steering else []

    while True:
        has_more_tool_calls = True

        while has_more_tool_calls or len(pending_messages) > 0:
            if not first_turn:
                await maybe_await(emit({"type": "turn_start"}))
            else:
                first_turn = False

            if len(pending_messages) > 0:
                for message in pending_messages:
                    await maybe_await(emit({"type": "message_start", "message": message}))
                    await maybe_await(emit({"type": "message_end", "message": message}))
                    current_context.setdefault("messages", []).append(message)
                    new_messages.append(message)
                pending_messages = []

            message = await stream_assistant_response(
                current_context, config, signal, emit, stream_fn
            )
            new_messages.append(message)

            if message.get("stopReason") in ("error", "aborted"):
                await maybe_await(emit({"type": "turn_end", "message": message, "toolResults": []}))
                await maybe_await(emit({"type": "agent_end", "messages": new_messages}))
                return

            tool_calls = [c for c in message.get("content", []) if c.get("type") == "toolCall"]

            tool_results: List[ToolResultMessage] = []
            has_more_tool_calls = False
            if len(tool_calls) > 0:
                executed_batch = await execute_tool_calls(
                    current_context, message, tool_calls, config, signal, emit
                )
                tool_results.extend(executed_batch["messages"])
                has_more_tool_calls = not executed_batch["terminate"]

                for result in tool_results:
                    current_context.setdefault("messages", []).append(result)
                    new_messages.append(result)

            await maybe_await(
                emit({"type": "turn_end", "message": message, "toolResults": tool_results})
            )

            prepare_next = config.get("prepareNextTurn")
            if prepare_next:
                next_turn_context: PrepareNextTurnContext = {
                    "message": message,
                    "toolResults": tool_results,
                    "context": current_context,
                    "newMessages": new_messages,
                }
                next_turn_snapshot = await maybe_await(prepare_next(next_turn_context))
                if next_turn_snapshot:
                    current_context = next_turn_snapshot.get("context", current_context)
                    config = {
                        **config,
                        "model": next_turn_snapshot.get("model", config.get("model")),
                    }
                    if "thinkingLevel" in next_turn_snapshot:
                        tl = next_turn_snapshot["thinkingLevel"]
                        config["reasoning"] = None if tl == "off" else tl  # type: ignore

            should_stop = config.get("shouldStopAfterTurn")
            if should_stop:
                stop_context: ShouldStopAfterTurnContext = {
                    "message": message,
                    "toolResults": tool_results,
                    "context": current_context,
                    "newMessages": new_messages,
                }
                if await maybe_await(should_stop(stop_context)):
                    await maybe_await(emit({"type": "agent_end", "messages": new_messages}))
                    return

            get_steering = config.get("getSteeringMessages")
            pending_messages = await maybe_await(get_steering()) if get_steering else []

        get_followup = config.get("getFollowUpMessages")
        followup_messages = await maybe_await(get_followup()) if get_followup else []
        if len(followup_messages) > 0:
            pending_messages = followup_messages
            continue

        break

    await maybe_await(emit({"type": "agent_end", "messages": new_messages}))


async def stream_assistant_response(
    context: AgentContext,
    config: AgentLoopConfig,
    signal: AbortSignal | None,
    emit: AgentEventSink,
    stream_fn: StreamFn | None,
) -> AssistantMessage:
    messages = context.get("messages", [])
    transform = config.get("transformContext")
    if transform:
        messages = await maybe_await(transform(messages, signal))

    convert = config["convertToLlm"]
    llm_messages = await maybe_await(convert(messages))

    llm_context: Context = {
        "systemPrompt": context.get("systemPrompt", ""),
        "messages": llm_messages,
        "tools": [
            {
                "name": t.name,
                "description": t.description,
                "parameters": t.parameters,
            }
            for t in context.get("tools", [])
        ],
    }

    stream_func = stream_fn or stream_simple

    get_key = config.get("getApiKey")
    resolved_api_key = (
        await maybe_await(get_key(config["model"]["provider"])) if get_key else None
    ) or config.get("apiKey")

    options = {**config}
    if resolved_api_key is not None:
        options["apiKey"] = resolved_api_key
    if signal is not None:
        options["signal"] = signal

    response = await maybe_await(
        stream_func(config["model"], llm_context, cast(SimpleStreamOptions, options))
    )

    partial_message: AssistantMessage | None = None
    added_partial = False

    async for event in response:
        event_type = event["type"]
        if event_type == "start":
            partial_message = event["partial"]
            if partial_message is not None:
                context.setdefault("messages", []).append(partial_message)
                added_partial = True
                await maybe_await(
                    emit(
                        cast(
                            AgentEvent,
                            {"type": "message_start", "message": dict(partial_message)},
                        )
                    )
                )

        elif event_type in (
            "text_start",
            "text_delta",
            "text_end",
            "thinking_start",
            "thinking_delta",
            "thinking_end",
            "toolcall_start",
            "toolcall_delta",
            "toolcall_end",
        ):
            if partial_message is not None:
                partial_message = event["partial"]
                if partial_message is not None:
                    context["messages"][-1] = partial_message
                    await maybe_await(
                        emit(
                            cast(
                                AgentEvent,
                                {
                                    "type": "message_update",
                                    "assistantMessageEvent": event,
                                    "message": dict(partial_message),
                                },
                            )
                        )
                    )

        elif event_type in ("done", "error"):
            final_message = await response.result()
            if added_partial:
                context["messages"][-1] = final_message
            else:
                context.setdefault("messages", []).append(final_message)

            if not added_partial:
                await maybe_await(
                    emit(
                        cast(
                            AgentEvent,
                            {"type": "message_start", "message": dict(final_message)},
                        )
                    )
                )

            await maybe_await(
                emit(
                    cast(
                        AgentEvent,
                        {"type": "message_end", "message": final_message},
                    )
                )
            )
            return final_message

    final_message = await response.result()
    if added_partial:
        context["messages"][-1] = final_message
    else:
        context.setdefault("messages", []).append(final_message)
        await maybe_await(
            emit(
                cast(
                    AgentEvent,
                    {"type": "message_start", "message": dict(final_message)},
                )
            )
        )

    await maybe_await(
        emit(
            cast(
                AgentEvent,
                {"type": "message_end", "message": final_message},
            )
        )
    )
    return final_message


class ExecutedToolCallBatch(TypedDict):
    messages: List[ToolResultMessage]
    terminate: bool


async def execute_tool_calls(
    currentContext: AgentContext,
    assistantMessage: AssistantMessage,
    toolCalls: List[AgentToolCall],
    config: AgentLoopConfig,
    signal: AbortSignal | None,
    emit: AgentEventSink,
) -> ExecutedToolCallBatch:
    # Check if any tool has sequential execution Mode
    has_sequential = False
    for tc in toolCalls:
        tool = next((t for t in currentContext.get("tools", []) if t.name == tc["name"]), None)
        if tool:
            mode = getattr(tool, "executionMode", getattr(tool, "execution_mode", None))
            if mode == "sequential":
                has_sequential = True
                break

    if config.get("toolExecution") == "sequential" or has_sequential:
        return await execute_tool_calls_sequential(
            currentContext, assistantMessage, toolCalls, config, signal, emit
        )
    return await execute_tool_calls_parallel(
        currentContext, assistantMessage, toolCalls, config, signal, emit
    )


async def execute_tool_calls_sequential(
    currentContext: AgentContext,
    assistantMessage: AssistantMessage,
    toolCalls: List[AgentToolCall],
    config: AgentLoopConfig,
    signal: AbortSignal | None,
    emit: AgentEventSink,
) -> ExecutedToolCallBatch:
    finalized_calls: List[dict] = []
    messages: List[ToolResultMessage] = []

    for toolCall in toolCalls:
        await maybe_await(
            emit(
                {
                    "type": "tool_execution_start",
                    "toolCallId": toolCall["id"],
                    "toolName": toolCall["name"],
                    "args": toolCall.get("arguments", {}),
                }
            )
        )
        await asyncio.sleep(0)

        preparation = await prepare_tool_call(
            currentContext, assistantMessage, toolCall, config, signal
        )
        if preparation["kind"] == "immediate":
            finalized = {
                "toolCall": toolCall,
                "result": preparation["result"],
                "isError": preparation["isError"],
            }
        else:
            executed = await execute_prepared_tool_call(preparation["value"], signal, emit)
            finalized = await finalize_executed_tool_call(
                currentContext,
                assistantMessage,
                preparation["value"],
                executed,
                config,
                signal,
            )

        await emit_tool_execution_end(finalized, emit)
        tool_result_message = create_tool_result_message(finalized)
        await emit_tool_result_message(tool_result_message, emit)
        finalized_calls.append(finalized)
        messages.append(tool_result_message)

        if signal and signal.aborted:
            break

    return {
        "messages": messages,
        "terminate": should_terminate_tool_batch(finalized_calls),
    }


async def execute_tool_calls_parallel(
    currentContext: AgentContext,
    assistantMessage: AssistantMessage,
    toolCalls: List[AgentToolCall],
    config: AgentLoopConfig,
    signal: AbortSignal | None,
    emit: AgentEventSink,
) -> ExecutedToolCallBatch:
    finalized_calls: List[Any] = []

    for toolCall in toolCalls:
        await maybe_await(
            emit(
                {
                    "type": "tool_execution_start",
                    "toolCallId": toolCall["id"],
                    "toolName": toolCall["name"],
                    "args": toolCall.get("arguments", {}),
                }
            )
        )
        await asyncio.sleep(0)

        preparation = await prepare_tool_call(
            currentContext, assistantMessage, toolCall, config, signal
        )
        if preparation["kind"] == "immediate":
            finalized = {
                "toolCall": toolCall,
                "result": preparation["result"],
                "isError": preparation["isError"],
            }
            await emit_tool_execution_end(finalized, emit)
            finalized_calls.append(finalized)
            if signal and signal.aborted:
                break
            continue

        # Define runner closures to run concurrently
        prep_val = preparation["value"]

        async def run_one(p=prep_val, tc=toolCall) -> dict:
            executed = await execute_prepared_tool_call(p, signal, emit)
            finalized = await finalize_executed_tool_call(
                currentContext, assistantMessage, p, executed, config, signal
            )
            await emit_tool_execution_end(finalized, emit)
            return finalized

        finalized_calls.append(run_one)
        if signal and signal.aborted:
            break

    # Execute all non-immediate functions concurrently
    async def run_task(entry) -> dict:
        if callable(entry):
            return await entry()
        return entry

    ordered_finalized_calls = await asyncio.gather(*(run_task(entry) for entry in finalized_calls))

    messages: List[ToolResultMessage] = []
    for finalized in ordered_finalized_calls:
        tool_result_message = create_tool_result_message(finalized)
        await emit_tool_result_message(tool_result_message, emit)
        messages.append(tool_result_message)

    return {
        "messages": messages,
        "terminate": should_terminate_tool_batch(ordered_finalized_calls),
    }


def should_terminate_tool_batch(finalized_calls: List[dict]) -> bool:
    return len(finalized_calls) > 0 and all(
        f.get("result", {}).get("terminate") is True for f in finalized_calls
    )


def prepare_tool_call_arguments(tool: AgentTool, tool_call: AgentToolCall) -> AgentToolCall:
    prep_args = getattr(tool, "prepare_arguments", getattr(tool, "prepareArguments", None))
    if not prep_args:
        return tool_call
    prepared_arguments = prep_args(tool_call.get("arguments", {}))
    if prepared_arguments is tool_call.get("arguments"):
        return tool_call
    return {**tool_call, "arguments": prepared_arguments}


async def prepare_tool_call(
    currentContext: AgentContext,
    assistantMessage: AssistantMessage,
    toolCall: AgentToolCall,
    config: AgentLoopConfig,
    signal: AbortSignal | None,
) -> dict:
    tool = next((t for t in currentContext.get("tools", []) if t.name == toolCall["name"]), None)
    if not tool:
        return {
            "kind": "immediate",
            "result": create_error_tool_result(f"Tool {toolCall['name']} not found"),
            "isError": True,
        }

    try:
        prepared_tool_call = prepare_tool_call_arguments(tool, toolCall)

        # Convert AgentTool to dict mapping for validation helper
        tool_dict: Tool = {
            "name": tool.name,
            "description": tool.description,
            "parameters": tool.parameters,
        }

        # validate_tool_arguments expects Tool and ToolCall as TypedDict
        validated_args = validate_tool_arguments(tool_dict, cast(ToolCall, prepared_tool_call))

        before_call = config.get("beforeToolCall")
        if before_call:
            before_context: BeforeToolCallContext = {
                "assistantMessage": assistantMessage,
                "toolCall": toolCall,
                "args": validated_args,
                "context": currentContext,
            }
            before_result: BeforeToolCallResult = await maybe_await(
                before_call(before_context, signal)
            )

            if signal and signal.aborted:
                return {
                    "kind": "immediate",
                    "result": create_error_tool_result("Operation aborted"),
                    "isError": True,
                }

            if before_result and before_result.get("block") is True:
                return {
                    "kind": "immediate",
                    "result": create_error_tool_result(
                        before_result.get("reason", "Tool execution was blocked")
                    ),
                    "isError": True,
                }

        if signal and signal.aborted:
            return {
                "kind": "immediate",
                "result": create_error_tool_result("Operation aborted"),
                "isError": True,
            }

        return {
            "kind": "prepared",
            "value": {
                "toolCall": toolCall,
                "tool": tool,
                "args": validated_args,
            },
        }
    except Exception as error:
        return {
            "kind": "immediate",
            "result": create_error_tool_result(str(error)),
            "isError": True,
        }


async def execute_prepared_tool_call(
    prepared: dict,
    signal: AbortSignal | None,
    emit: AgentEventSink,
) -> dict:
    update_events: List[Any] = []
    tool = prepared["tool"]
    tool_call = prepared["toolCall"]
    args = prepared["args"]

    def update_callback(partial_result: AgentToolResult) -> None:
        async def emit_update() -> None:
            await maybe_await(
                emit(
                    {
                        "type": "tool_execution_update",
                        "toolCallId": tool_call["id"],
                        "toolName": tool_call["name"],
                        "args": tool_call.get("arguments", {}),
                        "partialResult": partial_result,
                    }
                )
            )

        update_events.append(emit_update())

    try:
        # Check if execute is async/sync
        exec_func = tool.execute
        result = await maybe_await(exec_func(tool_call["id"], args, signal, update_callback))
        await asyncio.gather(*update_events)
        return {"result": result, "isError": False}
    except Exception as error:
        await asyncio.gather(*update_events)
        return {
            "result": create_error_tool_result(str(error)),
            "isError": True,
        }


async def finalize_executed_tool_call(
    currentContext: AgentContext,
    assistantMessage: AssistantMessage,
    prepared: dict,
    executed: dict,
    config: AgentLoopConfig,
    signal: AbortSignal | None,
) -> dict:
    result = executed["result"]
    is_error = executed["isError"]

    after_call = config.get("afterToolCall")
    if after_call:
        try:
            after_context: AfterToolCallContext = {
                "assistantMessage": assistantMessage,
                "toolCall": prepared["toolCall"],
                "args": prepared["args"],
                "result": result,
                "isError": is_error,
                "context": currentContext,
            }
            after_result: AfterToolCallResult = await maybe_await(after_call(after_context, signal))

            if after_result:
                result = {
                    "content": after_result.get("content", result.get("content")),
                    "details": after_result.get("details", result.get("details")),
                }
                if "terminate" in after_result:
                    result["terminate"] = after_result["terminate"]
                if "isError" in after_result:
                    is_error = after_result["isError"]
        except Exception as error:
            result = create_error_tool_result(str(error))
            is_error = True

    return {
        "toolCall": prepared["toolCall"],
        "result": result,
        "isError": is_error,
    }


def create_error_tool_result(message: str) -> AgentToolResult:
    return {
        "content": [{"type": "text", "text": message}],
        "details": {},
    }


async def emit_tool_execution_end(finalized: dict, emit: AgentEventSink) -> None:
    await maybe_await(
        emit(
            {
                "type": "tool_execution_end",
                "toolCallId": finalized["toolCall"]["id"],
                "toolName": finalized["toolCall"]["name"],
                "result": finalized["result"],
                "isError": finalized["isError"],
            }
        )
    )


def create_tool_result_message(finalized: dict) -> ToolResultMessage:
    return {
        "role": "toolResult",
        "toolCallId": finalized["toolCall"]["id"],
        "toolName": finalized["toolCall"]["name"],
        "content": finalized["result"].get("content", []),
        "details": finalized["result"].get("details", {}),
        "isError": finalized["isError"],
        "timestamp": int(time.time() * 1000),
    }


async def emit_tool_result_message(
    tool_result_message: ToolResultMessage, emit: AgentEventSink
) -> None:
    await maybe_await(emit({"type": "message_start", "message": tool_result_message}))
    await maybe_await(emit({"type": "message_end", "message": tool_result_message}))
