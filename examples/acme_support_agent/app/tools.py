"""The demo agent's tools. Deterministic, except a seeded 'flaky service' on check_warranty."""

from __future__ import annotations

import random
from datetime import date
from typing import Any

from .data import (
    BROKEN_ORDERS,
    BROKEN_SERIALS,
    COMPATIBLE,
    ORDERS,
    PRODUCTS,
    RETURN_POLICY,
    TODAY,
    add_months,
)


class ToolError(Exception):
    def __init__(self, message: str, transient: bool = False):
        super().__init__(message)
        self.transient = transient


def lookup_order(order_id: str) -> dict[str, Any]:
    order_id = str(order_id).strip().lstrip("#")
    if order_id in BROKEN_ORDERS:
        raise ToolError(BROKEN_ORDERS[order_id])
    o = ORDERS.get(order_id)
    if o is None:
        raise ToolError(f"order {order_id} not found")
    return {"order_id": order_id, "product": o["product"], "serial_number": o["serial"],
            "purchase_date": o["purchase_date"], "region": o["region"], "status": o["status"]}


def check_warranty(serial_number: str, rng: random.Random | None = None, flaky_rate: float = 0.0) -> dict[str, Any]:
    serial = str(serial_number).strip().upper()
    if serial in BROKEN_SERIALS:
        raise ToolError(BROKEN_SERIALS[serial])
    if rng is not None and rng.random() < flaky_rate:
        raise ToolError("warranty service timeout", transient=True)
    order = next((o for o in ORDERS.values() if o["serial"] == serial), None)
    if order is None:
        raise ToolError(f"unknown serial number {serial_number}")
    months = PRODUCTS[order["product"]]["warranty_months"] + (12 if order["care_plus"] else 0)
    expires = add_months(date.fromisoformat(order["purchase_date"]), months)
    return {"serial_number": serial, "product": order["product"],
            "warranty_status": "active" if expires >= TODAY else "expired", "expires_on": expires.isoformat(),
            "plan": "care_plus" if order["care_plus"] else "standard"}


def check_compatibility(product_a: str, product_b: str) -> dict[str, Any]:
    a, b = _canonical(product_a), _canonical(product_b)
    if a is None or b is None:
        raise ToolError(f"unknown product: {product_a if a is None else product_b}")
    ok = frozenset({a, b}) in COMPATIBLE
    return {"product_a": a, "product_b": b, "compatible": ok}


def get_return_policy(region: str) -> dict[str, Any]:
    r = next((k for k in RETURN_POLICY if k.lower() == str(region).strip().lower()), None)
    if r is None:
        raise ToolError(f"unknown region {region}")
    return {"region": r, **RETURN_POLICY[r]}


def lookup_shipping_status(order_id: str) -> dict[str, Any]:
    o = lookup_order(order_id)
    full = ORDERS[o["order_id"]]
    return {"order_id": o["order_id"], "status": full["status"], "carrier": full.get("carrier"),
            "eta": full.get("eta")}


def _canonical(name: str) -> str | None:
    n = " ".join(str(name).lower().replace("device ", "").split())
    for p in sorted(PRODUCTS, key=len, reverse=True):
        if n == p.lower() or n == p.lower().replace("device ", ""):
            return p
    return None


TOOL_SPECS = [
    {"name": "lookup_order", "description": "Look up an order by order number.", "parameters": {"order_id": "string"}},
    {"name": "check_warranty", "description": "Warranty status for a device serial number.",
     "parameters": {"serial_number": "string"}},
    {"name": "check_compatibility", "description": "Whether two Acme products work together.",
     "parameters": {"product_a": "string", "product_b": "string"}},
    {"name": "get_return_policy", "description": "Return window for a region.", "parameters": {"region": "string"}},
    {"name": "lookup_shipping_status", "description": "Shipping status of an order.",
     "parameters": {"order_id": "string"}},
]
