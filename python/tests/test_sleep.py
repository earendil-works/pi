import asyncio
import time
from pi_mono.utils.sleep import sleep


def test_sleep():
    start = time.time()
    asyncio.run(sleep(50))
    duration = (time.time() - start) * 1000
    # The sleep duration should be close to 50ms, allowing a small buffer
    assert duration >= 40
