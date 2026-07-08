import asyncio
from typing import Callable, Generic, TypeVar, AsyncIterable, AsyncIterator

from pi_mono.ai.types import AssistantMessage, AssistantMessageEvent

T = TypeVar("T")
R = TypeVar("R")


class EventStream(Generic[T, R], AsyncIterable[T]):
    def __init__(self, is_complete: Callable[[T], bool], extract_result: Callable[[T], R]):
        self.is_complete = is_complete
        self.extract_result = extract_result
        self._queue: asyncio.Queue[T | None] = asyncio.Queue()
        self._done = False
        self._final_result_future: asyncio.Future[R] | None = None
        self._final_result_value: R | None = None

    def _get_future(self) -> asyncio.Future[R]:
        if self._final_result_future is None:
            self._final_result_future = asyncio.get_running_loop().create_future()
            if self._done and self._final_result_value is not None:
                self._final_result_future.set_result(self._final_result_value)
        return self._final_result_future

    def push(self, event: T) -> None:
        if self._done:
            return

        if self.is_complete(event):
            self._done = True
            extracted = self.extract_result(event)
            self._final_result_value = extracted
            if self._final_result_future is not None:
                self._final_result_future.set_result(extracted)
            self._queue.put_nowait(event)
            self._queue.put_nowait(None)
            return

        self._queue.put_nowait(event)

    def end(self, result: R | None = None) -> None:
        if self._done:
            return
        self._done = True
        if result is not None:
            self._final_result_value = result
            if self._final_result_future is not None:
                self._final_result_future.set_result(result)
        self._queue.put_nowait(None)

    def __aiter__(self) -> AsyncIterator[T]:
        return self

    async def __anext__(self) -> T:
        item = await self._queue.get()
        if item is None:
            raise StopAsyncIteration
        return item

    async def result(self) -> R:
        return await self._get_future()


class AssistantMessageEventStream(EventStream[AssistantMessageEvent, AssistantMessage]):
    def __init__(self) -> None:
        super().__init__(
            is_complete=lambda event: event["type"] in ("done", "error"),
            extract_result=self._extract_result,
        )

    def _extract_result(self, event: AssistantMessageEvent) -> AssistantMessage:
        if event["type"] == "done":
            return event["message"]
        elif event["type"] == "error":
            return event["error"]
        raise ValueError("Unexpected event type for final result")


def create_assistant_message_event_stream() -> AssistantMessageEventStream:
    return AssistantMessageEventStream()
