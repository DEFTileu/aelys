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
