"""Test-only targets."""

import asyncio

CALLS = {"n": 0}


async def run(test_input, options, ctx):
    CALLS["n"] += 1
    await asyncio.sleep(options.get("sleep", 0.05))
    return {"answer": f"echo: {test_input['message']}", "latency_ms": 50}


async def busy(test_input, options, ctx):
    """Every third question (by its text) is refused as rate-limited, as a busy provider would."""
    await asyncio.sleep(0.01)
    if sum(map(ord, test_input["message"])) % 3 == 0:
        raise RuntimeError("HTTP 429: Too Many Requests (rate limit)")
    return {"answer": f"echo: {test_input['message']}", "latency_ms": 10}
