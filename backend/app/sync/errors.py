"""Typed errors exposed by the sync service and router."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping

from .models import SyncErrorCode


@dataclass
class SyncException(Exception):
    code: SyncErrorCode
    message: str
    details: Mapping[str, Any] = field(default_factory=dict)
    status_code: int = 400

    def __post_init__(self) -> None:
        super().__init__(self.message)


class SyncResetRequired(SyncException):
    def __init__(self, compaction_watermark: int):
        super().__init__(
            SyncErrorCode.SYNC_RESET_REQUIRED,
            "The sync cursor is too old; bootstrap is required",
            {"compaction_watermark": compaction_watermark},
            409,
        )
