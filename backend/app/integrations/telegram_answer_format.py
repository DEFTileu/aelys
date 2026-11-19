"""Render a small Markdown subset as Telegram text and explicit entities."""

from __future__ import annotations

import re
from bisect import bisect_left, bisect_right
from collections.abc import Iterator
from itertools import accumulate
from typing import NotRequired, TypedDict
from urllib.parse import urlsplit

from app.ai.providers import _safe_source_url

TEXT_LIMIT = 4096
TRACE_LABEL = 'Как я ответил'
TELEGRAM_ANSWER_STYLE = (
    "Start with a concise, natural summary of 1–3 sentences in the user's language. "
    "For a short answer, stop there: do not repeat it as details. "
    "When details are necessary, separate them from the summary with a blank line. "
    "Use Markdown for details, code and requested links; the application collapses details. "
    "Do not generate blockquotes, a trace footer, or a separate sources list."
)
LONG_ANSWER_NOTICE = 'Полный ответ — в MiniApp по ссылке «Как я ответил».'
SHORT_ANSWER_LIMIT = 600

# One pass over flat spans. Code consumes its contents before inline markup
# can interpret it. Unsupported or unclosed constructs remain plain text.
_MARKUP = re.compile(
    r'(?P<fence>^ {0,3}```(?P<language>[a-zA-Z0-9_+.-]{0,30})[ \t]*\r?\n'
    r'(?P<pre>[\s\S]*?)(?:(?P<closed>^ {0,3}```[ \t]*(?=\r?$))|\Z))'
    r'|\\(?P<escaped>[\\`*_[\]])'
    r'|(?<!`)`(?P<code>[^`\r\n]+)`(?!`)'
    r'|(?<!!)\[(?P<label>[^\[\]\r\n]+)\]\((?P<url>(?:[^()\r\n]|\([^()\r\n]*\))*)\)'
    r'|(?<!\*)\*\*(?P<bold>[^*`]+)\*\*(?!\*)'
    r'|(?<!_)__(?P<strong>[^_`]+)__(?!_)'
    r'|(?<!\*)\*(?P<italic>[^*`\r\n]+)\*(?!\*)'
    r'|(?<!\w)(?<!_)_(?P<emphasis>[^_`\r\n]+)_(?!\w|_)'
    r'|^(?P<indent> {0,3})[-*+][ \t]+(?=\S)',
    re.MULTILINE,
)
_NONSPACE = re.compile(r'\S')
_ENTITY_TYPES = {'pre': 'pre', 'code': 'code', 'bold': 'bold', 'strong': 'bold',
                 'italic': 'italic', 'emphasis': 'italic'}


class MessageEntity(TypedDict):
    type: str
    offset: int
    length: int
    url: NotRequired[str]
    language: NotRequired[str]


def _utf16_length(text: str) -> int:
    return len(text) + sum(ord(character) > 0xFFFF for character in text)


def _link_is_safe(url: str) -> bool:
    if any(char in url for char in '\\"<>') or not _safe_source_url(url):
        return False
    try:
        return urlsplit(url).port != 0
    except ValueError:
        return False


def _render(markdown: str) -> tuple[str, list[MessageEntity]]:
    parts: list[str] = []
    entities: list[MessageEntity] = []
    cursor = offset = 0
    for match in _MARKUP.finditer(markdown):
        plain = markdown[cursor:match.start()]
        parts.append(plain)
        offset += _utf16_length(plain)
        cursor = match.end()
        name = match.lastgroup
        entity: MessageEntity | None = None
        if name == 'fence':
            if match['closed'] is not None:
                name = 'pre'
                value = match['pre'].removesuffix('\n').removesuffix('\r')
            else:
                value = match.group()
        elif name == 'url':
            value = match['label']
            url = match['url']
            if value.strip() and _link_is_safe(url):
                entity = {'type': 'text_link', 'offset': offset, 'length': _utf16_length(value), 'url': url}
        elif name == 'indent':
            value = match['indent'] + '• '
        else:
            value = match.group(name) if name else match.group()
        if name in _ENTITY_TYPES:
            value = value if value.strip() else match.group()
            if value != match.group():
                entity = {'type': _ENTITY_TYPES[name], 'offset': offset, 'length': _utf16_length(value)}
                if name == 'pre' and match['language']:
                    entity['language'] = match['language']
        if entity:
            entities.append(entity)
        parts.append(value)
        offset += _utf16_length(value)
    parts.append(markdown[cursor:])
    return ''.join(parts), entities


def answer_chunks(markdown: str, trace_url: str | None) -> Iterator[tuple[str, list[MessageEntity]]]:
    text, entities = _render(markdown)
    # Keep the footer whole. If it needs its own message, omit its separator.
    positions = list(accumulate((1 + (ord(char) > 0xFFFF) for char in text), initial=0))
    index = entity_index = 0
    tail: tuple[str, list[MessageEntity]] | None = None
    while index < len(text):
        end = bisect_right(positions, positions[index] + TEXT_LIMIT) - 1
        if not _NONSPACE.search(text, index, end):
            visible = _NONSPACE.search(text, end)
            if visible is None:
                break
            # Telegram rejects whitespace-only messages. Keep as much of the
            # gap as fits with the next non-blank line, preserving indentation.
            line_end = text.find('\n', visible.start())
            if line_end == -1:
                line_end = len(text)
            end = min(line_end, bisect_right(positions, positions[visible.start()] + TEXT_LIMIT) - 1)
            index = bisect_left(positions, positions[end] - TEXT_LIMIT, lo=index, hi=visible.start() + 1)
        start_offset, end_offset = positions[index], positions[end]
        chunk = text[index:end]
        chunk_entities: list[MessageEntity] = []
        while entity_index < len(entities):
            entity = entities[entity_index]
            if entity['offset'] >= end_offset:
                break
            entity_end = entity['offset'] + entity['length']
            start = max(entity['offset'], start_offset)
            length = min(entity_end, end_offset) - start
            if length > 0:
                chunk_entities.append({**entity, 'offset': start - start_offset, 'length': length})
            if entity_end > end_offset:
                break
            entity_index += 1
        if tail is not None:
            yield tail
        tail = chunk, chunk_entities
        index = end

    if trace_url:
        chunk, chunk_entities = tail if tail else ('', [])
        offset = _utf16_length(chunk) + 2 if chunk else 0
        if offset + len(TRACE_LABEL) > TEXT_LIMIT:
            yield chunk, chunk_entities
            chunk, chunk_entities, offset = '', [], 0
        chunk_entities.append({'type': 'text_link', 'offset': offset, 'length': len(TRACE_LABEL), 'url': trace_url})
        tail = (f'{chunk}\n\n{TRACE_LABEL}' if chunk else TRACE_LABEL), chunk_entities
    if tail is not None:
        yield tail


def presented_answer_message(markdown: str, trace_url: str | None) -> tuple[str, list[MessageEntity]]:
    """One message: summary, collapsible details, overflow notice and trace link.

    The original answer must remain stored by the caller for the MiniApp. Without
    a trace URL the notice explicitly reports truncation instead of promising a link.
    Code/pre and links stay on unquoted lines: Telegram forbids their nesting
    inside blockquotes. Existing Markdown entities are preserved, never flattened.
    """
    text, entities = _render(markdown)
    text = text.rstrip()
    footer = ('\n\n' + TRACE_LABEL) if trace_url else ''
    overflow = _utf16_length(text + footer) > TEXT_LIMIT
    notice = ''
    if overflow:
        notice = ('\n\n' + LONG_ANSWER_NOTICE if trace_url else
                  '\n\nОтвет сокращён: полный текст не помещается в Telegram.')
    limit = TEXT_LIMIT - _utf16_length(footer + notice) - int(overflow)
    positions = list(accumulate((1 + (ord(char) > 0xFFFF) for char in text), initial=0))
    cut = bisect_right(positions, limit) - 1
    body = text[:cut].rstrip()
    body_end = _utf16_length(body)
    result_entities: list[MessageEntity] = [
        {**entity, 'length': min(entity['length'], body_end - entity['offset'])}
        for entity in entities if entity['offset'] < body_end
    ]

    # The prompt supplies a summary paragraph. Legacy answers without one stay
    # readable; never fabricate a summary or duplicate any of the answer.
    separator = body.find('\n\n')
    if _utf16_length(text) > SHORT_ANSWER_LIMIT and 0 < separator <= SHORT_ANSWER_LIMIT:
        details_start = separator + 2
        detail_offset = _utf16_length(body[:details_start])
        # Do not split an entity at the summary boundary.
        if not any(e['offset'] < detail_offset < e['offset'] + e['length'] for e in result_entities):
            blocked = [e for e in result_entities if e['type'] not in {'bold', 'italic', 'underline', 'strikethrough', 'spoiler'}]
            run_start: int | None = None
            offset = detail_offset
            for line in body[details_start:].splitlines(keepends=True):
                end = offset + _utf16_length(line)
                unsafe = any(e['offset'] < end and e['offset'] + e['length'] > offset for e in blocked)
                if unsafe:
                    if run_start is not None and offset > run_start:
                        result_entities.append({'type': 'expandable_blockquote', 'offset': run_start, 'length': offset - run_start})
                    run_start = None
                elif run_start is None:
                    run_start = offset
                offset = end
            if run_start is not None and offset > run_start:
                result_entities.append({'type': 'expandable_blockquote', 'offset': run_start, 'length': offset - run_start})
    # A style spanning a quoted/unquoted boundary would partially overlap the
    # blockquote, which Telegram rejects. Keep that text expanded instead.
    result_entities = [q for q in result_entities if q['type'] != 'expandable_blockquote' or not any(
        e['offset'] < q['offset'] < e['offset'] + e['length'] or
        e['offset'] < q['offset'] + q['length'] < e['offset'] + e['length']
        for e in result_entities if e['type'] != 'expandable_blockquote'
    )]
    result_entities.sort(key=lambda e: (e['offset'], -e['length']))
    body += ('…' if overflow else '') + notice
    if not _NONSPACE.search(body):
        body = ''
        result_entities = []
    if trace_url:
        offset = _utf16_length(body) + (2 if body else 0)
        body = (body + '\n\n' if body else '') + TRACE_LABEL
        result_entities.append({'type': 'text_link', 'offset': offset, 'length': len(TRACE_LABEL), 'url': trace_url})
    return body or 'Готово.', result_entities


def single_answer_message(markdown: str, trace_url: str | None) -> tuple[str, list[MessageEntity]]:
    """Compatibility entry point for the shared summary/details presentation."""
    return presented_answer_message(markdown, trace_url)
