import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.modules.setdefault(
    "httpx",
    types.SimpleNamespace(Timeout=lambda *args, **kwargs: object(), Client=None),
)

from llm import short_completion  # noqa: E402


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


if __name__ == "__main__":
    unittest.main()
