"""Test-only targets."""

import asyncio

CALLS = {"n": 0}


async def run(test_input, options, ctx):
    CALLS["n"] += 1
    await asyncio.sleep(options.get("sleep", 0.05))
    return {"answer": f"echo: {test_input['message']}", "latency_ms": 50}
