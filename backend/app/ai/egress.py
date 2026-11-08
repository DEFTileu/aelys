"""Deterministic, local inspection of content before disclosure to an LLM.

A match rejects the entire request. This is deliberately conservative; it is
not a semantic classifier and cannot recognize every kind of private prose.
Never include matched values, field names or excerpts in errors or telemetry.
"""
from __future__ import annotations

import json
import re
import unicodedata
from collections.abc import Mapping
from dataclasses import asdict
from typing import Any

from .errors import AIError
from .models import ProviderRequest


class SensitiveDataBlocked(AIError):
    code = "SENSITIVE_DATA_BLOCKED"

    def __init__(self) -> None:
        super().__init__("Запрос не отправлен в LLM: обнаружены чувствительные данные. Удалите их и начните новый чат, если они остались в истории.")


_PATTERNS = tuple(re.compile(pattern, re.IGNORECASE) for pattern in (
    r"\bsk-[\w-]{8,}",
    r"\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|xox[baprs]-[\w-]{10,})",
    r"\b\d{6,12}:[A-Za-z0-9_-]{30,}\b",
    r"-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----",
    r"\bbearer\s+[A-Za-z0-9._~+/-]+",
    r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+",
    # Also recognizes JSON keys, quoted values, and Russian labels.
    r'''["']?(?:api[_ -]?key|(?:access[_ -]?|refresh[_ -]?|auth[_ -]?)?token|secret|password|passwd|pwd|пароль|токен|секрет)["']?\s*[:=]\s*["']?[^\s"',}\]]+''',
    r"\b[a-z][a-z0-9+.-]*://[^\s/:]+:[^\s/@]+@",
    r"\b[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+\b",
    r"\+\d[\d ()-]{8,}\d\b",
    r"(?:\b(?:phone|mobile|telephone|телефон)\b)\s*[:=]\s*[\d+][\d ()-]{6,}\d",
    r"(?:\b(?:iin|ssn|passport|иин|паспорт)\b)\s*[:=]\s*[A-ZА-Я0-9][A-ZА-Я0-9 -]{4,}",
    # Retrieval already redacts some raw secrets. Do not silently send the
    # remainder of that request under the owner's whole-request block policy.
    r"\[REDACTED\]",
))
_IBAN = re.compile(r"\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}\b")
_CARD = re.compile(r"(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)")


def _contains_sensitive(text: str, known_secrets: tuple[str, ...]) -> bool:
    normalized = unicodedata.normalize("NFKC", text)
    normalized = "".join(char for char in normalized if unicodedata.category(char) != "Cf")
    if any(secret and secret in text for secret in known_secrets):
        return True
    if any(pattern.search(normalized) for pattern in _PATTERNS):
        return True
    for match in _IBAN.finditer(normalized.upper()):
        iban = match.group().replace(" ", "")
        rotated = iban[4:] + iban[:4]
        number = "".join(str(ord(char) - 55) if char.isalpha() else char for char in rotated)
        if int(number) % 97 == 1:
            return True
    for match in _CARD.finditer(normalized):
        digits = [int(char) for char in match.group() if char.isascii() and char.isdigit()]
        if not 13 <= len(digits) <= 19 or len(set(digits)) < 2:
            continue
        # Luhn validation avoids classifying arbitrary IDs as payment cards.
        checksum = sum((digit * 2 - 9 if digit > 4 else digit * 2) if index % 2 else digit
                       for index, digit in enumerate(reversed(digits)))
        if checksum % 10 == 0:
            return True
    return False


def ensure_safe_payload(value: Any, *, known_secrets: tuple[str, ...] = ()) -> None:
    """Inspect nested JSON values and encoded JSON tool arguments, without I/O."""
    if isinstance(value, str):
        if _contains_sensitive(value, known_secrets):
            raise SensitiveDataBlocked()
        # Tool arguments may contain JSON unicode escapes hiding a token.
        try:
            decoded = json.loads(value)
        except (ValueError, RecursionError):
            return
        if decoded != value:
            ensure_safe_payload(decoded, known_secrets=known_secrets)
    elif isinstance(value, Mapping):
        for key, item in value.items():
            # JSON Schema property names describe possible user data. A field
            # named "secret" is not itself a credential (its supplied value is
            # still recursively inspected below).
            if key != "secret":
                ensure_safe_payload(str(key), known_secrets=known_secrets)
            # Scanning the key/value pair also recognizes structured secrets
            # whose value has no vendor-specific prefix.
            if isinstance(item, (str, int, float)) and _contains_sensitive(f"{key}={item}", known_secrets):
                raise SensitiveDataBlocked()
            # Preserve the label across nested objects and arrays: the
            # payload may represent a credential as {password: {value: ...}}.
            if (isinstance(key, str)
                    and re.fullmatch(r"(?:api[_ -]?key|(?:access[_ -]?|refresh[_ -]?|auth[_ -]?)?token|secret|password|passwd|pwd|пароль|токен|секрет)", key, re.IGNORECASE)
                    and item not in (None, "", [], {})
                    and not (isinstance(item, Mapping) and item.get("type") in {"boolean", "string", "integer", "number", "object", "array"})):
                raise SensitiveDataBlocked()
            ensure_safe_payload(item, known_secrets=known_secrets)
    elif isinstance(value, (list, tuple)):
        for item in value:
            ensure_safe_payload(item, known_secrets=known_secrets)


def ensure_safe_request(request: ProviderRequest) -> None:
    ensure_safe_payload(asdict(request))
