"""Fictional business data for the Acme demo. 'Today' is fixed so warranty states never drift."""

from __future__ import annotations

from datetime import date

TODAY = date(2026, 1, 15)

PRODUCTS = {
    "Device Alpha": {"model": "A100", "warranty_months": 24, "kind": "device"},
    "Device Alpha Classic": {"model": "A050", "warranty_months": 12, "kind": "device"},
    "Device Beta": {"model": "B200", "warranty_months": 12, "kind": "device"},
    "Device Beta Pro": {"model": "B250", "warranty_months": 24, "kind": "device"},
    "Device Gamma": {"model": "G300", "warranty_months": 24, "kind": "device"},
    "Adapter C": {"model": "AC65", "warranty_months": 12, "kind": "accessory"},
    "Adapter D": {"model": "AD18", "warranty_months": 12, "kind": "accessory"},
    "Mount Kit M1": {"model": "M1", "warranty_months": 12, "kind": "accessory"},
}

ORDERS = {
    "18372": {"product": "Device Alpha", "serial": "ACME-A-00123", "purchase_date": "2025-03-10",
              "region": "Northvale", "status": "delivered", "care_plus": False},
    "18373": {"product": "Device Beta", "serial": "ACME-B-00456", "purchase_date": "2024-05-02",
              "region": "Southmark", "status": "delivered", "care_plus": False},
    "18374": {"product": "Device Gamma", "serial": "ACME-G-00789", "purchase_date": "2025-08-20",
              "region": "Northvale", "status": "delivered", "care_plus": True},
    "18375": {"product": "Adapter C", "serial": None, "purchase_date": "2025-11-02",
              "region": "Eastport", "status": "delivered", "care_plus": False},
    "18376": {"product": "Device Alpha", "serial": "ACME-A-00999", "purchase_date": "2023-01-15",
              "region": "Northvale", "status": "delivered", "care_plus": False},
    "18377": {"product": "Device Beta Pro", "serial": "ACME-P-00321", "purchase_date": "2026-01-12",
              "region": "Eastport", "status": "in_transit", "care_plus": False,
              "carrier": "Parcelo", "eta": "2026-01-17"},
    "18378": {"product": "Device Gamma", "serial": "ACME-G-00555", "purchase_date": "2026-01-14",
              "region": "Southmark", "status": "processing", "care_plus": False},
}

# Order ids / serials whose back-end always fails: the error-recovery cases.
BROKEN_ORDERS = {"99999": "order service timeout"}
BROKEN_SERIALS = {"ACME-E-00000": "warranty service unavailable"}

RETURN_POLICY = {
    "Northvale": {"window_days": 30, "restocking_fee": "10% on opened Device Gamma only"},
    "Southmark": {"window_days": 14, "restocking_fee": "10% on opened Device Gamma only"},
    "Eastport": {"window_days": 45, "restocking_fee": "10% on opened Device Gamma only"},
}

COMPATIBLE = {
    frozenset({"Adapter C", "Device Alpha"}), frozenset({"Adapter C", "Device Beta"}),
    frozenset({"Adapter C", "Device Gamma"}), frozenset({"Adapter C", "Device Beta Pro"}),
    frozenset({"Adapter D", "Device Alpha Classic"}), frozenset({"Mount Kit M1", "Device Gamma"}),
    frozenset({"Device Alpha", "Device Gamma"}), frozenset({"Device Alpha", "Device Beta"}),
}


def add_months(d: date, months: int) -> date:
    y, mth = divmod(d.month - 1 + months, 12)
    return date(d.year + y, mth + 1, min(d.day, 28 if mth + 1 == 2 else 30 if mth + 1 in (4, 6, 9, 11) else 31))
