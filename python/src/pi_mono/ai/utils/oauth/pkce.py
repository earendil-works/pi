"""PKCE utilities."""

import base64
import hashlib
import secrets


def _base64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


async def generate_pkce() -> dict[str, str]:
    """Generate PKCE code verifier and challenge."""
    verifier = _base64url_encode(secrets.token_bytes(32))
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = _base64url_encode(digest)
    return {"verifier": verifier, "challenge": challenge}
