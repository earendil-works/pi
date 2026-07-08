import asyncio
import pytest
from pi_mono.utils.event_stream import (
    EventStream,
    AssistantMessageEventStream,
    create_assistant_message_event_stream,
)
from pi_mono.ai.types import (
    AssistantMessageEvent,
    AssistantMessage,
)


@pytest.mark.anyio
async def test_event_stream_basic_push():
    events_received = []
    stream = EventStream[str, int](
        is_complete=lambda ev: ev == "done",
        extract_result=lambda ev: 42,
    )

    async def consume():
        async for event in stream:
            events_received.append(event)

    # We can run consumption and pushing concurrently
    consume_task = asyncio.create_task(consume())

    await asyncio.sleep(0.01)
    stream.push("first")
    await asyncio.sleep(0.01)
    stream.push("second")
    await asyncio.sleep(0.01)
    stream.push("done")

    await consume_task

    assert events_received == ["first", "second", "done"]
    assert await stream.result() == 42


@pytest.mark.anyio
async def test_event_stream_end_with_result():
    events_received = []
    stream = EventStream[str, int](
        is_complete=lambda ev: ev == "done",
        extract_result=lambda ev: 42,
    )

    async def consume():
        async for event in stream:
            events_received.append(event)

    consume_task = asyncio.create_task(consume())

    await asyncio.sleep(0.01)
    stream.push("first")
    await asyncio.sleep(0.01)
    stream.end(99)

    await consume_task

    assert events_received == ["first"]
    assert await stream.result() == 99


@pytest.mark.anyio
async def test_event_stream_end_without_result():
    events_received = []
    stream = EventStream[str, int](
        is_complete=lambda ev: ev == "done",
        extract_result=lambda ev: 42,
    )

    async def consume():
        async for event in stream:
            events_received.append(event)

    consume_task = asyncio.create_task(consume())

    await asyncio.sleep(0.01)
    stream.push("first")
    await asyncio.sleep(0.01)
    stream.end()

    await consume_task

    assert events_received == ["first"]

    # result() future is created, but not resolved as no result was provided.
    # We can verify the future is created but not done.
    future = stream._get_future()
    assert not future.done()


@pytest.mark.anyio
async def test_assistant_message_event_stream_done():
    stream = create_assistant_message_event_stream()
    assert isinstance(stream, AssistantMessageEventStream)

    partial_message: AssistantMessage = {
        "role": "assistant",
        "content": [],
        "model": "test-model",
    }
    final_message: AssistantMessage = {
        "role": "assistant",
        "content": [{"type": "text", "text": "hello"}],
        "model": "test-model",
    }

    start_event: AssistantMessageEvent = {
        "type": "start",
        "partial": partial_message,
    }
    done_event: AssistantMessageEvent = {
        "type": "done",
        "reason": "stop",
        "message": final_message,
    }

    events_received = []

    async def consume():
        async for ev in stream:
            events_received.append(ev)

    consume_task = asyncio.create_task(consume())
    stream.push(start_event)
    stream.push(done_event)
    await consume_task

    assert events_received == [start_event, done_event]
    res = await stream.result()
    assert res == final_message


@pytest.mark.anyio
async def test_assistant_message_event_stream_error():
    stream = AssistantMessageEventStream()

    error_message: AssistantMessage = {
        "role": "assistant",
        "content": [],
        "model": "test-model",
        "errorMessage": "something went wrong",
    }

    start_event: AssistantMessageEvent = {
        "type": "start",
        "partial": {},
    }
    error_event: AssistantMessageEvent = {
        "type": "error",
        "reason": "error",
        "error": error_message,
    }

    events_received = []

    async def consume():
        async for ev in stream:
            events_received.append(ev)

    consume_task = asyncio.create_task(consume())
    stream.push(start_event)
    stream.push(error_event)
    await consume_task

    assert events_received == [start_event, error_event]
    res = await stream.result()
    assert res == error_message


@pytest.mark.anyio
async def test_event_stream_lazy_future():
    stream = EventStream[str, int](
        is_complete=lambda ev: ev == "done",
        extract_result=lambda ev: 42,
    )

    # Initially, future should be None
    assert stream._final_result_future is None

    # Push a complete event first (before accessing the future)
    stream.push("done")
    assert stream._final_result_value == 42
    assert stream._done is True

    # Now call result() which internally gets/creates the future
    res = await stream.result()
    assert res == 42
    assert stream._final_result_future is not None
    assert stream._final_result_future.done()
    assert stream._final_result_future.result() == 42


@pytest.mark.anyio
async def test_event_stream_push_after_done():
    stream = EventStream[str, int](
        is_complete=lambda ev: ev == "done",
        extract_result=lambda ev: 42,
    )

    stream.push("done")
    stream.push("another")  # Should be ignored since stream is done

    events_received = []
    async for ev in stream:
        events_received.append(ev)

    assert events_received == ["done"]
