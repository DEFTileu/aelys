"""Capability, privacy, and budget aware deterministic model selection."""

from __future__ import annotations

from collections.abc import Iterable
from decimal import Decimal

from .errors import BudgetExceeded, ModelUnavailable
from .models import (
    Capability,
    ModelSpec,
    PrivacyClass,
    RoutingDecision,
    RoutingRequest,
    TaskKind,
)


class ModelRouter:
    def __init__(self, models: Iterable[ModelSpec], *, monthly_remaining: Decimal = Decimal("100.00")):
        self._models = tuple(models)
        self.monthly_remaining = monthly_remaining

    @staticmethod
    def _estimate(model: ModelSpec, tokens: int) -> Decimal:
        return (Decimal(tokens) / Decimal(1000)) * (model.input_cost_per_1k + model.output_cost_per_1k) / Decimal(2)

    def choose(self, request: RoutingRequest) -> RoutingDecision:
        candidates = [m for m in self._models if m.enabled and request.privacy in m.privacy_classes and request.required_capabilities <= m.capabilities and m.context_tokens >= request.context_tokens]
        if request.manual_model or request.manual_provider:
            candidates = [m for m in candidates if (not request.manual_model or m.model == request.manual_model) and (not request.manual_provider or m.provider == request.manual_provider)]
        if not candidates:
            if request.privacy == PrivacyClass.LOCAL_ONLY:
                raise ModelUnavailable("no provider is permitted for local-only data")
            raise ModelUnavailable("no model meets the requested capabilities and privacy policy")
        candidates.sort(key=lambda m: (0 if m.model == request.favorite_model else 1, self._task_rank(request.task_kind, m), m.input_cost_per_1k + m.output_cost_per_1k, m.provider.value, m.model))
        for model in candidates:
            estimate = self._estimate(model, max(request.context_tokens, 1000))
            if estimate <= request.request_budget and estimate <= self.monthly_remaining:
                reason = ["manual_override"] if request.manual_model or request.manual_provider else ["deterministic_capability_match"]
                if request.privacy in (PrivacyClass.SENSITIVE, PrivacyClass.LOCAL_ONLY):
                    reason.append("privacy_filtered")
                return RoutingDecision(model.provider, model.model, tuple(reason), estimate)
        raise BudgetExceeded("no eligible model fits the request or monthly budget")

    @staticmethod
    def _task_rank(task: TaskKind, model: ModelSpec) -> int:
        if task in (TaskKind.CLASSIFICATION, TaskKind.SUMMARY):
            return 0 if Capability.REASONING not in model.capabilities else 1
        if task == TaskKind.REASONING:
            return 0 if Capability.REASONING in model.capabilities else 10
        if task == TaskKind.TOOL_ACTION:
            return 0 if Capability.TOOL_CALLING in model.capabilities else 10
        return 0
