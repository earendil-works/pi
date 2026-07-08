import asyncio


async def sleep(ms: float) -> None:
    """Pause execution for the specified number of milliseconds."""
    await asyncio.sleep(ms / 1000.0)
