"""Keep the firmware's fixed wire vocabulary aligned with the server allowlist."""
import re
from pathlib import Path

from app.companion.character import REASON_MOODS


def test_firmware_character_codes_match_backend_vocabulary():
    source = (Path(__file__).parents[2] / 'firmware/companion/components/logic/character_report.c').read_text()
    def codes(name):
        block = re.search(rf'static const char \*const {name}\[\] = \{{(.*?)\}};', source, re.S)
        assert block is not None
        return set(re.findall(r'"([a-z_]+)"', block.group(1)))
    assert codes('reasons') == set(REASON_MOODS)
    assert codes('moods') == set().union(*REASON_MOODS.values())
