"""Telegram formatting, unsafe Markdown and chunk boundaries."""
import pytest
from app.integrations.telegram_answer_format import answer_chunks

TRACE = 'https://t.me/example_bot?startapp=run__123'
LABEL = 'Как я ответил'


def entity_spans(text, entities):
    wire = text.encode('utf-16-le')
    return [(item['type'], wire[item['offset'] * 2:(item['offset'] + item['length']) * 2].decode('utf-16-le'))
            for item in entities]


def test_unicode_lists_and_flat_markup_keep_code_literal():
    source = (
        "😀 **Лучший\nответ**\n\n- *Қазақша*\n* __second__ and _third_\n"
        "1. `a ** b`\n```python\nprint('😀 **x**')\n  print('[x](https://example.org)')\n```\n"
        "\\*literal\\* <b>plain</b>\nhttps://example.org/a_b_c"
    )
    [(text, entities)] = answer_chunks(source, TRACE)
    assert text == (
        "😀 Лучший\nответ\n\n• Қазақша\n• second and third\n"
        "1. a ** b\nprint('😀 **x**')\n  print('[x](https://example.org)')\n"
        f"*literal* <b>plain</b>\nhttps://example.org/a_b_c\n\n{LABEL}"
    )
    assert entity_spans(text, entities) == [
        ('bold', 'Лучший\nответ'), ('italic', 'Қазақша'), ('bold', 'second'), ('italic', 'third'),
        ('code', 'a ** b'), ('pre', "print('😀 **x**')\n  print('[x](https://example.org)')"),
        ('text_link', LABEL),
    ]
    assert entities[0]['offset'] == 3
    assert entities[-2]['language'] == 'python'
    assert entities[-1]['url'] == TRACE


@pytest.mark.parametrize('url', [
    'javascript:alert(1)', 'tg://user?id=42', 'data:text/html,hi', '//example.org', 'https://user@example.org',
    'http://127.0.0.1', 'https://bad.example\\@other.example', 'https://example.org:bad', 'https://example.org/<tag>',
])
def test_invalid_model_link_drops_target_but_keeps_label(url):
    [(text, entities)] = answer_chunks(f'[ссылка]({url})', None)
    assert text == 'ссылка'
    assert entities == []


def test_public_link_and_unfinished_markup():
    [(text, entities)] = answer_chunks(
        '😀 [read it](https://example.org/wiki/Software_(topic)) **unfinished\n```python\nprint("**literal**")', None,
    )
    assert text == '😀 read it **unfinished\n```python\nprint("**literal**")'
    assert entities == [{'type': 'text_link', 'offset': 3, 'length': 7, 'url': 'https://example.org/wiki/Software_(topic)'}]


def test_utf16_chunks_clip_emoji_and_code_entities_at_boundaries():
    code = '😀' * 2100 + '\nЖ'
    answer = f'```py\n{code}\n```'
    chunks = list(answer_chunks(answer, TRACE))
    assert len(chunks) == 2
    assert chunks[0][0] + chunks[1][0] == code + '\n\n' + LABEL
    for chunk, items in chunks:
        assert 1 <= len(chunk.encode('utf-16-le')) // 2 <= 4096
        assert items[0]['offset'] == 0
        assert items[0]['language'] == 'py'
    assert entity_spans(*chunks[0]) == [('pre', '😀' * 2048)]
    assert entity_spans(*chunks[1]) == [('pre', '😀' * 52 + '\nЖ'), ('text_link', LABEL)]


def test_large_blank_gap_does_not_drop_indented_code_or_emit_empty_message():
    code = 'x' * 4096 + '\n' * 4100 + '    print(42)'
    chunks = list(answer_chunks(f'```\n{code}\n```', TRACE))
    assert all(chunk.strip() for chunk, _ in chunks)
    assert chunks[0][0] == 'x' * 4096
    assert chunks[1][0] == '\n' * (4096 - len('    print(42)')) + '    print(42)'
    assert entity_spans(*chunks[1]) == [('pre', chunks[1][0])]
    assert chunks[-1][0] == LABEL


def test_presented_summary_details_code_links_and_footer():
    from app.integrations.telegram_answer_format import presented_answer_message
    source = ('Итог 😀.\n\n**Детали 😀** ' + 'текст ' * 120 +
              '\n[ссылка](https://example.org)\n```py\nprint("😀")\n```\nещё `код`\nКонец.')
    text, entities = presented_answer_message(source, TRACE)
    spans = entity_spans(text, entities)
    assert ('bold', 'Детали 😀') in spans
    assert ('text_link', 'ссылка') in spans
    assert ('pre', 'print("😀")') in spans
    assert ('code', 'код') in spans
    assert text.count('Итог 😀.') == 1
    assert spans[-1] == ('text_link', LABEL)
    quotes = [e for e in entities if e['type'] == 'expandable_blockquote']
    assert len(quotes) == 2
    assert quotes[0]['offset'] == len('Итог 😀.\n\n'.encode('utf-16-le')) // 2
    for q in quotes:
        for e in entities:
            if e is q or e['type'] in {'bold', 'italic'}:
                continue
            assert e['offset'] >= q['offset'] + q['length'] or e['offset'] + e['length'] <= q['offset']


@pytest.mark.parametrize('source', ['😀' * 3000, '**' + 'я' * 6000 + '**',
                                    'Итог.\n\n```py\n' + '😀' * 3000 + '\n```'])
@pytest.mark.parametrize('trace', [TRACE, None])
def test_presented_overflow_visible_and_utf16_valid(source, trace):
    from app.integrations.telegram_answer_format import presented_answer_message
    text, entities = presented_answer_message(source, trace)
    size = len(text.encode('utf-16-le')) // 2
    assert size <= 4096
    assert ('Полный ответ — в MiniApp' if trace else 'Ответ сокращён') in text
    entity_spans(text, entities)
    for e in entities:
        assert 0 <= e['offset'] < e['offset'] + e['length'] <= size
    if trace:
        assert entity_spans(text, entities)[-1] == ('text_link', LABEL)


def test_presented_short_and_compatibility():
    from app.integrations.telegram_answer_format import (
        presented_answer_message,
        single_answer_message,
    )
    source = '😀 **Готово** с `кодом`'
    text, entities = presented_answer_message(source, TRACE)
    assert (text, entities) == single_answer_message(source, TRACE)
    assert text == f'😀 Готово с кодом\n\n{LABEL}'
    assert [t for t, _ in entity_spans(text, entities)] == ['bold', 'code', 'text_link']


def test_summary_boundary_cannot_cross_multiline_entity():
    from app.integrations.telegram_answer_format import presented_answer_message
    _, entities = presented_answer_message('**Summary\n\n' + 'detail ' * 110 + '**', TRACE)
    assert not any(e['type'] == 'expandable_blockquote' for e in entities)


def test_telegram_prompt_uses_shared_style():
    from app.ai.chat_support import system_prompt
    from app.integrations.telegram_answer_format import TELEGRAM_ANSWER_STYLE
    assert TELEGRAM_ANSWER_STYLE in system_prompt('UTC', tools=True, channel='telegram')
    assert TELEGRAM_ANSWER_STYLE not in system_prompt('UTC', tools=True)
    assert TELEGRAM_ANSWER_STYLE not in system_prompt('UTC', tools=True, channel='voice')
