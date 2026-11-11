"""Hand-written course material: grammar lessons and IELTS-style reading passages, loaded once from content/*.json.

The files are validated at import, so a broken edit fails the test suite and app start instead of a learner's lesson.
"""
from __future__ import annotations

import json
from collections.abc import Sequence
from datetime import date
from functools import cache
from pathlib import Path
from typing import Annotated, Any, Literal

from app.english.plan import PLAN, tokens
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

DIR = Path(__file__).parent / "content"
Text = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2000)]
TFNG = ["TRUE", "FALSE", "NOT GIVEN"]
REMEDIAL_TYPES = ("tense", "article", "preposition", "word_order", "collocation", "word_choice", "punctuation")


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class Example(Strict):
    en: Text
    ru: Text


Short = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]
Tone = Literal["blue", "orange", "purple", "green"]


class Token(Strict):
    """One chip of a formula; `role` picks its colour (subject neutral, verb tinted, aux/ending solid)."""
    t: Short
    role: Literal["subject", "verb", "aux", "ending", "word"]


class Formula(Strict):
    title: Short
    when_ru: Short
    tone: Tone
    rows: list[list[Token]] = Field(min_length=1, max_length=4)
    example_en: Text
    example_ru: Text
    markers: list[Short] = Field(default_factory=list, max_length=8)


class TimelineItem(Strict):
    """On an axis from -1 (past) through 0 (now) to 1 (future): repeat = dots everywhere, point = one dot at `at`, span = a band from..to."""
    label: Short
    kind: Literal["repeat", "point", "span"]
    at: float | None = Field(default=None, ge=-1, le=1)
    start: float | None = Field(default=None, ge=-1, le=1)
    end: float | None = Field(default=None, ge=-1, le=1)
    caption_en: Short

    @model_validator(mode="after")
    def _shape(self) -> TimelineItem:
        if self.kind == "point" and self.at is None:
            raise ValueError(f"point needs at: {self.label}")
        if self.kind == "span" and (self.start is None or self.end is None or self.start >= self.end):
            raise ValueError(f"span needs start < end: {self.label}")
        return self


class Timeline(Strict):
    title_ru: Short
    items: list[TimelineItem] = Field(min_length=1, max_length=3)


class Table(Strict):
    title_ru: Short
    head: list[Short] = Field(min_length=2, max_length=4)
    rows: list[list[Short]] = Field(min_length=2, max_length=8)

    @model_validator(mode="after")
    def _shape(self) -> Table:
        if any(len(r) != len(self.head) for r in self.rows):
            raise ValueError(f"table rows must match head: {self.title_ru}")
        return self


class Trap(Strict):
    wrong: Text
    right: Text
    note_ru: Text


class Chip(Strict):
    en: Short
    example: Text
    ru: Short


class Chips(Strict):
    title_ru: Short
    items: list[Chip] = Field(min_length=3, max_length=10)


class Exercise(Strict):
    type: Literal["gap", "choice", "fix"]
    prompt: Text  # gap: contains "___"; fix: a wrong sentence to rewrite; choice: a sentence with "___" and options
    options: list[Text] | None = None
    answers: list[Text] = Field(min_length=1, max_length=6)
    explain_ru: Text
    skill: Short | None = None  # Russian sub-topic label; the result screen groups the score by it

    @model_validator(mode="after")
    def _shape(self) -> Exercise:
        if self.type == "choice" and (not self.options or len(self.options) < 2 or self.answers[0] not in self.options):
            raise ValueError(f"choice needs options containing the answer: {self.prompt}")
        if self.type != "choice" and self.options:
            raise ValueError(f"only choice has options: {self.prompt}")
        if self.type in ("gap", "choice") and "___" not in self.prompt:
            raise ValueError(f"gap/choice prompt needs ___: {self.prompt}")
        return self


class GrammarLesson(Strict):
    id: Annotated[str, StringConstraints(pattern=r"^[a-z0-9-]{2,40}$")]
    title: Text
    rule_ru: list[Text] = Field(min_length=2, max_length=8)
    examples: list[Example] = Field(min_length=3, max_length=8)
    exercises: list[Exercise] = Field(min_length=8, max_length=12)
    # Visual parts of the explanation; optional so lessons stay valid while they are being written.
    formulas: list[Formula] = Field(default_factory=list, max_length=3)
    timeline: Timeline | None = None
    table: Table | None = None
    traps: list[Trap] = Field(default_factory=list, max_length=4)
    chips: Chips | None = None

    @property
    def visual(self) -> bool:
        return bool(self.formulas and self.traps and (self.timeline or self.table) and all(e.skill for e in self.exercises))


class Paragraph(Strict):
    label: Annotated[str, StringConstraints(pattern=r"^[A-H]$")]
    text: Text


class Question(Strict):
    type: Literal["tfng", "mcq", "heading", "gap"]
    prompt: Text
    options: list[Text] | None = None
    answers: list[Text] = Field(min_length=1, max_length=6)
    explain_ru: Text
    evidence: Text | None = None  # exact words of the passage that prove the answer; null for a question about the figure
    about_figure: bool = False

    @model_validator(mode="after")
    def _shape(self) -> Question:
        if self.type == "tfng" and (self.options is not None or self.answers[0] not in TFNG or len(self.answers) != 1):
            raise ValueError(f"tfng answers one of {TFNG} without options: {self.prompt}")
        if self.type in ("mcq", "heading") and (not self.options or self.answers[0] not in self.options or len(self.answers) != 1):
            raise ValueError(f"{self.type} needs options containing the single answer: {self.prompt}")
        if self.type == "gap" and (self.options or "___" not in self.prompt or any(len(tokens(a)) > 3 for a in self.answers)):
            raise ValueError(f"gap needs ___ and answers of at most three words: {self.prompt}")
        return self


class Series(Strict):
    name: Short
    values: list[float] = Field(min_length=2, max_length=12)


class Figure(Strict):
    kind: Literal["bar", "line"]
    title: Text
    unit: Short
    labels: list[Short] = Field(min_length=2, max_length=12)
    series: list[Series] = Field(min_length=1, max_length=3)

    @model_validator(mode="after")
    def _shape(self) -> Figure:
        if any(len(s.values) != len(self.labels) for s in self.series):
            raise ValueError(f"every series needs one value per label: {self.title}")
        return self


class Gloss(Strict):
    word: Short
    ru: Short


class Passage(Strict):
    id: Annotated[str, StringConstraints(pattern=r"^[a-z0-9-]{2,40}$")]
    title: Text
    paragraphs: list[Paragraph] = Field(min_length=3, max_length=8)
    questions: list[Question] = Field(min_length=6, max_length=10)
    figure: Figure | None = None
    glossary: list[Gloss] = Field(default_factory=list, max_length=12)

    @property
    def visual(self) -> bool:
        return self.figure is not None and len(self.glossary) >= 5 and any(q.about_figure for q in self.questions) and all(q.evidence or q.about_figure for q in self.questions)

    @model_validator(mode="after")
    def _length(self) -> Passage:
        words = sum(len(tokens(p.text)) for p in self.paragraphs)
        if not 280 <= words <= 750:
            raise ValueError(f"{self.id}: passage has {words} words, expected 280-750")
        text = " ".join(p.text for p in self.paragraphs)
        for q in self.questions:
            if q.type == "gap" and not any(f" {' '.join(tokens(a))} " in f" {' '.join(tokens(text))} " for a in q.answers):
                raise ValueError(f"{self.id}: gap answer not in passage: {q.answers}")
            if q.evidence and not any(q.evidence in p.text for p in self.paragraphs):
                raise ValueError(f"{self.id}: evidence must be copied exactly from one paragraph: {q.evidence}")
            if q.about_figure and self.figure is None:
                raise ValueError(f"{self.id}: a figure question needs a figure")
        for g in self.glossary:
            if not any(g.word in p.text for p in self.paragraphs):
                raise ValueError(f"{self.id}: glossary word not in passage: {g.word}")
        return self


class GrammarFile(Strict):
    weeks: dict[str, list[GrammarLesson]]
    remedial: dict[str, list[GrammarLesson]]


class ReadingFile(Strict):
    weeks: dict[str, list[Passage]]


def _check_ids(groups: list[list[Any]]) -> None:
    ids = [item.id for group in groups for item in group]
    if len(ids) != len(set(ids)):
        raise ValueError("duplicate content ids")


@cache
def grammar() -> GrammarFile:
    data = GrammarFile.model_validate(json.loads((DIR / "grammar.json").read_text("utf-8")))
    if set(data.weeks) != {str(w) for w in range(1, len(PLAN) + 1)} or any(len(v) < 5 for v in data.weeks.values()) or set(data.remedial) != set(REMEDIAL_TYPES):
        raise ValueError("grammar.json must cover every week with 5+ lessons and every remedial type")
    _check_ids([*data.weeks.values(), *data.remedial.values()])
    return data


@cache
def reading() -> ReadingFile:
    data = ReadingFile.model_validate(json.loads((DIR / "reading.json").read_text("utf-8")))
    if set(data.weeks) != {str(w) for w in range(1, len(PLAN) + 1)} or any(len(v) < 4 for v in data.weeks.values()):
        raise ValueError("reading.json must cover every week with 4+ passages")
    _check_ids(list(data.weeks.values()))
    return data


def pick(week: int, week_start: date, day: date, error: str | None) -> tuple[GrammarLesson, Passage]:
    """Day n of the course week gets lesson n; on days 3 and 6 a recurring writing mistake swaps in its remedial lesson."""
    n = max((day - week_start).days, 0)
    lessons, passages = grammar().weeks[str(week)], reading().weeks[str(week)]
    lesson = lessons[n % len(lessons)]
    if error in REMEDIAL_TYPES and n in (2, 5):
        pool = grammar().remedial[error]
        lesson = pool[(week + n) % len(pool)]
    return lesson, passages[n % len(passages)]


def by_id(kind: Literal["grammar", "reading"], item_id: str) -> GrammarLesson | Passage | None:
    if kind == "grammar":
        g = grammar()
        return next((x for group in [*g.weeks.values(), *g.remedial.values()] for x in group if x.id == item_id), None)
    return next((x for group in reading().weeks.values() for x in group if x.id == item_id), None)


def public(item: GrammarLesson | Passage) -> dict[str, Any]:
    """The item without answers, explanations and evidence: those are only returned by the check."""
    data = item.model_dump()
    for task in data.get("exercises") or data.get("questions") or []:
        for key in ("answers", "explain_ru", "evidence"):
            task.pop(key, None)
        if task["type"] == "tfng":
            task["options"] = TFNG
    return data


def grade(item: GrammarLesson | Passage, given: dict[str, str]) -> list[dict[str, Any]]:
    """Grades only the items present in `given` (keys are 1-based numbers); unknown numbers are ignored."""
    tasks: Sequence[Exercise | Question] = item.exercises if isinstance(item, GrammarLesson) else item.questions
    results = []
    for n, task in enumerate(tasks, 1):
        if str(n) not in given:
            continue
        answer = given[str(n)].strip()
        exact = task.type in ("choice", "tfng", "mcq", "heading")
        ok = answer.casefold() in {a.casefold() for a in task.answers} if exact else bool(tokens(answer)) and tokens(answer) in [tokens(a) for a in task.answers]
        results.append({"n": n, "given": answer, "answer": task.answers[0], "ok": ok, "explain_ru": task.explain_ru, "evidence": getattr(task, "evidence", None)})
    return results
