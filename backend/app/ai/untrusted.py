"""Explicit boundary for retrieved content and prompt-injection resistance."""

from __future__ import annotations

import re
from dataclasses import dataclass
from html import escape

_TOKEN = re.compile(r"(?i)(sk-[A-Za-z0-9_-]{8,}|(?:api[_-]?key|token|secret)\s*[:=]\s*\S+)")


@dataclass(frozen=True)
class UntrustedData:
    source: str
    text: str

    def redacted(self) -> UntrustedData:
        return UntrustedData(self.source, _TOKEN.sub("[REDACTED]", self.text))

    def as_context(self) -> str:
        value = escape(self.redacted().text, quote=False)
        return f"<untrusted_data source='{escape(self.source, quote=True)}'>\n{value}\n</untrusted_data>"
