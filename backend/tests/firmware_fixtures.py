"""Bytes shaped like a signed ESP-IDF app image, for backend firmware tests."""
import hashlib
import struct

PAGE = 4096


def make_image(version: str, *, signed: bool = True, size: int = 8192, project: str = 'companion') -> bytes:
    """Image header (24 B) + first segment header (8 B) + esp_app_desc_t, padded to `size`; a signed one ends in a signature block."""
    desc = struct.pack('<I12x32s32s', 0xABCD5432, version.encode(), project.encode())  # secure_version, reserv1[2], then version, project_name
    data = bytearray(b'\xe9' + b'\x00' * 31 + desc)
    data.extend(b'\x00' * (size - len(data)))
    if signed:
        data[-PAGE] = 0xE7  # signature block magic and version
        data[-PAGE + 1] = 0x02
    return bytes(data)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()
