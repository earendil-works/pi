import asyncio
import logging
from typing import Any, Callable, Dict, List

logger = logging.getLogger(__name__)


class EventBusController:
    def __init__(self) -> None:
        self._handlers: Dict[str, List[Callable[[Any], Any]]] = {}

    def emit(self, channel: str, data: Any) -> None:
        if channel not in self._handlers:
            return

        for handler in list(self._handlers[channel]):
            try:
                if asyncio.iscoroutinefunction(handler):
                    try:
                        loop = asyncio.get_running_loop()
                        loop.create_task(handler(data))
                    except RuntimeError:
                        asyncio.run(handler(data))
                else:
                    handler(data)
            except Exception as err:
                logger.error(f"Event handler error ({channel}): {err}", exc_info=True)

    def on(self, channel: str, handler: Callable[[Any], Any]) -> Callable[[], None]:
        if channel not in self._handlers:
            self._handlers[channel] = []
        self._handlers[channel].append(handler)

        def unsubscribe() -> None:
            if channel in self._handlers and handler in self._handlers[channel]:
                self._handlers[channel].remove(handler)

        return unsubscribe

    def clear(self) -> None:
        self._handlers.clear()


def create_event_bus() -> EventBusController:
    return EventBusController()
