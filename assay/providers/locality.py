"""Where a model runs: on this computer, or somewhere else."""

from __future__ import annotations


def is_cloud_model_name(model: str | None) -> bool:
    """Ollama's hosted models ("gpt-oss:120b-cloud", "...:cloud") are reached through the local
    Ollama but run on Ollama's servers: the question and answer leave this machine."""
    name = (model or "").lower()
    return name.endswith("-cloud") or name.endswith(":cloud")


LOCAL_HOSTS = {"localhost", "host.docker.internal"}


def is_local_url(url: str) -> bool:
    """True only when the URL's host is this machine (or the Docker host); malformed means no."""
    import ipaddress
    from urllib.parse import urlsplit

    try:
        parts = urlsplit(url.strip())
        host = (parts.hostname or "").lower()
        parts.port  # noqa: B018 - raises on a malformed port
    except ValueError:
        return False
    if parts.scheme not in ("http", "https") or not host:
        return False
    if host in LOCAL_HOSTS:
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def is_local_endpoint(provider: str, model: str | None, base_url: str | None) -> bool:
    """A model that runs on this computer: Ollama (or any server) at a local address."""
    if is_cloud_model_name(model):
        return False
    if not base_url:
        return provider == "ollama"  # Ollama's default address is http://localhost:11434
    return is_local_url(base_url)
