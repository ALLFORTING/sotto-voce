import copy
import json
import logging
import re
import time
from dataclasses import dataclass, field
from urllib.parse import urlparse

import httpx

from db import connection, now_iso, parse_attachments
from mcp_client import call_tool, get_tools


LOGGER = logging.getLogger(__name__)
MAX_TOOL_ROUNDS = 15
DEFAULT_CONTEXT_WINDOW = 200_000
CACHE_USER_ID = "sotto-voce-stable"


class ChatSetupError(Exception):
    def __init__(self, message, status_code=400):
        super().__init__(message)
        self.status_code = status_code


@dataclass
class StreamResult:
    text: str = ""
    thinking: str = ""
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    tool_calls: list = field(default_factory=list)


def sse(event, data):
    return (
        f"event: {event}\n"
        f"data: {json.dumps(data, ensure_ascii=False, separators=(',', ':'))}\n\n"
    )


def context_window(model):
    name = model.lower()
    known = (
        ("gpt-4.1", 1_047_576),
        ("gpt-4o", 128_000),
        ("o1", 200_000),
        ("o3", 200_000),
        ("claude", 200_000),
        ("gemini-2.5", 1_048_576),
        ("gemini-2.0", 1_048_576),
    )
    return next((size for marker, size in known if marker in name), DEFAULT_CONTEXT_WINDOW)


def cache_mode(preset):
    host = urlparse(preset["endpoint"]).hostname or ""
    if host.endswith("openrouter.ai"):
        return "or-blocks"
    if preset["format"] == "anthropic" and (
        host.endswith("anthropic.com") or host.endswith("msui.io")
    ):
        return "anthropic-bp"
    return "oai-passthrough"


def upstream_format(preset):
    if cache_mode(preset) == "or-blocks":
        return "openai"
    return preset["format"]


def cached_text_block(text):
    return {
        "type": "text",
        "text": text,
        "cache_control": {"type": "ephemeral"},
    }


def mark_cache_breakpoint(message):
    content = message.get("content")
    if isinstance(content, str):
        message["content"] = [cached_text_block(content)]
    elif isinstance(content, list) and content:
        last = content[-1]
        if isinstance(last, dict):
            last["cache_control"] = {"type": "ephemeral"}
        elif isinstance(last, str):
            content[-1] = cached_text_block(last)


def mark_rolling_user_breakpoint(messages):
    for index in range(len(messages) - 2, -1, -1):
        if messages[index].get("role") == "user":
            mark_cache_breakpoint(messages[index])
            break


def endpoint_url(endpoint, suffix):
    base = endpoint.rstrip("/")
    normalized = "/" + suffix.lstrip("/")
    if base.endswith(normalized):
        return base
    if base.endswith("/v1") and normalized.startswith("/v1/"):
        return base + normalized[3:]
    return base + normalized


def timestamped(message):
    created_at = message["created_at"]
    try:
        display = created_at[:16].replace("T", " ")
    except (TypeError, IndexError):
        display = created_at
    content = f"[{display}]\n{message['content']}"
    if message.get("attachments"):
        content += f"\n[attachments] {message['attachments']}"
    return content


def load_chat_context(conversation_id, content, attachments):
    content = str(content or "").strip()
    if not content:
        raise ChatSetupError("content is required.")
    try:
        serialized_attachments = parse_attachments(attachments)
    except (TypeError, ValueError) as error:
        raise ChatSetupError("attachments must be valid JSON.") from error

    with connection() as conn:
        conversation = conn.execute(
            "SELECT id, title FROM conversations WHERE id = ?", (conversation_id,)
        ).fetchone()
        if not conversation:
            raise ChatSetupError("Conversation not found.", 404)
        preset_row = conn.execute(
            "SELECT * FROM api_presets WHERE active = 1 ORDER BY id DESC LIMIT 1"
        ).fetchone()
        if not preset_row:
            raise ChatSetupError("No active API preset is configured.", 409)
        settings = {
            row["key"]: row["value"] or ""
            for row in conn.execute(
                "SELECT key, value FROM settings WHERE key IN ('system_prompt', 'profile')"
            ).fetchall()
        }
        created_at = now_iso()
        conn.execute(
            """
            INSERT INTO messages(
                conversation_id, role, content, attachments, created_at
            ) VALUES (?, 'user', ?, ?, ?)
            """,
            (conversation_id, content, serialized_attachments, created_at),
        )
        conn.execute(
            "UPDATE conversations SET updated_at = ?, archived = 0 WHERE id = ?",
            (created_at, conversation_id),
        )
        history = [
            dict(row)
            for row in conn.execute(
                """
                SELECT role, content, attachments, created_at
                FROM messages
                WHERE conversation_id = ? AND deleted = 0
                ORDER BY created_at, id
                """,
                (conversation_id,),
            ).fetchall()
        ]

    system = "\n\n".join(
        value.strip()
        for value in (settings.get("system_prompt", ""), settings.get("profile", ""))
        if value.strip()
    )
    return {
        "conversation_id": conversation_id,
        "preset": dict(preset_row),
        "system": system,
        "history": history,
        "conversation_title": conversation["title"],
    }


def load_regeneration_context(message_id):
    with connection() as conn:
        target = conn.execute(
            """
            SELECT m.id, m.conversation_id, c.title
            FROM messages m
            JOIN conversations c ON c.id = m.conversation_id
            WHERE m.id = ? AND m.role = 'assistant' AND m.deleted = 0
            """,
            (message_id,),
        ).fetchone()
        if not target:
            raise ChatSetupError("Assistant message not found.", 404)
        preset_row = conn.execute(
            "SELECT * FROM api_presets WHERE active = 1 ORDER BY id DESC LIMIT 1"
        ).fetchone()
        if not preset_row:
            raise ChatSetupError("No active API preset is configured.", 409)
        settings = {
            row["key"]: row["value"] or ""
            for row in conn.execute(
                "SELECT key, value FROM settings WHERE key IN ('system_prompt', 'profile')"
            ).fetchall()
        }
        history = [
            dict(row)
            for row in conn.execute(
                """
                SELECT role, content, attachments, created_at
                FROM messages
                WHERE conversation_id = ? AND deleted = 0 AND id < ?
                ORDER BY created_at, id
                """,
                (target["conversation_id"], message_id),
            ).fetchall()
        ]
        if not history or history[-1]["role"] != "user":
            raise ChatSetupError("No user message exists before this response.", 409)
        conn.execute(
            """
            UPDATE messages SET deleted = 1
            WHERE conversation_id = ? AND id >= ?
            """,
            (target["conversation_id"], message_id),
        )
    system = "\n\n".join(
        value.strip()
        for value in (settings.get("system_prompt", ""), settings.get("profile", ""))
        if value.strip()
    )
    return {
        "conversation_id": target["conversation_id"],
        "preset": dict(preset_row),
        "system": system,
        "history": history,
        "conversation_title": target["title"],
    }


def short_completion(preset, prompt, max_tokens=100):
    headers = auth_headers(preset)
    headers["Accept"] = "application/json"
    format_name = upstream_format(preset)
    if format_name == "anthropic":
        url = endpoint_url(preset["endpoint"], "/v1/messages")
        body = {
            "model": preset["model"],
            "max_tokens": max_tokens,
            "stream": False,
            "messages": [{"role": "user", "content": prompt}],
        }
    else:
        url = endpoint_url(preset["endpoint"], "/v1/chat/completions")
        body = {
            "model": preset["model"],
            "max_tokens": max_tokens,
            "stream": False,
            "messages": [{"role": "user", "content": prompt}],
        }
    with httpx.Client(timeout=httpx.Timeout(45.0, connect=20.0)) as client:
        response = client.post(url, headers=headers, json=body)
        response.raise_for_status()
        data = response.json()
    if format_name == "anthropic":
        return "".join(
            block.get("text", "")
            for block in data.get("content", [])
            if block.get("type") == "text"
        )
    return data["choices"][0]["message"].get("content", "")


def plain_text(value, limit):
    text = re.sub(r"[#*_`>\[\]()~|]", "", str(value))
    text = re.sub(r"\s+", " ", text).strip().strip("\"'“”‘’")
    return text[:limit].rstrip("，。；、 ")


def record_usage_log(context, result, created_at):
    preset = context["preset"]
    input_tokens = int(result.input_tokens or 0)
    output_tokens = int(result.output_tokens or 0)
    cache_read_tokens = int(result.cache_read_tokens or 0)
    cache_write_tokens = int(result.cache_write_tokens or 0)
    input_price = float(preset.get("input_price") or 0)
    output_price = float(preset.get("output_price") or 0)
    cost = ((input_tokens * input_price) + (output_tokens * output_price)) / 1_000_000
    with connection() as conn:
        conn.execute(
            """
            INSERT INTO usage_logs(
                conversation_id, preset_name, model,
                input_tokens, output_tokens,
                cache_read_tokens, cache_write_tokens,
                cost, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                context["conversation_id"],
                preset.get("name"),
                preset.get("model"),
                input_tokens,
                output_tokens,
                cache_read_tokens,
                cache_write_tokens,
                cost,
                created_at,
            ),
        )


def generate_home_summary(conversation_id):
    with connection() as conn:
        conversation = conn.execute(
            """
            SELECT id, summary, summary_message_id,
                   (
                     SELECT MAX(id) FROM messages
                     WHERE conversation_id = conversations.id AND deleted = 0
                   ) AS latest_message_id
            FROM conversations WHERE id = ?
            """,
            (conversation_id,),
        ).fetchone()
        if not conversation or not conversation["latest_message_id"]:
            return None
        if (
            conversation["summary"]
            and conversation["summary_message_id"] == conversation["latest_message_id"]
        ):
            return conversation["summary"]
        preset = conn.execute(
            "SELECT * FROM api_presets WHERE active = 1 ORDER BY id DESC LIMIT 1"
        ).fetchone()
        messages = conn.execute(
            """
            SELECT role, content FROM messages
            WHERE conversation_id = ? AND deleted = 0
            ORDER BY id DESC LIMIT 8
            """,
            (conversation_id,),
        ).fetchall()
    if not preset:
        return None
    transcript = "\n".join(
        f"{'用户' if item['role'] == 'user' else '助手'}：{item['content'][:500]}"
        for item in reversed(messages)
    )
    prompt = (
        "把下面最近一段对话概括成不超过40个中文字符的一句纯文本。"
        "只写聊到的事情，不要标题、引号、Markdown符号或解释。\n" + transcript
    )
    summary = plain_text(short_completion(dict(preset), prompt, 100), 40)
    if summary:
        with connection() as conn:
            conn.execute(
                """
                UPDATE conversations
                SET summary = ?, summary_message_id = ?
                WHERE id = ?
                """,
                (summary, conversation["latest_message_id"], conversation_id),
            )
    return summary or None


def generate_conversation_title(context, assistant_text):
    if len(context["history"]) != 1 or context["conversation_title"] != "新对话":
        return None
    preset = context["preset"]
    user_text = context["history"][0]["content"][:400]
    prompt = (
        "请为下面这轮对话生成一个不超过12个中文字符的标题。"
        "只输出标题，不要引号、标点或解释。\n"
        f"用户：{user_text}\n助手：{assistant_text[:500]}"
    )
    title = plain_text(short_completion(preset, prompt, 32), 12)
    return title or None


def auth_headers(preset):
    host = urlparse(preset["endpoint"]).hostname or ""
    format_name = upstream_format(preset)
    headers = {"Accept": "text/event-stream", "Content-Type": "application/json"}
    if format_name == "anthropic" and host.endswith("anthropic.com"):
        headers["x-api-key"] = preset["api_key"]
        headers["anthropic-version"] = "2023-06-01"
    else:
        headers["Authorization"] = f"Bearer {preset['api_key']}"
        if format_name == "anthropic":
            headers["anthropic-version"] = "2023-06-01"
    return headers


def anthropic_messages(history):
    return [
        {"role": item["role"], "content": timestamped(item)}
        for item in history
    ]


def openai_messages(system, history):
    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.extend(
        {"role": item["role"], "content": timestamped(item)}
        for item in history
    )
    return messages


def anthropic_tools(tools):
    return [
        {
            "name": item["name"],
            "description": item.get("description", ""),
            "input_schema": item.get("inputSchema", {"type": "object"}),
        }
        for item in tools
    ]


def openai_tools(tools):
    return [
        {
            "type": "function",
            "function": {
                "name": item["name"],
                "description": item.get("description", ""),
                "parameters": item.get("inputSchema", {"type": "object"}),
            },
        }
        for item in tools
    ]


def iter_sse_json(response):
    event_name = None
    data_lines = []
    for raw_line in response.iter_lines():
        line = raw_line.strip()
        if not line:
            if data_lines:
                data = "\n".join(data_lines)
                if data != "[DONE]":
                    try:
                        yield event_name, json.loads(data)
                    except json.JSONDecodeError:
                        LOGGER.warning("Ignoring non-JSON upstream SSE data: %s", data[:200])
            event_name = None
            data_lines = []
            continue
        if line.startswith(":"):
            continue
        if line.startswith("event:"):
            event_name = line[6:].strip()
        elif line.startswith("data:"):
            data_lines.append(line[5:].strip())
    if data_lines:
        data = "\n".join(data_lines)
        if data != "[DONE]":
            yield event_name, json.loads(data)


def request_payload(context, tools, extra_messages):
    preset = context["preset"]
    host = urlparse(preset["endpoint"]).hostname or ""
    mode = cache_mode(preset)
    format_name = upstream_format(preset)
    if format_name == "anthropic":
        messages = anthropic_messages(context["history"]) + copy.deepcopy(extra_messages)
        body = {
            "model": preset["model"],
            "max_tokens": 8192,
            "stream": True,
            "messages": messages,
        }
        if context["system"]:
            body["system"] = context["system"]
        if tools:
            body["tools"] = anthropic_tools(tools)
        if mode == "anthropic-bp":
            if context["system"]:
                body["system"] = [cached_text_block(context["system"])]
            body["metadata"] = {"user_id": CACHE_USER_ID}
            mark_rolling_user_breakpoint(body["messages"])
        return endpoint_url(preset["endpoint"], "/v1/messages"), body

    messages = openai_messages(
        context["system"], context["history"]
    ) + copy.deepcopy(extra_messages)
    body = {
        "model": preset["model"],
        "stream": True,
        "stream_options": {"include_usage": True},
        "messages": messages,
    }
    if tools:
        body["tools"] = openai_tools(tools)
    if host.endswith("openrouter.ai"):
        body["reasoning"] = {"enabled": True}
    if mode == "or-blocks":
        if body["messages"] and body["messages"][0].get("role") == "system":
            mark_cache_breakpoint(body["messages"][0])
        mark_rolling_user_breakpoint(body["messages"])
    return endpoint_url(preset["endpoint"], "/v1/chat/completions"), body


def reasoning_text(value):
    if not value:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        return (
            value.get("text")
            or value.get("delta")
            or value.get("content")
            or value.get("reasoning")
            or ""
        )
    if isinstance(value, list):
        return "".join(reasoning_text(item) for item in value)
    return ""


def stream_anthropic(response):
    result = StreamResult()
    blocks = {}
    thinking_started = False
    thinking_started_at = None
    for _event_name, data in iter_sse_json(response):
        event_type = data.get("type")
        if event_type == "error":
            detail = data.get("error", {})
            raise RuntimeError(detail.get("message") or "Anthropic upstream error.")
        if event_type == "message_start":
            usage = data.get("message", {}).get("usage", {})
            result.input_tokens = int(usage.get("input_tokens", 0))
            result.cache_read_tokens = int(usage.get("cache_read_input_tokens", 0))
            result.cache_write_tokens = int(usage.get("cache_creation_input_tokens", 0))
        elif event_type == "content_block_start":
            index = data.get("index", 0)
            block = data.get("content_block", {})
            blocks[index] = {
                "type": block.get("type"),
                "id": block.get("id"),
                "name": block.get("name"),
                "json": "",
            }
            if block.get("type") == "tool_use":
                initial_input = block.get("input") or {}
                blocks[index]["json"] = (
                    json.dumps(initial_input) if initial_input else ""
                )
        elif event_type == "content_block_delta":
            index = data.get("index", 0)
            delta = data.get("delta", {})
            delta_type = delta.get("type")
            if delta_type == "thinking_delta":
                if not thinking_started:
                    thinking_started = True
                    thinking_started_at = time.monotonic()
                    yield "thinking_start", {}, result
                text = delta.get("thinking", "")
                result.thinking += text
                if text:
                    yield "thinking_delta", {"text": text}, result
            elif delta_type == "text_delta":
                text = delta.get("text", "")
                result.text += text
                if text:
                    yield "text_delta", {"text": text}, result
            elif delta_type == "input_json_delta":
                blocks.setdefault(index, {"type": "tool_use", "json": ""})
                blocks[index]["json"] += delta.get("partial_json", "")
        elif event_type == "content_block_stop":
            block = blocks.get(data.get("index", 0), {})
            if block.get("type") == "tool_use":
                try:
                    tool_input = json.loads(block.get("json") or "{}")
                except json.JSONDecodeError:
                    tool_input = {"_raw": block.get("json", "")}
                call = {
                    "id": block.get("id"),
                    "name": block.get("name"),
                    "input": tool_input,
                }
                result.tool_calls.append(call)
                yield "tool_use", {"name": call["name"], "input": tool_input}, result
        elif event_type == "message_delta":
            result.output_tokens = int(
                data.get("usage", {}).get("output_tokens", result.output_tokens)
            )
    if thinking_started:
        seconds = round(time.monotonic() - thinking_started_at, 2)
        yield "thinking_end", {"seconds": seconds}, result


def stream_openai(response):
    result = StreamResult()
    tool_parts = {}
    thinking_started = False
    thinking_started_at = None
    for _event_name, data in iter_sse_json(response):
        if data.get("error"):
            detail = data["error"]
            raise RuntimeError(
                detail.get("message", "OpenAI-compatible upstream error.")
                if isinstance(detail, dict)
                else str(detail)
            )
        usage = data.get("usage") or {}
        result.input_tokens = int(usage.get("prompt_tokens", result.input_tokens))
        result.output_tokens = int(usage.get("completion_tokens", result.output_tokens))
        details = usage.get("prompt_tokens_details") or {}
        cached_tokens = details.get("cached_tokens")
        if cached_tokens is not None:
            result.cache_read_tokens = int(cached_tokens)
        if usage and usage.get("prompt_tokens"):
            LOGGER.debug("openai usage: %s", json.dumps(usage, default=str))
        choices = data.get("choices") or []
        if not choices:
            continue
        delta = choices[0].get("delta") or {}
        reasoning = reasoning_text(
            delta.get("reasoning_content")
            or delta.get("reasoning")
            or delta.get("thinking")
            or delta.get("reasoning_details")
            or ""
        )
        if reasoning:
            if not thinking_started:
                thinking_started = True
                thinking_started_at = time.monotonic()
                yield "thinking_start", {}, result
            result.thinking += reasoning
            yield "thinking_delta", {"text": reasoning}, result
        text = delta.get("content") or ""
        if text:
            result.text += text
            yield "text_delta", {"text": text}, result
        for part in delta.get("tool_calls") or []:
            index = part.get("index", 0)
            entry = tool_parts.setdefault(
                index, {"id": None, "name": None, "arguments": ""}
            )
            entry["id"] = part.get("id") or entry["id"]
            function = part.get("function") or {}
            entry["name"] = function.get("name") or entry["name"]
            entry["arguments"] += function.get("arguments") or ""
    if thinking_started:
        seconds = round(time.monotonic() - thinking_started_at, 2)
        yield "thinking_end", {"seconds": seconds}, result
    for entry in tool_parts.values():
        try:
            tool_input = json.loads(entry["arguments"] or "{}")
        except json.JSONDecodeError:
            tool_input = {"_raw": entry["arguments"]}
        call = {"id": entry["id"], "name": entry["name"], "input": tool_input}
        result.tool_calls.append(call)
        yield "tool_use", {"name": call["name"], "input": tool_input}, result


def tool_followup(format_name, result, tool_results):
    if format_name == "anthropic":
        assistant_content = []
        if result.text:
            assistant_content.append({"type": "text", "text": result.text})
        assistant_content.extend(
            {
                "type": "tool_use",
                "id": call["id"],
                "name": call["name"],
                "input": call["input"],
            }
            for call in result.tool_calls
        )
        return [
            {"role": "assistant", "content": assistant_content},
            {
                "role": "user",
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": call["id"],
                        "content": json.dumps(value, ensure_ascii=False),
                    }
                    for call, value in tool_results
                ],
            },
        ]
    assistant = {
        "role": "assistant",
        "content": result.text or None,
        "tool_calls": [
            {
                "id": call["id"],
                "type": "function",
                "function": {
                    "name": call["name"],
                    "arguments": json.dumps(call["input"], ensure_ascii=False),
                },
            }
            for call in result.tool_calls
        ],
    }
    messages = [assistant]
    messages.extend(
        {
            "role": "tool",
            "tool_call_id": call["id"],
            "content": json.dumps(value, ensure_ascii=False),
        }
        for call, value in tool_results
    )
    return messages


def chat_events(context):
    preset = context["preset"]
    format_name = upstream_format(preset)
    tools = get_tools()
    extra_messages = []
    final_result = StreamResult()
    started_at = time.monotonic()
    try:
        with httpx.Client(timeout=httpx.Timeout(120.0, connect=20.0)) as client:
            for round_number in range(MAX_TOOL_ROUNDS + 1):
                url, body = request_payload(context, tools, extra_messages)
                with client.stream(
                    "POST", url, headers=auth_headers(preset), json=body
                ) as response:
                    if response.status_code >= 400:
                        detail = response.read().decode("utf-8", errors="replace")
                        raise RuntimeError(
                            f"Upstream returned HTTP {response.status_code}: {detail[:500]}"
                        )
                    parser = (
                        stream_anthropic
                        if format_name == "anthropic"
                        else stream_openai
                    )
                    current = StreamResult()
                    for event, data, current in parser(response):
                        yield sse(event, data)
                final_result.text += current.text
                final_result.thinking += current.thinking
                final_result.input_tokens += current.input_tokens
                final_result.output_tokens += current.output_tokens
                final_result.cache_read_tokens += current.cache_read_tokens
                final_result.cache_write_tokens += current.cache_write_tokens
                if not current.tool_calls:
                    break
                if round_number >= MAX_TOOL_ROUNDS:
                    raise RuntimeError("Tool call loop exceeded 15 rounds.")
                tool_results = []
                for call in current.tool_calls:
                    try:
                        value = call_tool(call["name"], call["input"])
                        yield sse("tool_result", {"name": call["name"], "ok": True})
                    except Exception as error:
                        value = {"error": str(error)}
                        yield sse("tool_result", {"name": call["name"], "ok": False})
                    tool_results.append((call, value))
                extra_messages.extend(
                    tool_followup(format_name, current, tool_results)
                )

        if not final_result.text.strip():
            raise RuntimeError("The upstream completed without assistant text.")
        completed_at = now_iso()
        thinking_seconds = round(time.monotonic() - started_at, 2)
        with connection() as conn:
            cursor = conn.execute(
                """
                INSERT INTO messages(
                    conversation_id, role, content, thinking,
                    thinking_seconds, created_at
                ) VALUES (?, 'assistant', ?, ?, ?, ?)
                """,
                (
                    context["conversation_id"],
                    final_result.text,
                    final_result.thinking or None,
                    thinking_seconds if final_result.thinking else None,
                    completed_at,
                ),
            )
            conn.execute(
                "UPDATE conversations SET updated_at = ? WHERE id = ?",
                (completed_at, context["conversation_id"]),
            )
            message_id = cursor.lastrowid
        window = context_window(preset["model"])
        yield sse(
            "done",
            {
                "message_id": message_id,
                "usage": {
                    "input_tokens": final_result.input_tokens,
                    "output_tokens": final_result.output_tokens,
                    "cache_read_tokens": final_result.cache_read_tokens,
                    "cache_write_tokens": final_result.cache_write_tokens,
                    "context_pct": round(final_result.input_tokens / window, 6),
                },
            },
        )
        try:
            record_usage_log(context, final_result, completed_at)
        except Exception:
            LOGGER.exception("Usage log insertion failed")
        try:
            title = generate_conversation_title(context, final_result.text)
            if title:
                with connection() as conn:
                    conn.execute(
                        "UPDATE conversations SET title = ? WHERE id = ?",
                        (title, context["conversation_id"]),
                    )
        except Exception:
            LOGGER.exception("Conversation title generation failed")
    except Exception as error:
        LOGGER.exception("Chat request failed")
        yield sse("error", {"message": str(error)})


def phase_status():
    return {"implemented": True, "phase": 2, "message": "LLM streaming is ready."}
