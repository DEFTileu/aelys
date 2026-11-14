"""Bounded character status reported by an authenticated companion.

Only fixed mood/reason codes cross the wire: never event text, sensor samples,
notifications or task details. Each row holds current plus one recent reaction.
"""
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

REASON_MOODS: dict[str, frozenset[str]] = {
    'calm': frozenset({'calm'}), 'face_down': frozenset({'sleeping'}), 'night_sleep': frozenset({'sleeping'}),
    'shake': frozenset({'dizzy'}), 'fall': frozenset({'frightened'}), 'turn': frozenset({'curious'}),
    'low_battery': frozenset({'exhausted'}), 'charging': frozenset({'charging'}),
    'touch': frozenset({'attention', 'surprised'}), 'double_touch': frozenset({'tickled'}),
    'stroke': frozenset({'tender'}), 'pokes': frozenset({'irritated'}), 'notification': frozenset({'curious'}),
    'loud': frozenset({'frightened'}), 'task_done': frozenset({'joy'}), 'last_task': frozenset({'elation'}),
    'task_near_deadline': frozenset({'relief'}), 'lift': frozenset({'attention'}),
    'reconnected': frozenset({'reconnected'}), 'wake': frozenset({'waking'}), 'tilt': frozenset({'curious'}),
    'deadline_panic': frozenset({'panic'}), 'deadline_anxiety': frozenset({'anxiety'}), 'overdue': frozenset({'sad'}),
    'flow': frozenset({'flow'}), 'focus': frozenset({'focused'}), 'calendar': frozenset({'anticipation'}),
    'waiting': frozenset({'thinking'}), 'offline': frozenset({'offline'}), 'all_done': frozenset({'elation'}),
    'clear_week': frozenset({'pride'}), 'bored': frozenset({'bored'}), 'missed': frozenset({'missed'}),
    'morning': frozenset({'waking'}), 'evening': frozenset({'sleepy'}), 'idle_attention': frozenset({'attention'}),
    'idle_mischief': frozenset({'mischief'}), 'hold': frozenset({'bashful'}),
    'reschedule': frozenset({'disappointed'}),
}
REACTION_REASONS = frozenset({
    'shake', 'fall', 'turn', 'touch', 'double_touch', 'stroke', 'pokes', 'notification', 'loud',
    'task_done', 'last_task', 'task_near_deadline', 'lift', 'reconnected', 'wake', 'tilt', 'hold', 'reschedule',
})


class CharacterStateIn(BaseModel):
    model_config = ConfigDict(extra='forbid')
    type: Literal['character_state']
    seq: int = Field(strict=True, ge=0, le=4294967295)
    lost_rev: int = Field(strict=True, ge=0, le=4294967295)
    mood: str = Field(max_length=32)
    reason: str = Field(max_length=32)

    @model_validator(mode='after')
    def matching_codes(self) -> 'CharacterStateIn':
        if self.mood not in REASON_MOODS.get(self.reason, ()):
            raise ValueError('unsupported character state')
        return self


class CharacterObservation(BaseModel):
    mood: str
    reason: str
    reported_at: str


class CharacterStatusOut(BaseModel):
    current: CharacterObservation
    recent: CharacterObservation | None = None
