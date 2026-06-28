import json
import logging
import random
import re
import threading
import time
from contextlib import contextmanager
from pathlib import Path

import httpx

from db import connection


LOGGER = logging.getLogger(__name__)
PROTOCOL_VERSION = "2025-03-26"
CACHE_SECONDS = 300
_CACHE_LOCK = threading.Lock()
_TOOL_CACHE = {"expires": 0, "tools": [], "routes": {}}
_TODAY_MEMORY_CACHE = {"expires": 0, "value": None}
_BUCKET_CACHE = {"expires": 0, "value": None}
_BUCKET_CACHE_LOCK = threading.Lock()
_BUCKET_CACHE_FILE = Path(__file__).resolve().parent / "data" / "memory_buckets_cache.json"
_ARCHIVE_CACHE = {"expires": 0, "value": None}
_TREND_CACHE = {"expires": 0, "value": None}
_MEMORY_RESOURCE_CACHE_LOCK = threading.Lock()


class MCPError(RuntimeError):
    pass


def _enabled_servers():
    with connection() as conn:
        return [
            dict(row)
            for row in conn.execute(
                "SELECT * FROM mcp_servers WHERE enabled = 1 ORDER BY id"
            ).fetchall()
        ]


def _auth_headers(auth):
    if not auth:
        return {}
    auth = auth.strip()
    if not auth:
        return {}
    if auth.startswith("{"):
        value = json.loads(auth)
        if not isinstance(value, dict):
            raise MCPError("MCP auth JSON must be an object.")
        return {str(key): str(item) for key, item in value.items()}
    if auth.lower().startswith(("bearer ", "basic ")):
        return {"Authorization": auth}
    return {"Authorization": f"Bearer {auth}"}


def _parse_sse(response):
    text = response.content.decode("utf-8")
    data_lines = []
    for line in text.replace("\r\n", "\n").split("\n"):
        if not line:
            if data_lines:
                return json.loads("\n".join(data_lines))
        elif line.startswith("data:"):
            data_lines.append(line[5:].strip())
    if data_lines:
        return json.loads("\n".join(data_lines))
    if response.headers.get("content-type", "").startswith("application/json"):
        return response.json()
    return None


class MCPSession:
    def __init__(self, server):
        self.server = server
        self.client = httpx.Client(
            timeout=httpx.Timeout(120.0, connect=20.0),
            follow_redirects=True,
        )
        self.session_id = None
        self.next_id = 1
        self.base_headers = {
            "Accept": "application/json, text/event-stream",
            "Content-Type": "application/json",
            **_auth_headers(server.get("auth")),
        }

    def _headers(self):
        headers = dict(self.base_headers)
        if self.session_id:
            headers["mcp-session-id"] = self.session_id
        return headers

    def _post(self, payload, expect_response=True):
        response = self.client.post(
            self.server["url"], headers=self._headers(), json=payload
        )
        if response.status_code >= 400:
            raise MCPError(
                f"{self.server['name']} returned HTTP {response.status_code}: "
                f"{response.text[:500]}"
            )
        if response.headers.get("mcp-session-id"):
            self.session_id = response.headers["mcp-session-id"]
        if not expect_response or not response.content:
            return None
        message = _parse_sse(response)
        if message and message.get("error"):
            error = message["error"]
            raise MCPError(error.get("message", str(error)))
        return message

    def open(self):
        message = self._post(
            {
                "jsonrpc": "2.0",
                "id": self.next_id,
                "method": "initialize",
                "params": {
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": {},
                    "clientInfo": {"name": "cheng-backend", "version": "0.3"},
                },
            }
        )
        self.next_id += 1
        if not message or "result" not in message:
            raise MCPError(f"{self.server['name']} initialize returned no result.")
        self._post(
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            expect_response=False,
        )
        return self

    def request(self, method, params=None):
        request_id = self.next_id
        self.next_id += 1
        message = self._post(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "method": method,
                "params": params or {},
            }
        )
        if not message or message.get("id") != request_id:
            raise MCPError(f"{self.server['name']} returned an invalid response.")
        return message.get("result")

    def close(self):
        try:
            if self.session_id:
                self.client.delete(self.server["url"], headers=self._headers())
        except Exception:
            LOGGER.debug("MCP session cleanup failed", exc_info=True)
        finally:
            self.client.close()


@contextmanager
def _session(server):
    session = MCPSession(server)
    try:
        yield session.open()
    finally:
        session.close()


def refresh_tools(force=False):
    now = time.monotonic()
    with _CACHE_LOCK:
        if not force and _TOOL_CACHE["expires"] > now:
            return list(_TOOL_CACHE["tools"])
        tools = []
        routes = {}
        for server in _enabled_servers():
            try:
                with _session(server) as session:
                    result = session.request("tools/list")
                for tool in (result or {}).get("tools", []):
                    name = tool.get("name")
                    if not name or name in routes:
                        LOGGER.warning(
                            "Skipping duplicate MCP tool %s from %s",
                            name,
                            server["name"],
                        )
                        continue
                    tools.append(tool)
                    routes[name] = server
            except Exception:
                LOGGER.exception("MCP tools/list failed for %s", server["name"])
        _TOOL_CACHE.update(
            {"expires": now + CACHE_SECONDS, "tools": tools, "routes": routes}
        )
        return list(tools)


def get_tools():
    return refresh_tools()


def get_tool_server_name(tool_name):
    routes = _TOOL_CACHE.get("routes", {})
    server = routes.get(tool_name)
    return server["name"] if server else "mcp"


def _extract_tool_value(result):
    if not result:
        return None
    if result.get("isError"):
        text = "\n".join(
            item.get("text", "")
            for item in result.get("content", [])
            if item.get("type") == "text"
        )
        raise MCPError(text or "MCP tool returned an error.")
    structured = result.get("structuredContent")
    if isinstance(structured, dict) and "result" in structured:
        value = structured["result"]
    else:
        value = "\n".join(
            item.get("text", "")
            for item in result.get("content", [])
            if item.get("type") == "text"
        )
    if isinstance(value, str):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return value
    return value


def call_tool(name, arguments):
    refresh_tools()
    server = _TOOL_CACHE["routes"].get(name)
    if not server:
        refresh_tools(force=True)
        server = _TOOL_CACHE["routes"].get(name)
    if not server:
        raise MCPError(f"No enabled MCP server provides tool '{name}'.")
    with _session(server) as session:
        result = session.request(
            "tools/call", {"name": name, "arguments": arguments or {}}
        )
    return _extract_tool_value(result)


def _bucket_records(raw):
    records = []
    seen = set()
    line_pattern = re.compile(
        r"\[bucket_id:([^\]]+)\]\s*(.*?)\s*\|\s*主题:(.*?)\s*\|\s*"
        r"V([\d.]+)/A([\d.]+)\s*\|\s*(重要|权重):([\d.]+)\s*\|\s*"
        r"更新:(\d{4}-\d{2}-\d{2})"
    )
    pulse_pattern = re.compile(
        r"\[(.*?)\]\s+bucket_id:([^\s]+)\s+主题:(.*?)\s+"
        r"情感:V([\d.]+)/A([\d.]+)\s+重要:(\d+)\s+权重:([\d.]+).*?"
        r"updated_at:(\d{4}-\d{2}-\d{2})(?:\s+标签:(.*))?$"
    )
    for line in str(raw).splitlines():
        match = line_pattern.search(line)
        if match:
            bucket_id, name, domain, valence, arousal, metric, score, updated = (
                match.groups()
            )
            if bucket_id not in seen:
                records.append(
                    {
                        "id": bucket_id,
                        "name": name.strip(),
                        "domain": [
                            item.strip() for item in domain.split(",") if item.strip()
                        ],
                        "valence": float(valence),
                        "arousal": float(arousal),
                        metric: float(score),
                        "updated_at": updated,
                    }
                )
                seen.add(bucket_id)
            continue
        match = pulse_pattern.search(line)
        if match:
            name, bucket_id, domain, valence, arousal, importance, weight, updated, tags = (
                match.groups()
            )
            if bucket_id not in seen:
                records.append(
                    {
                        "id": bucket_id,
                        "name": name.strip(),
                        "domain": [
                            item.strip() for item in domain.split(",") if item.strip()
                        ],
                        "valence": float(valence),
                        "arousal": float(arousal),
                        "importance": int(importance),
                        "weight": float(weight),
                        "updated_at": updated,
                        "tags": [
                            item.strip()
                            for item in (tags or "").split(",")
                            if item.strip()
                        ],
                    }
                )
                seen.add(bucket_id)
    return records


def _bucket_json_records(raw):
    records = {}
    pattern = re.compile(
        r"\[bucket_id:([^\]]+)\][^\n]*\n```json\s*(\{.*?\})\s*```",
        re.S,
    )
    for bucket_id, payload in pattern.findall(str(raw)):
        try:
            value = json.loads(payload)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            records[bucket_id] = value
    return records


def memory_buckets(force=False):
    now = time.monotonic()
    with _BUCKET_CACHE_LOCK:
        if not force and _BUCKET_CACHE["value"] and _BUCKET_CACHE["expires"] > now:
            return _BUCKET_CACHE["value"]
        if (
            not force
            and _BUCKET_CACHE_FILE.exists()
            and time.time() - _BUCKET_CACHE_FILE.stat().st_mtime < 60
        ):
            try:
                value = json.loads(_BUCKET_CACHE_FILE.read_text(encoding="utf-8"))
                _BUCKET_CACHE.update({"expires": now + 60, "value": value})
                return value
            except (OSError, json.JSONDecodeError):
                LOGGER.warning("Ignoring invalid shared bucket cache", exc_info=True)
    pulse = call_tool("pulse", {"show_all": True})
    breath = call_tool(
        "breath",
        {"mode": "summary", "max_results": 100, "include_dormant": True},
    )
    buckets = _bucket_records(pulse)
    by_id = {item["id"]: item for item in buckets}
    for item in _bucket_records(breath):
        by_id.setdefault(item["id"], item)
    result = {
        "buckets": list(by_id.values()),
        "count": len(by_id),
        "pulse": pulse,
        "breath": breath,
    }
    with _BUCKET_CACHE_LOCK:
        _BUCKET_CACHE.update({"expires": now + 60, "value": result})
        try:
            _BUCKET_CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
            temporary = _BUCKET_CACHE_FILE.with_suffix(".tmp")
            temporary.write_text(
                json.dumps(result, ensure_ascii=False), encoding="utf-8"
            )
            temporary.replace(_BUCKET_CACHE_FILE)
        except OSError:
            LOGGER.warning("Unable to write shared bucket cache", exc_info=True)
    return result


def memory_today():
    now = time.monotonic()
    if _TODAY_MEMORY_CACHE["expires"] > now:
        return _TODAY_MEMORY_CACHE["value"]
    buckets = memory_buckets()["buckets"]
    eligible = [
        item for item in buckets if float(item.get("importance") or 0) >= 6
    ]
    if not eligible:
        return None
    narrative = [
        item for item in eligible if 6 <= float(item.get("importance") or 0) < 8
    ] or eligible
    random.shuffle(narrative)
    value = None
    for item in narrative[:6]:
        raw = call_tool(
            "breath",
            {
                "query": item["name"],
                "mode": "summary",
                "max_results": 10,
                "include_dormant": True,
            },
        )
        detail = _bucket_json_records(raw).get(item["id"], {})
        value = str(detail.get("summary") or "").strip()
        if not value:
            facts = detail.get("core_facts") or []
            value = "；".join(
                str(fact).strip() for fact in facts[:2] if str(fact).strip()
            )
        if value:
            break
    if not value:
        return None
    _TODAY_MEMORY_CACHE.update({"expires": now + 600, "value": value})
    return value


def memory_archives():
    now = time.monotonic()
    with _MEMORY_RESOURCE_CACHE_LOCK:
        if _ARCHIVE_CACHE["value"] and _ARCHIVE_CACHE["expires"] > now:
            return _ARCHIVE_CACHE["value"]
    raw = call_tool(
        "breath",
        {
            "domain": "session",
            "mode": "summary",
            "max_results": 100,
            "include_dormant": True,
        },
    )
    archives = []
    pattern = re.compile(
        r"\[session\]\s+\[bucket_id:([^\]]+)\]\s+([^\n]+)\n(.*?)(?=\n---\n\[session\]|\Z)",
        re.S,
    )
    for bucket_id, name, content in pattern.findall(str(raw)):
        summary_match = re.search(
            r"## Summary\s*\n(.*?)(?=\n## |\Z)", content, re.S
        )
        highlights_match = re.search(
            r"## Highlights\s*\n(.*?)(?=\n## |\Z)", content, re.S
        )
        mood_match = re.search(r"## Mood\s*\n(.*?)(?=\n## |\Z)", content, re.S)
        archives.append(
            {
                "id": bucket_id,
                "name": name.strip(),
                "date": (
                    re.search(r"session_(\d{4}-\d{2}-\d{2})", name).group(1)
                    if re.search(r"session_(\d{4}-\d{2}-\d{2})", name)
                    else None
                ),
                "summary": (
                    summary_match.group(1).strip() if summary_match else content.strip()
                ),
                "highlights": (
                    highlights_match.group(1).strip() if highlights_match else ""
                ),
                "mood": mood_match.group(1).strip() if mood_match else "",
            }
        )
    result = {"archives": archives, "count": len(archives), "raw": raw}
    with _MEMORY_RESOURCE_CACHE_LOCK:
        _ARCHIVE_CACHE.update({"expires": now + 60, "value": result})
    return result


def memory_emotion_trend():
    now = time.monotonic()
    with _MEMORY_RESOURCE_CACHE_LOCK:
        if _TREND_CACHE["value"] and _TREND_CACHE["expires"] > now:
            return _TREND_CACHE["value"]
    raw = call_tool(
        "breath",
        {"emotion_trend": True, "recent_days": 30, "max_results": 100},
    )
    match = re.search(r"emotion_history:\s*(\[[^\n]*\])", str(raw))
    points = json.loads(match.group(1)) if match else []
    result = {"points": points, "count": len(points), "raw": raw}
    with _MEMORY_RESOURCE_CACHE_LOCK:
        _TREND_CACHE.update({"expires": now + 60, "value": result})
    return result


def warm_tools_async():
    def warm():
        try:
            refresh_tools(force=True)
        except Exception:
            LOGGER.exception("Initial MCP tool refresh failed")

    threading.Thread(target=warm, name="mcp-tool-warmup", daemon=True).start()


def phase_status():
    return {
        "implemented": True,
        "phase": 3,
        "message": "MCP Streamable HTTP client is ready.",
        "tools": [tool["name"] for tool in get_tools()],
    }
