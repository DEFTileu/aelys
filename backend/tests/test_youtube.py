import asyncio

from app.ai import youtube


def test_video_id_from_common_links():
    assert youtube.youtube_video_id("сделай саммари", "https://www.youtube.com/watch?v=Cgo--MJkz3I") == "Cgo--MJkz3I"
    assert youtube.youtube_video_id("https://youtu.be/Cgo--MJkz3I?t=5") == "Cgo--MJkz3I"
    assert youtube.youtube_video_id("youtube.com/watch?feature=share&v=Cgo--MJkz3I") == "Cgo--MJkz3I"
    assert youtube.youtube_video_id("https://youtube.com/shorts/Cgo--MJkz3I") == "Cgo--MJkz3I"
    assert youtube.youtube_video_id("no link", None) is None


def test_transcript_is_untrusted_and_failures_are_silent(monkeypatch):
    monkeypatch.setattr(youtube, "_fetch", lambda video_id: "привет мир")
    message = asyncio.run(youtube.youtube_transcript_message("https://youtu.be/Cgo--MJkz3I"))
    assert message is not None and message.untrusted and message.content.endswith("привет мир")

    def blocked(video_id):
        raise RuntimeError("RequestBlocked")

    monkeypatch.setattr(youtube, "_fetch", blocked)
    assert asyncio.run(youtube.youtube_transcript_message("https://youtu.be/Cgo--MJkz3I")) is None
    assert asyncio.run(youtube.youtube_transcript_message("no link")) is None


def test_timestamped_groups_into_blocks():
    text = youtube.timestamped([(0.0, 2, "привет"), (10.0, 2, "мир\nвсем"), (31.5, 2, "дальше"), (3700, 2, "конец")])
    assert text == "[0:00] привет мир всем\n[0:31] дальше\n[1:01:40] конец"
