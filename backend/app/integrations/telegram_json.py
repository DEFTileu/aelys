"""Normalize one standalone Markdown JSON fence before schema validation."""
import re


def unwrap_json_fence(text: str) -> str:
    text = text.strip()
    fenced = re.fullmatch(r"```(?:json)?[ \t]*\r?\n(.*?)\r?\n```", text, re.DOTALL)
    return fenced.group(1) if fenced else text
