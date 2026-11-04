"""HTML alternatives stay out of list payloads and never execute on import."""
import base64

from app.domains.gmail import html_body
from test_connected_workspaces import client as html_client  # noqa: F401 - fixture reuse


def test_gmail_html_alternative_excludes_attachments_and_nested_messages():
    encoded = base64.urlsafe_b64encode(b'<table><tr><td>Rich</td></tr></table>').decode()
    part = {'mimeType': 'text/html', 'body': {'data': encoded}}
    assert html_body({'mimeType': 'multipart/alternative', 'parts': [{'mimeType': 'text/plain'}, part]}).startswith('<table>')
    assert html_body({**part, 'filename': 'attachment.html'}) == ''
    assert html_body({'mimeType': 'message/rfc822', 'parts': [part]}) == ''
    assert html_body({'mimeType': 'text/html', 'body': {'data': 'x' * 1_400_001}}) == ''
    assert html_body({'mimeType': 'text/html', 'body': {'data': 'a'}}) == ''


async def test_eml_html_is_returned_only_by_owner_message_detail(html_client):  # noqa: F811 - imported fixture
    client = html_client
    raw = b'From: Person <person@example.test>\r\nSubject: Rich\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<table><tr><td style="color:red">Rich</td></tr></table><script>never execute</script>'
    response = await client.post('/api/v1/mail/import/eml', files={'file': ('rich.eml', raw, 'message/rfc822')})
    assert response.status_code == 200, response.text
    data = response.json()
    assert 'body_html' not in data
    detail = await client.get('/api/v1/read/mail/' + data['id'])
    assert detail.status_code == 200 and '<table>' in detail.json()['body_html']
    assert '<script>' not in detail.headers.get('content-type', '')
    from app.core import db
    from sqlalchemy import event

    statements = []
    engine = db.SessionLocal.kw['bind'].sync_engine
    def capture(_conn, _cursor, statement, _parameters, _context, _many):
        statements.append(statement)
    event.listen(engine, 'before_cursor_execute', capture)
    try:
        for path in ['/api/v1/mail/messages', '/api/v1/read/mail']:
            listed = await client.get(path)
            assert listed.status_code == 200 and 'body_html' not in listed.text
    finally:
        event.remove(engine, 'before_cursor_execute', capture)
    assert statements and not any('mail_messages.body_html' in statement for statement in statements)
    repeated = await client.post('/api/v1/mail/import/eml', files={'file': ('rich.eml', raw, 'message/rfc822')})
    assert repeated.json()['id'] == data['id']
    client.headers.pop('Authorization')
    assert (await client.get('/api/v1/read/mail/' + data['id'])).status_code == 401
