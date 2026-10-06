"""Where keys live. A stored configuration only ever holds a *reference* to a secret:

* ``env:NAME``     - an environment variable (``.env``, Docker, CI);
* ``keyring:NAME`` - the operating system's credential store (Windows Credential Manager,
  macOS Keychain, Secret Service), entered once in Settings.

Values are resolved at call time, server side, and never logged, returned to the browser or
written to the database. The UI sees a status and the last four characters, nothing more.
"""

from __future__ import annotations

import contextlib
import os
import re
from typing import Any

SERVICE = "gaugelab"
_REF = re.compile(r"^(env|keyring):([A-Za-z_][A-Za-z0-9_]*)$")
_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,99}$")
# Secret names GaugeLab created; the OS store cannot list entries, so we keep the names (never the values).
_INDEX = "__index__"


class SecretError(ValueError):
    pass


def _keyring() -> Any:
    try:
        import keyring
        from keyring.errors import NoKeyringError  # noqa: F401
    except ImportError as exc:  # pragma: no cover - keyring is a dependency
        raise SecretError("The keyring package is not installed; use env:NAME references") from exc
    return keyring


def parse_ref(ref: str) -> tuple[str, str]:
    m = _REF.match(ref or "")
    if not m:
        raise SecretError("A secret reference is env:NAME or keyring:NAME")
    return m.group(1), m.group(2)


def resolve(ref: str | None) -> str | None:
    """The secret's value, or None when it is not set. Never raise for a missing value."""
    if not ref:
        return None
    kind, name = parse_ref(ref)
    if kind == "env":
        return os.environ.get(name) or None
    try:
        return _keyring().get_password(SERVICE, name) or None
    except Exception:
        return None


def keyring_available() -> bool:
    try:
        kr = _keyring()
        backend = kr.get_keyring()
        return "fail" not in type(backend).__module__.lower()
    except Exception:
        return False


def _names() -> list[str]:
    try:
        raw = _keyring().get_password(SERVICE, _INDEX) or ""
    except Exception:
        return []
    return [n for n in raw.split(",") if n]


def _save_names(names: list[str]) -> None:
    _keyring().set_password(SERVICE, _INDEX, ",".join(sorted(set(names))))


def store(name: str, value: str) -> str:
    """Save a secret in the OS credential store and return its reference."""
    if not _NAME.match(name):
        raise SecretError("Name: letters, digits and underscores, starting with a letter")
    if not value or not value.strip():
        raise SecretError("The secret is empty")
    if not keyring_available():
        raise SecretError("No OS credential store is available here. Set the key in .env and use env:NAME.")
    kr = _keyring()
    kr.set_password(SERVICE, name, value.strip())
    _save_names([*_names(), name])
    return f"keyring:{name}"


def delete(name: str) -> None:
    kr = _keyring()
    with contextlib.suppress(Exception):  # already gone is fine
        kr.delete_password(SERVICE, name)
    _save_names([n for n in _names() if n != name])


def hint(value: str | None) -> str | None:
    return f"••••{value[-4:]}" if value and len(value) >= 8 else ("••••" if value else None)


def describe(ref: str | None) -> dict[str, Any]:
    """Public view of a reference: where it lives, whether it is set, the last four characters."""
    if not ref:
        return {"ref": None, "kind": None, "status": None, "hint": None}
    try:
        kind, _ = parse_ref(ref)
    except SecretError:
        return {"ref": ref, "kind": None, "status": "invalid", "hint": None}
    val = resolve(ref)
    return {"ref": ref, "kind": kind, "status": "set" if val else "missing", "hint": hint(val)}


def list_stored() -> list[dict[str, Any]]:
    return [{"name": n, **describe(f"keyring:{n}")} for n in sorted(_names())]
