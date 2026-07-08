from typing import Any, Callable, Sequence, TypedDict


class AbortSignal:
    """A signal object that allows you to communicate with a DOM request

    and abort it if required via an AbortController object.
    """

    def __init__(self) -> None:
        self._aborted = False
        self._reason: Any = None
        self._listeners: list[Callable[[], None]] = []

    @property
    def aborted(self) -> bool:
        return self._aborted

    @property
    def reason(self) -> Any:
        return self._reason

    def add_event_listener(
        self, event: str, listener: Callable[[], None], once: bool = False
    ) -> None:
        """Register an event handler for the abort event."""
        if event != "abort":
            return
        if self._aborted:
            if once:
                listener()
            else:
                self._listeners.append(listener)
                listener()
            return

        if once:

            def wrapper() -> None:
                self.remove_event_listener("abort", wrapper)
                listener()

            self._listeners.append(wrapper)
        else:
            self._listeners.append(listener)

    def remove_event_listener(self, event: str, listener: Callable[[], None]) -> None:
        """Unregister an event handler for the abort event."""
        if event != "abort":
            return
        if listener in self._listeners:
            self._listeners.remove(listener)

    def _abort(self, reason: Any = None) -> None:
        if self._aborted:
            return
        self._aborted = True
        self._reason = reason
        # Copy to avoid modification issues during iteration
        for listener in list(self._listeners):
            try:
                listener()
            except Exception:
                pass


class AbortController:
    """A controller object that allows you to abort one or more Web requests."""

    def __init__(self) -> None:
        self._signal = AbortSignal()

    @property
    def signal(self) -> AbortSignal:
        return self._signal

    def abort(self, reason: Any = None) -> None:
        """Abort the associated AbortSignal."""
        self._signal._abort(reason)


class CombinedAbortSignal(TypedDict, total=False):
    signal: AbortSignal
    cleanup: Callable[[], None]


def combine_abort_signals(
    signals: Sequence[AbortSignal | None],
) -> CombinedAbortSignal:
    """Combines multiple AbortSignal objects into a single CombinedAbortSignal."""
    active_signals = [s for s in signals if s is not None]
    if len(active_signals) == 0:
        return {"cleanup": lambda: None}
    if len(active_signals) == 1:
        return {"signal": active_signals[0], "cleanup": lambda: None}

    controller = AbortController()
    listeners: list[tuple[AbortSignal, Callable[[], None]]] = []

    def abort_action() -> None:
        reason = None
        for s in active_signals:
            if s.aborted:
                reason = s.reason
                break
        controller.abort(reason)

    for signal in active_signals:
        if signal.aborted:
            abort_action()
            break
        listener = abort_action
        signal.add_event_listener("abort", listener, once=True)
        listeners.append((signal, listener))

    def cleanup() -> None:
        for signal, listener in listeners:
            signal.remove_event_listener("abort", listener)

    return {
        "signal": controller.signal,
        "cleanup": cleanup,
    }
