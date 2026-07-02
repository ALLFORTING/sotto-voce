import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.modules.setdefault(
    "httpx",
    types.SimpleNamespace(Timeout=lambda *args, **kwargs: object(), Client=None),
)

from llm import anthropic_messages, openai_messages, short_completion  # noqa: E402


class FakeResponse:
    def raise_for_status(self):
        return None

    def json(self):
        return {
            "choices": [
                {
                    "message": {
                        "content": "<thinking>某些思考</thinking>正式回复内容"
                    }
                }
            ]
        }


class FakeClient:
    def __init__(self, *args, **kwargs):
        pass

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def post(self, *args, **kwargs):
        return FakeResponse()


class ShortCompletionTest(unittest.TestCase):
    def test_openai_compatible_response_strips_thinking_tags(self):
        preset = {
            "endpoint": "https://example.com/v1",
            "format": "openai",
            "model": "test-model",
            "api_key": "test-key",
        }
        with patch("llm.httpx.Client", FakeClient):
            result = short_completion(preset, "测试 prompt", max_tokens=50)
        self.assertEqual(result, "正式回复内容")

    def test_image_attachment_becomes_model_content_blocks(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            upload_dir = Path(tmpdir)
            (upload_dir / "tiny.png").write_bytes(b"fakeimage")
            message = {
                "role": "user",
                "content": "这张图里有什么？",
                "created_at": "2026-07-02T12:00:00",
                "attachments": json.dumps(
                    [
                        {
                            "name": "tiny.png",
                            "path": "/uploads/tiny.png",
                            "type": "image",
                            "mime_type": "image/png",
                        }
                    ],
                    ensure_ascii=False,
                ),
            }
            with patch("llm.UPLOAD_DIR", upload_dir):
                anthropic = anthropic_messages([message])[0]["content"]
                openai = openai_messages("", [message])[0]["content"]
        self.assertEqual(anthropic[1]["type"], "image")
        self.assertEqual(anthropic[1]["source"]["media_type"], "image/png")
        self.assertEqual(anthropic[1]["source"]["data"], "ZmFrZWltYWdl")
        self.assertEqual(openai[1]["type"], "image_url")
        self.assertEqual(
            openai[1]["image_url"]["url"], "data:image/png;base64,ZmFrZWltYWdl"
        )


if __name__ == "__main__":
    unittest.main()
