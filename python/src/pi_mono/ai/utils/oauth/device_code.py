"""OAuth device code flow polling utilities."""

import asyncio
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
DEFAULT_POLL_INTERVAL_SECONDS = 5
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
    poll: Callable[[], Awaitable[OAuthDeviceCodePollResult[Any]]]
    signal: Any  # AbortSignal


async def abortable_sleep(ms: int, signal: Any | None, cancel_message: str) -> None:
    """Sleep with abort signal support."""
    if signal and signal.get("aborted", False):
        raise RuntimeError(cancel_message)

    future = {
        "done": False,
        "resolve": None,
        "reject": None,
    }  # type: dict[str, Any]

    def on_abort() -> None:
        if future["reject"] and not future["done"]:
            future["done"] = True
            future["reject"](RuntimeError(cancel_message))

    if signal:
        signal.add_event_listener("abort", on_abort)

    async def sleep_task() -> None:
        try:
            await asyncio.sleep(ms / 1000)
            if not future["done"]:
                future["done"] = True
                future["resolve"](None)
        except asyncio.CancelledError:
            if not future["done"]:
                future["done"] = True
                future["reject"](RuntimeError(cancel_message))

    await sleep_task()


async def poll_oauth_device_code_flow(options: OAuthDeviceCodePollOptions) -> Any:
    """
    Poll OAuth device code flow with exponential backoff and slow_down handling.
    """
    expires_in = getattr(options, "expiresInSeconds", None)
    deadline = (
        int(__import__("time").time() * 1000) + expires_in * 1000
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

    slow_down_responses = 0

    while True:
        now = int(__import__("time").time() * 1000)
        if now >= deadline:
            break

        if signal and signal.get("aborted", False):
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
            interval_ms = max(MINIMUM_INTERVAL_MS, interval_ms + SLOW_DOWN_INTERVAL_INCREMENT_MS)

        remaining_ms = deadline - int(__import__("time").time() * 1000)
        if remaining_ms <= 0:
            break

        await abortable_sleep(min(interval_ms, int(remaining_ms)), signal, CANCEL_MESSAGE)

    if slow_down_responses > 0:
        raise RuntimeError(SLOW_DOWN_TIMEOUT_MESSAGE)
    raise RuntimeError(TIMEOUT_MESSAGE)
