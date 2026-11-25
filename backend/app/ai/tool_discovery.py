"""Select the tool schemas the provider sees during one authorized turn."""

from collections.abc import Mapping
from typing import Any

from .errors import PolicyDenied
from .models import PermissionContext, ToolCall
from .tools import ToolRegistry

LOAD_TOOLS = "load_tools"
_MIN_CATALOGUE = 8
_MAX_BATCH = 4
_DEFERRED_PURPOSES = {
    "update_task": "edit or start an existing task",
    "complete_task": "mark an existing task complete",
    "create_event": "schedule a calendar event",
    "create_reminder": "set a reminder for a task",
    "search_knowledge": "find relevant documents in the knowledge base",
    "read_chat_history": "check earlier personal Telegram messages",
}


class ToolDiscovery:
    """Expose basic tools first and attach selected schemas for later completions."""

    def __init__(self, registry: ToolRegistry, context: PermissionContext):
        self._registry = registry
        self._context = context
        allowed = []
        for schema in registry.schemas():
            try:
                registry.authorize(ToolCall(schema["name"], {}, LOAD_TOOLS), context)
            except PolicyDenied:
                continue
            allowed.append(schema)
        self._allowed = tuple(allowed)
        self.deferred = frozenset(
            schema["name"] for schema in self._allowed if schema["name"] in _DEFERRED_PURPOSES
        ) if len(self._allowed) >= _MIN_CATALOGUE else frozenset()
        self._loaded: set[str] = set()

    def schemas(self) -> tuple[dict[str, Any], ...]:
        visible = tuple(schema for schema in self._allowed if schema["name"] not in self.deferred)
        if not self.deferred:
            return visible
        names = sorted(self.deferred)
        purposes = "; ".join(f"{name}: {_DEFERRED_PURPOSES[name]}" for name in names)
        loader = {
            "name": LOAD_TOOLS,
            "description": (
                "Load tool schemas for the next step. This only reveals the interface and performs no action. "
                "Call this before using a tool listed here. Batch the tools you need: " + purposes
            ),
            "input_schema": {
                "type": "object",
                "additionalProperties": False,
                "properties": {"names": {
                    "type": "array", "minItems": 1, "maxItems": _MAX_BATCH,
                    "items": {"type": "string", "enum": names},
                }},
                "required": ["names"],
            },
        }
        return (*visible, loader, *(schema for schema in self._allowed if schema["name"] in self._loaded))

    def load(self, call: ToolCall) -> Mapping[str, Any]:
        names = call.arguments.get("names")
        if not self.deferred:
            return {"error": "TOOL_UNAVAILABLE"}
        if set(call.arguments) != {"names"} or not isinstance(names, list) or not 1 <= len(names) <= _MAX_BATCH:
            return {"error": "INVALID_TOOL_SELECTION", "message": "Provide one to four tool names in names."}
        if any(not isinstance(name, str) or name not in self.deferred for name in names):
            return {"error": "TOOL_UNAVAILABLE", "message": "Choose tool names from the load_tools schema."}

        chosen = sorted(set(names))
        try:
            for name in chosen:
                self._registry.authorize(ToolCall(name, {}, call.call_id), self._context)
        except PolicyDenied:
            return {"error": "TOOL_UNAVAILABLE"}
        self._loaded.update(chosen)
        return {"loaded": chosen, "message": "The selected tools are available on the next step."}
