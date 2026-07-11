"""OAuth device code flow polling utilities."""

from __future__ import annotations

import asyncio
import time
from typing import Any, Awaitable, Callable, Generic, Protocol, TypeVar

T = TypeVar("T")

CANCEL_MESSAGE = "Login cancelled"
TIMEOUT_MESSAGE = "Device flow timed out"
SLOW_DOWN_TIMEOUT_MESSAGE = (
    "Device flow timed out after one or more slow_down responses. "
    "This is often caused by clock drift in WSL or VM environments. "
    "Please sync or restart the VM clock and try again."
)
MINIMUM_INTERVAL_MS = 1000
# RFC 8628 section 3.2: if the authorization server omits `interval`, use 5 seconds.
DEFAULT_POLL_INTERVAL_SECONDS = 5
# RFC 8628 section 3.5: `slow_down` means the polling interval must increase by 5 seconds.
SLOW_DOWN_INTERVAL_INCREMENT_MS = 5000


class OAuthDeviceCodeIncompletePollResult(Protocol):
    status: str  # "pending" | "slow_down" | "failed"
    message: str | None


class OAuthDeviceCodePollResult(OAuthDeviceCodeIncompletePollResult, Generic[T], Protocol):
    status: str  # "complete"
    value: T


class OAuthDeviceCodePollOptions(Protocol):
    intervalSeconds: int | None
    expiresInSeconds: int | None
    waitBeforeFirstPoll: bool | None
    poll: Callable[[], Awaitable[OAuthDeviceCodePollResult[Any]]]
    signal: Any  # AbortSignal


async def abortable_sleep(ms: int, signal: Any | None, cancel_message: str) -> None:
    """Sleep with abort signal support."""
    if signal is not None and getattr(signal, "aborted", False):
        raise RuntimeError(cancel_message)

    done = asyncio.Event()

    def on_abort() -> None:
        done.set()

    if signal is not None and hasattr(signal, "add_event_listener"):
        signal.add_event_listener("abort", on_abort)
    try:
        try:
            await asyncio.wait_for(done.wait(), timeout=max(0, ms) / 1000)
        except TimeoutError:
            return
        raise RuntimeError(cancel_message)
    finally:
        if signal is not None and hasattr(signal, "remove_event_listener"):
            signal.remove_event_listener("abort", on_abort)


async def poll_oauth_device_code_flow(options: OAuthDeviceCodePollOptions) -> Any:
    """Poll OAuth device code flow with backoff and slow_down handling."""
    expires_in = getattr(options, "expiresInSeconds", None)
    deadline = (
        int(time.time() * 1000) + int(expires_in) * 1000
        if expires_in is not None
        else float("inf")
    )
    interval_seconds = getattr(options, "intervalSeconds", None)
    interval_ms = max(
        MINIMUM_INTERVAL_MS,
        int((interval_seconds or DEFAULT_POLL_INTERVAL_SECONDS) * 1000),
    )

    signal = getattr(options, "signal", None)
    poll_fn = getattr(options, "poll", None)
    wait_before_first = bool(getattr(options, "waitBeforeFirstPoll", False))

    slow_down_responses = 0

    if wait_before_first:
        remaining_ms = deadline - int(time.time() * 1000)
        if remaining_ms > 0:
            await abortable_sleep(min(interval_ms, int(remaining_ms)), signal, CANCEL_MESSAGE)

    while int(time.time() * 1000) < deadline:
        if signal is not None and getattr(signal, "aborted", False):
            raise RuntimeError(CANCEL_MESSAGE)

        if poll_fn is None:
            raise RuntimeError("Poll function not provided")

        result = await poll_fn()

        if result.get("status") == "complete":
            return result.get("value")

        if result.get("status") == "failed":
            raise RuntimeError(result.get("message", "Poll failed"))

        if result.get("status") == "slow_down":
            slow_down_responses += 1
            # Prefer server-provided interval when given (GitHub reports the new
            # required minimum in `interval`); otherwise apply RFC 8628 +5s.
            server_interval = result.get("intervalSeconds")
            if (
                isinstance(server_interval, (int, float))
                and server_interval == server_interval  # not NaN
                and server_interval > 0
            ):
                interval_ms = max(MINIMUM_INTERVAL_MS, int(server_interval * 1000))
            else:
                interval_ms = max(
                    MINIMUM_INTERVAL_MS, interval_ms + SLOW_DOWN_INTERVAL_INCREMENT_MS
                )

        remaining_ms = deadline - int(time.time() * 1000)
        if remaining_ms <= 0:
            break

        await abortable_sleep(min(interval_ms, int(remaining_ms)), signal, CANCEL_MESSAGE)

    if slow_down_responses > 0:
        raise RuntimeError(SLOW_DOWN_TIMEOUT_MESSAGE)
    raise RuntimeError(TIMEOUT_MESSAGE)
