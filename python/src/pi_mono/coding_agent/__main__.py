"""Entry point: python -m pi_mono.coding_agent"""

from __future__ import annotations

import asyncio

from pi_mono.coding_agent.main import main


def run() -> None:
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        raise SystemExit(130) from None


if __name__ == "__main__":
    run()
