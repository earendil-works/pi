from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Callable, Generic, TypeVar

from pi_mono.ai.types import AssistantMessage, AssistantMessageEvent

T = TypeVar("T")
R = TypeVar("R")


class EventStream(Generic[T, R]):
    """Generic event stream class for async iteration."""

    def __init__(self, is_complete: Callable[[T], bool], extract_result: Callable[[T], R]) -> None:
        self._queue: list[T] = []
        self._waiting: list[Callable[[tuple[T, bool]], None]] = []  # [(lambda value, done: None)]
        self._done = False
        self._final_result: asyncio.Future[R] = asyncio.Future()
        self._is_complete = is_complete
        self._extract_result = extract_result

    def push(self, event: T) -> None:
        if self._done:
            return

        if self._is_complete(event):
            self._done = True
            self._final_result.set_result(self._extract_result(event))

        # Deliver to waiting consumer or queue it
        if self._waiting:
            waiter = self._waiting.pop(0)
            waiter((event, False))
        else:
            self._queue.append(event)

    def end(self, result: R | None = None) -> None:
        self._done = True
        if result is not None:
            self._final_result.set_result(result)

        # Notify all waiting consumers that we're done
        while self._waiting:
            waiter = self._waiting.pop(0)
            # Use a sentinel value that satisfies the type but won't be yielded
            waiter((None, True))  # type: ignore[arg-type]

    def __aiter__(self) -> AsyncIterator[T]:
        return self._async_iterator()

    async def _async_iterator(self) -> AsyncIterator[T]:
        while True:
            if self._queue:
                yield self._queue.pop(0)
            elif self._done:
                return
            else:
                future: asyncio.Future[tuple[T | None, bool]] = (
                    asyncio.get_event_loop().create_future()
                )

                def waiter(result: tuple[T | None, bool]) -> None:
                    future.set_result(result)

                self._waiting.append(waiter)
                event, done = await future
                if done:
                    return
                if event is not None:
                    yield event

    async def result(self) -> R:
        return await self._final_result


class AssistantMessageEventStream(EventStream[AssistantMessageEvent, AssistantMessage]):
    def __init__(self) -> None:
        super().__init__(
            lambda event: event["type"] in ("done", "error"),
            self._extract_result,
        )

    def _extract_result(self, event: AssistantMessageEvent) -> AssistantMessage:
        if event["type"] == "done":
            return event["message"]
        # type narrowing not inferred by mypy; "error" key only exists on error type
        return event["error"]  # type: ignore[typeddict-item]


def create_assistant_message_event_stream() -> AssistantMessageEventStream:
    return AssistantMessageEventStream()
