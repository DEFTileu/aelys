"""IELTS course plan and the deterministic adaptation rules (no I/O, no AI)."""
from __future__ import annotations

import math
import re
from datetime import date
from typing import Any

# (display theme, English topic for the prompt, grammar focus)
PLAN = (
    ("Диагностика и базовые связки", "daily life, routines and personal background (diagnostic)", "Present tenses"),
    ("Education & learning", "education and learning", "Артикли"),
    ("Work & careers", "work and careers", "Предлоги"),
    ("Technology & society", "technology and society", "Conditionals"),
    ("Health & lifestyle", "health and lifestyle", "Linking words"),
    ("Environment", "the environment", "Passive voice"),
    ("Cities & transport", "cities and transport", "Comparatives"),
    ("Media & culture", "media and culture", "Relative clauses"),
    ("Финиш I", "mixed IELTS topics, focus on the learner's weak spots", "Weak spots review"),
    ("Финиш II", "mixed IELTS topics, light revision", "Light revision"),
)
HOURS_TARGET = 150
SKILLS = ("listening", "reading", "writing", "speaking")
BLOCKS = (("warmup", "Разминка"), ("vocab", "Новые слова"), ("grammar", "Грамматика"), ("reading", "Чтение"), ("listening", "Аудирование"), ("speaking", "Говорение"), ("writing", "Письмо"))
BLOCK_KEYS = tuple(k for k, _ in BLOCKS)
OFFLINE_KEYS = ("warmup", "grammar", "reading")  # hand-written blocks that work without an AI provider
MINUTES = {60: (5, 8, 10, 10, 10, 10, 7), 120: (10, 15, 20, 20, 20, 20, 15), 180: (15, 25, 25, 30, 30, 30, 25)}
VOCAB_COUNT = {60: 6, 120: 8, 180: 10}
ERROR_RU = {"tense": "Времена", "article": "Артикли", "preposition": "Предлоги", "collocation": "Словосочетания", "word_choice": "Выбор слова", "word_order": "Порядок слов", "spelling": "Орфография", "grammar": "Грамматика", "punctuation": "Пунктуация"}
LISTENING_SLOW = 70  # % below which the next listening is slower
PAUSES_MANY = 4


def week_of(started: date | None, day: date) -> int:
    return 1 if started is None else min(max((day - started).days // 7 + 1, 1), len(PLAN))


def week_range(started: date | None, week: int, day: date) -> tuple[date, date]:
    start = day if started is None else date.fromordinal(started.toordinal() + (week - 1) * 7)
    return start, date.fromordinal(start.toordinal() + 6)


def mock_due(day: date, week: int, first: date, last: date, mock_days: list[date]) -> bool:
    """Sunday of week 3 or later, and no mock yet in this course week."""
    return day.weekday() == 6 and week >= 3 and not any(first <= d <= last for d in mock_days)


def block_plan(minutes_per_day: int, offline: bool = False) -> list[dict[str, Any]]:
    """Without AI only the hand-written blocks remain; they share the day's minutes."""
    rows = list(zip(BLOCKS, MINUTES.get(minutes_per_day, MINUTES[120]), strict=True))
    if offline:
        rows = [(block, m) for block, m in rows if block[0] in OFFLINE_KEYS]
        total = sum(m for _, m in rows)
        rows = [(block, round(minutes_per_day * m / total)) for block, m in rows]
    return [{"key": k, "title": t, "minutes": m} for (k, t), m in rows]


def mark_block(lesson: Any, key: str, minutes: int | None = None, **extra: Any) -> None:
    """Set progress[key].done (reassigned so the JSON column change is detected)."""
    planned = next((b["minutes"] for b in lesson.content_json.get("blocks", []) if b["key"] == key), 0)
    progress = dict(lesson.progress_json or {})
    entry = {**progress.get(key, {}), **extra, "done": True}
    entry["minutes"] = minutes if minutes is not None else entry.get("minutes", planned)
    progress[key] = entry
    lesson.progress_json, lesson.version = progress, lesson.version + 1


def tokens(text: str) -> list[str]:
    return re.findall(r"[a-z0-9']+", text.lower().replace("’", "'"))


def occurs(answer: str, script: str) -> bool:
    """True when the answer's words appear contiguously in the script."""
    needle = tokens(answer)
    return bool(needle) and f" {' '.join(needle)} " in f" {' '.join(tokens(script))} "


def blank(example: str, lemma: str) -> tuple[str, str, str] | None:
    """Split the example around the lemma (whole word, any case); None when the lemma is not in it."""
    found = re.search(rf"(?<![A-Za-z]){re.escape(lemma)}(?![A-Za-z])", example, re.IGNORECASE)
    return None if found is None else (example[: found.start()], found.group(), example[found.end():])


def _num(band: str) -> float:
    return float(band.removeprefix("≈"))


def _half(value: float) -> str:
    return f"{math.floor(value * 2 + 0.5) / 2:.1f}"  # half up, not banker's rounding


def _avg(values: list[float]) -> float | None:
    return sum(values) / len(values) if values else None


def listening_pct(progresses: list[dict]) -> float | None:
    return _avg([p["listening"]["pct"] for p in progresses if isinstance((p.get("listening") or {}).get("pct"), (int, float))])


def pct_band(pct: float) -> str:
    return next((band for floor, band in ((90, "7.0"), (80, "6.5"), (70, "6.0"), (60, "5.5"), (50, "5.0")) if pct >= floor), "4.5")


def speaking_rounds(progresses: list[dict], limit: int = 5) -> list[dict]:
    """Latest rounds first: newest lesson first, shortest (last played) round first."""
    rounds = [r for p in progresses for _, r in sorted(((p.get("speaking") or {}).get("rounds") or {}).items(), key=lambda kv: int(kv[0]))]
    return rounds[:limit]


def skill_bands(mocks: list[Any], progresses: list[dict], reports: list[dict]) -> list[dict[str, Any]]:
    """mocks/progresses/reports are newest first. A mock band wins (plain "6.5"); otherwise the lesson/report average of the last 5.

    Listening from the quiz percent is plain ("6.5"); speaking and writing come from AI estimates and carry "≈" ("≈6.5")."""
    rounds = speaking_rounds(progresses)
    speaking = _avg([_num(v) for r in rounds for v in (r.get("criteria") or {}).values()])
    graded = [r["criteria"] for r in reports if r.get("criteria")][:5]
    writing = _avg([_num(v) for c in graded for v in c.values()])
    pct = listening_pct(progresses[:5])
    derived = {"listening": None if pct is None else pct_band(pct), "writing": None if writing is None else "≈" + _half(writing), "speaking": None if speaking is None else "≈" + _half(speaking), "reading": None}
    out = []
    for skill in SKILLS:
        marked = [getattr(m, skill) for m in mocks if getattr(m, skill)]
        trend = None
        if len(marked) > 1:
            diff = _num(marked[0]) - _num(marked[1])
            trend = f"{diff:+.1f}" if diff else "0"
        out.append({"skill": skill, "band": marked[0] if marked else derived[skill], "trend": trend})
    return out


def recurring_error(reports: list[dict]) -> tuple[str, int] | None:
    """Error type present in the most recent consecutive reports, at least 3 in a row."""
    best: tuple[str, int] | None = None
    for kind in ERROR_RU:
        streak = 0
        for r in reports:
            if not any(isinstance(e, dict) and e.get("type") == kind for e in (r or {}).get("errors", [])):
                break
            streak += 1
        if streak >= 3 and (best is None or streak > best[1]):
            best = (kind, streak)
    return best


def lessons_ru(n: int) -> str:
    return f"{n} " + ("урока" if n % 10 in (2, 3, 4) and n // 10 != 1 else "уроков" if n != 1 else "урок")


def on_target(bands: list[dict], target: str) -> list[str]:
    return [b["skill"] for b in bands if b["band"] and _num(b["band"]) >= _num(target)]


def adaptations(progresses: list[dict], reports: list[dict], bands: list[dict], target: str) -> list[dict[str, str]]:
    out = []
    pct = listening_pct(progresses[:5])
    if pct is not None and pct < LISTENING_SLOW:
        out.append({"skill": "listening", "icon": "gauge", "title": "Listening:", "detail": f"верно {pct:.0f}% — озвучка 0.9× и больше упражнений на слитную речь."})
    pauses = _avg([float(r["pauses"]) for r in speaking_rounds(progresses) if isinstance(r.get("pauses"), int)])
    if pauses is not None and pauses >= PAUSES_MANY:
        out.append({"skill": "speaking", "icon": "mic", "title": "Speaking:", "detail": f"в среднем {pauses:.0f} пауз за раунд — монолог 4/3/2 каждый день и больше связок для пауз."})
    if (error := recurring_error(reports)) is not None:
        out.append({"skill": "writing", "icon": "triangle-alert", "title": f"{ERROR_RU[error[0]]} — {lessons_ru(error[1])} подряд:", "detail": "добавлено мини-упражнение в разминку."})
    for skill in on_target(bands, target):
        out.append({"skill": skill, "icon": "trending-up", "title": f"{skill.capitalize()} на цели:", "detail": "уже не ниже целевого балла — на этот навык уйдёт меньше времени."})
    return out
