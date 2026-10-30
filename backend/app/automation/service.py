"""Compatibility exports for the rule engine.

The implementation lives in :mod:`automation.engine`; this module intentionally
does not expose an action callback that bypasses policy authorization.
"""

from .engine import AutomationEngine
from .models import (
    Action,
    AutomationEvent,
    AutomationExecution,
    AutomationRule,
    Condition,
)

__all__ = ["Action", "AutomationEngine", "AutomationEvent", "AutomationExecution", "AutomationRule", "Condition"]
