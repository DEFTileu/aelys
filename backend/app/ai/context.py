"""Fit provider-bound text after routing, egress inspection and data fencing."""
from __future__ import annotations

import json
from dataclasses import replace

from .errors import ModelUnavailable
from .models import ChatMessage, ContextSource, ProviderRequest


def _text_units(text: str) -> int:
    # Approximate mixed-language tokens without a vendor tokenizer.
    # Non-ASCII bytes receive more space than ordinary ASCII prose.
    size = len(text.encode())
    return (size + 2 * (size - len(text)) + 3) // 4


def _json_units(value: object) -> int:
    return _text_units(json.dumps(value, ensure_ascii=False, separators=(",", ":")))


def _message_units(message: ChatMessage) -> int:
    size = 16 + _text_units(message.content) + len((message.tool_call_id or "").encode())
    for call in message.tool_calls:
        size += _json_units([call.call_id, call.name, call.arguments])
    return size


def fit_context(request: ProviderRequest, window: int) -> ProviderRequest:
    """Keep current input, evidence and live tool exchanges intact.

    Drop oldest complete historical turns until the remaining suffix fits.
    Provenance comes from DB selection. Message text cannot opt into eviction.
    """
    remaining = window - (request.output_limit or request.max_tokens) - _json_units(request.tools) - 32
    groups: list[list[int]] = []
    historical: set[int] = set()
    for index, message in enumerate(request.messages):
        if message.source is ContextSource.HISTORY:
            if not groups or message.role == "user":
                groups.append([])
            groups[-1].append(index)
            historical.add(index)
        else:
            remaining -= _message_units(message)
    if remaining < 0:
        raise ModelUnavailable("Required context exceeds the selected model window")
    selected: set[int] = set()
    for group in reversed(groups):
        size = sum(_message_units(request.messages[i]) for i in group)
        if size > remaining:
            break
        selected.update(group)
        remaining -= size
    if selected == historical:
        return request
    return replace(request, messages=tuple(message for i, message in enumerate(request.messages)
                                           if i not in historical or i in selected))
