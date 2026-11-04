"""Retain bounded MIME text/HTML alternatives without executing either."""
from datetime import UTC, datetime
from email import policy
from email.parser import BytesParser
from email.utils import getaddresses, parsedate_to_datetime

from fastapi import HTTPException


def parse_eml(raw: bytes) -> dict:
    message = BytesParser(policy=policy.default).parsebytes(raw)
    sender = str(message.get("From", "")).strip()
    if not sender:
        raise HTTPException(422, detail={"code": "INVALID_EML", "message": "EML must contain a From header"})
    body_part = message.get_body(preferencelist=("plain",))
    body = body_part.get_content() if body_part is not None else ""
    if not isinstance(body, str):
        body = ""
    html_part = message.get_body(preferencelist=("html",))
    html = html_part.get_content() if html_part is not None else ''
    html = html if isinstance(html, str) and len(html.encode('utf-8')) <= 1_000_000 else ''
    if not body and html:
        body = 'HTML message. Open the formatted view to read it.'
    try:
        received = parsedate_to_datetime(str(message.get("Date", "")))
        if received.tzinfo is None:
            received = received.replace(tzinfo=UTC)
    except (ValueError, TypeError, OverflowError):
        received = datetime.now(UTC)
    return {
        "sender": sender[:320],
        "recipients": [address for _, address in getaddresses([str(message.get("To", ""))])],
        "subject": str(message.get("Subject", "(No subject)"))[:500],
        "body": body,
        "body_html": html,
        "received_at": received,
        "sync_origin": "eml_import",
    }
