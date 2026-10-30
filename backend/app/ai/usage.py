from __future__ import annotations

from decimal import Decimal
from uuid import UUID

from .models import ModelSpec, ProviderKind, Usage, UsageRecord


class UsageTracker:
    def __init__(self):
        self._records: list[UsageRecord] = []
        self._seen: set[UUID] = set()

    def record(self, run_id: UUID, provider: ProviderKind, model: ModelSpec, usage: Usage) -> UsageRecord:
        if run_id in self._seen:
            return next(record for record in self._records if record.run_id == run_id)
        cost = (Decimal(usage.input_tokens) / 1000 * model.input_cost_per_1k) + (Decimal(usage.output_tokens) / 1000 * model.output_cost_per_1k)
        record = UsageRecord(run_id, provider, model.model, usage, cost)
        self._seen.add(run_id)
        self._records.append(record)
        return record

    def total(self) -> Decimal:
        return sum((r.estimated_cost for r in self._records), Decimal(0))

    def records(self) -> tuple[UsageRecord, ...]:
        return tuple(self._records)
