"""Safe, stable AI errors.  Details never contain provider credentials or bodies."""

from __future__ import annotations

import re


class AIError(Exception):
    code = "AI_ERROR"


class ProviderError(AIError):
    code = "PROVIDER_ERROR"


class ModelUnavailable(AIError):
    code = "MODEL_UNAVAILABLE"


class BudgetExceeded(AIError):
    code = "BUDGET_EXCEEDED"


class PolicyDenied(AIError):
    code = "POLICY_DENIED"


class ToolValidationError(AIError):
    code = "VALIDATION_ERROR"


class RunCancelled(AIError):
    code = "CANCELLED"


_SECRET = re.compile(r"(?i)(?:sk-[A-Za-z0-9_-]{8,}|bearer\s+[A-Za-z0-9._~-]+|api[_-]?key\s*[:=]\s*\S+)")


def redact_error(value: object) -> str:
    """Return a short error safe for API responses and audit metadata."""

    text = str(value).replace("\n", " ")
    text = _SECRET.sub("[REDACTED]", text)
    return text[:500]
