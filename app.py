import json
import hmac
import logging
import mimetypes
import os
import re
import secrets
import sqlite3
import threading
from datetime import date, datetime, timedelta
from pathlib import Path
from urllib.parse import urlparse

import httpx

logging.basicConfig(level=logging.INFO)
logging.getLogger().setLevel(logging.INFO)

from flask import Flask, Response, jsonify, request, send_from_directory, stream_with_context
from flask_cors import CORS
from werkzeug.utils import secure_filename

from db import CHINA_TZ, connection, init_db, now_iso, parse_attachments, rows_to_dicts
from llm import (
    ChatSetupError,
    chat_events,
    generate_home_summary,
    load_chat_context,
    load_edit_context,
    load_regeneration_context,
    short_completion,
)
from mcp_client import (
    memory_archives,
    memory_bucket_detail,
    memory_buckets,
    memory_emotion_trend,
    memory_today,
    phase_status as mcp_phase_status,
    warm_tools_async,
)


BASE_DIR = Path(__file__).resolve().parent
UPLOAD_DIR = (BASE_DIR.parent / "frontend" / "uploads").resolve()
BOOK_DIR = BASE_DIR / "data" / "books"
DATA_DIR = BASE_DIR / "data"
UPLOAD_SIGNING_SECRET_FILE = DATA_DIR / "upload_signing_secret"
UPLOAD_URL_TTL_SECONDS = 7 * 24 * 60 * 60
MONTH_PATTERN = re.compile(r"^\d{4}-\d{2}$")
BOOK_CHAPTER_PATTERN = re.compile(
    r"(?im)^(第[0-9一二三四五六七八九十百千万零〇两]+[章节回卷部篇].*|Chapter\s+\d+.*)$"
)

app = Flask(__name__)
cors_origins = [
    origin.strip()
    for origin in os.environ.get("CHENG_CORS_ORIGINS", "https://allfortingting.xyz").split(",")
    if origin.strip() and origin.strip() != "*"
]
CORS(app, origins=cors_origins)
app.config["MAX_CONTENT_LENGTH"] = 25 * 1024 * 1024


def load_upload_signing_secret():
    secret = os.environ.get("UPLOAD_SIGNING_SECRET")
    if secret:
        return secret.encode("utf-8")
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if UPLOAD_SIGNING_SECRET_FILE.exists():
        return UPLOAD_SIGNING_SECRET_FILE.read_text(encoding="utf-8").strip().encode("utf-8")
    secret = secrets.token_urlsafe(48)
    UPLOAD_SIGNING_SECRET_FILE.write_text(secret, encoding="utf-8")
    return secret.encode("utf-8")


UPLOAD_SIGNING_SECRET = load_upload_signing_secret()
SUMMARY_JOBS = set()
SUMMARY_LOCK = threading.Lock()


@app.before_request
def require_api_token():
    if not request.path.startswith("/api/") or request.method == "OPTIONS":
        return None
    expected = os.environ.get("CHENG_API_TOKEN", "")
    authorization = request.headers.get("Authorization", "")
    supplied = (
        authorization[7:].strip()
        if authorization.lower().startswith("bearer ")
        else ""
    )
    if not expected or not supplied or not hmac.compare_digest(supplied, expected):
        return (
            jsonify(
                {
                    "error": "Unauthorized",
                    "message": "A valid Bearer token is required.",
                }
            ),
            401,
        )
    return None


def payload():
    return request.get_json(silent=True) or {}


def not_found(resource):
    return jsonify({"error": f"{resource} not found"}), 404


def bad_request(message):
    return jsonify({"error": message}), 400


def upload_signature(filename, expires_at):
    payload_value = f"{filename}\n{int(expires_at)}".encode("utf-8")
    return hmac.new(UPLOAD_SIGNING_SECRET, payload_value, "sha256").hexdigest()


def signed_upload_url(path, ttl=UPLOAD_URL_TTL_SECONDS):
    raw_path = str(path or "")
    prefix = "/uploads/"
    if not raw_path.startswith(prefix):
        return raw_path
    filename = raw_path[len(prefix):].replace("\\", "/")
    expires_at = int(datetime.now(CHINA_TZ).timestamp()) + int(ttl)
    signature = upload_signature(filename, expires_at)
    return f"{prefix}{filename}?exp={expires_at}&sig={signature}"


def valid_upload_signature(filename):
    try:
        expires_at = int(request.args.get("exp") or 0)
    except (TypeError, ValueError):
        return False
    if expires_at < int(datetime.now(CHINA_TZ).timestamp()):
        return False
    supplied = str(request.args.get("sig") or "")
    expected = upload_signature(filename.replace("\\", "/"), expires_at)
    return bool(supplied) and hmac.compare_digest(supplied, expected)


def upload_bearer_authorized():
    expected = os.environ.get("CHENG_API_TOKEN", "")
    authorization = request.headers.get("Authorization", "")
    supplied = (
        authorization[7:].strip()
        if authorization.lower().startswith("bearer ")
        else ""
    )
    return bool(expected and supplied and hmac.compare_digest(supplied, expected))


def sign_attachment_item(item):
    if not isinstance(item, dict):
        return item
    signed = dict(item)
    path = signed.get("path")
    if path and str(path).startswith("/uploads/"):
        signed["url"] = signed_upload_url(path)
    return signed


def sign_attachments(items):
    if not isinstance(items, list):
        return items
    return [sign_attachment_item(item) for item in items]


def mask_api_key(value):
    value = str(value or "")
    if not value:
        return ""
    return f"••••{value[-4:]}"


def looks_masked_api_key(value):
    value = str(value or "").strip()
    return value.startswith("•") or bool(re.fullmatch(r"[*•]+.{0,8}", value))


def mask_preset(row):
    item = dict(row)
    key = item.get("api_key") or ""
    item["has_api_key"] = bool(key)
    item["api_key"] = mask_api_key(key) if key else ""
    return item


def row_or_none(conn, query, values=()):
    row = conn.execute(query, values).fetchone()
    return dict(row) if row else None


def today_china():
    return datetime.now(CHINA_TZ).date()


def parse_iso_day(value, field="date"):
    try:
        return date.fromisoformat(str(value))
    except (TypeError, ValueError) as error:
        raise ValueError(f"{field} must use YYYY-MM-DD.") from error


def normalize_month(value):
    month = str(value or today_china().strftime("%Y-%m")).strip()
    if not MONTH_PATTERN.match(month):
        raise ValueError("month must use YYYY-MM.")
    parse_iso_day(f"{month}-01", "month")
    return month


def queue_home_summary(conversation_id):
    if not conversation_id:
        return
    with SUMMARY_LOCK:
        if conversation_id in SUMMARY_JOBS:
            return
        SUMMARY_JOBS.add(conversation_id)

    def worker():
        try:
            generate_home_summary(conversation_id)
        except Exception:
            app.logger.exception("Background conversation summary generation failed")
        finally:
            with SUMMARY_LOCK:
                SUMMARY_JOBS.discard(conversation_id)

    threading.Thread(target=worker, daemon=True).start()


def month_range(month):
    start = parse_iso_day(f"{month}-01", "month")
    if start.month == 12:
        end = start.replace(year=start.year + 1, month=1)
    else:
        end = start.replace(month=start.month + 1)
    return start.isoformat(), end.isoformat()


def parse_timestamp(value):
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value))
    except ValueError:
        return None
    if parsed.tzinfo:
        return parsed.astimezone(CHINA_TZ)
    return parsed.replace(tzinfo=CHINA_TZ)


def export_date_key(value):
    parsed = parse_timestamp(value)
    if parsed:
        return parsed.date().isoformat()
    match = re.match(r"^(\d{4}-\d{2}-\d{2})", str(value or ""))
    return match.group(1) if match else ""


def export_date_label(value):
    key = export_date_key(value)
    if not key:
        return ""
    try:
        day = date.fromisoformat(key)
    except ValueError:
        return key
    today = today_china()
    if day == today:
        return "今天"
    if day == today - timedelta(days=1):
        return "昨天"
    month_day = f"{day.month}月{day.day}日"
    return month_day if day.year == today.year else f"{day.year}年{month_day}"


def export_timestamp(value):
    parsed = parse_timestamp(value)
    if parsed:
        return parsed.strftime("%Y-%m-%d %H:%M")
    return str(value or "")[:16].replace("T", " ")


def export_range_bounds(data):
    date_range = str(data.get("date_range") or "all").strip()
    if date_range not in {"all", "7d", "30d", "custom"}:
        raise ValueError("date_range must be all, 7d, 30d, or custom.")
    if date_range == "all":
        return date_range, None, None
    today = today_china()
    if date_range == "7d":
        start_day = today - timedelta(days=6)
        end_day = today
    elif date_range == "30d":
        start_day = today - timedelta(days=29)
        end_day = today
    else:
        start_day = parse_iso_day(data.get("start_date"), "start_date")
        end_day = parse_iso_day(data.get("end_date"), "end_date")
        if start_day > end_day:
            raise ValueError("start_date cannot be later than end_date.")
    start = datetime.combine(start_day, datetime.min.time(), tzinfo=CHINA_TZ)
    end = datetime.combine(end_day + timedelta(days=1), datetime.min.time(), tzinfo=CHINA_TZ)
    return date_range, start.isoformat(timespec="seconds"), end.isoformat(timespec="seconds")


def append_date_filter(sql, values, column, start_at, end_at):
    if start_at:
        sql += f" AND {column} >= ?"
        values.append(start_at)
    if end_at:
        sql += f" AND {column} < ?"
        values.append(end_at)
    return sql, values


def attachment_placeholders(raw):
    if not raw:
        return []
    try:
        attachments = json.loads(raw) if isinstance(raw, str) else raw
    except (TypeError, ValueError):
        return []
    if not isinstance(attachments, list):
        return []
    placeholders = []
    for item in attachments:
        if not isinstance(item, dict):
            continue
        path = str(item.get("path") or "")
        name = str(item.get("name") or Path(path).name or "附件")
        is_image = item.get("type") == "image" or str(item.get("mime_type") or "").startswith("image/")
        placeholders.append(f"[{'图片' if is_image else '附件'}: {name}]")
    return placeholders


def attachment_items(raw):
    if not raw:
        return []
    try:
        attachments = json.loads(raw) if isinstance(raw, str) else raw
    except (TypeError, ValueError):
        return []
    return sign_attachments(attachments) if isinstance(attachments, list) else []


def filter_attachments(raw, kind):
    items = []
    for item in attachment_items(raw):
        if not isinstance(item, dict):
            continue
        item_type = str(item.get("type") or "")
        mime = str(item.get("mime_type") or "")
        is_image = item_type == "image" or mime.startswith("image/")
        if kind == "image" and is_image:
            items.append(item)
        elif kind == "file" and not is_image:
            items.append(item)
    return items


def normalize_export_options(data):
    scope = str(data.get("scope") or "current").strip()
    if scope not in {"current", "all"}:
        raise ValueError("scope must be current or all.")
    fmt = str(data.get("format") or "md").strip().lower()
    if fmt not in {"md", "txt"}:
        raise ValueError("format must be md or txt.")
    raw_types = data.get("content_types") or []
    if not isinstance(raw_types, list):
        raise ValueError("content_types must be an array.")
    content_types = []
    for item in raw_types:
        value = str(item).strip()
        if value not in {"chat", "annotations"}:
            raise ValueError("content_types may only include chat or annotations.")
        if value not in content_types:
            content_types.append(value)
    if not content_types:
        raise ValueError("Choose at least one content type.")
    conversation_id = None
    if "chat" in content_types and scope == "current":
        try:
            conversation_id = int(data.get("conversation_id"))
        except (TypeError, ValueError) as error:
            raise ValueError("conversation_id is required when exporting current chat.") from error
    date_range, start_at, end_at = export_range_bounds(data)
    return {
        "scope": scope,
        "conversation_id": conversation_id,
        "content_types": content_types,
        "date_range": date_range,
        "start_at": start_at,
        "end_at": end_at,
        "format": fmt,
    }


def load_export_chats(conn, options):
    if "chat" not in options["content_types"]:
        return []
    conversations = []
    if options["scope"] == "current":
        conversation = row_or_none(
            conn,
            "SELECT * FROM conversations WHERE id = ?",
            (options["conversation_id"],),
        )
        if not conversation:
            raise LookupError("Conversation")
        conversations = [conversation]
    else:
        conversations = rows_to_dicts(
            conn.execute(
                "SELECT * FROM conversations ORDER BY created_at, id"
            ).fetchall()
        )
    results = []
    for conversation in conversations:
        sql = """
            SELECT * FROM messages
            WHERE conversation_id = ? AND deleted = 0
        """
        values = [conversation["id"]]
        sql, values = append_date_filter(
            sql, values, "created_at", options["start_at"], options["end_at"]
        )
        sql += " ORDER BY created_at, id"
        messages = rows_to_dicts(conn.execute(sql, values).fetchall())
        if messages:
            results.append({"conversation": conversation, "messages": messages})
    return results


def load_export_annotations(conn, options):
    if "annotations" not in options["content_types"]:
        return []
    sql = """
        SELECT
            b.id AS book_id,
            b.title AS book_title,
            a.paragraph_index,
            p.content AS paragraph_content,
            a.role,
            a.content,
            a.created_at
        FROM book_annotations a
        JOIN books b ON b.id = a.book_id
        LEFT JOIN book_paragraphs p
            ON p.book_id = a.book_id AND p.paragraph_index = a.paragraph_index
        WHERE 1 = 1
    """
    values = []
    sql, values = append_date_filter(
        sql, values, "a.created_at", options["start_at"], options["end_at"]
    )
    sql += " ORDER BY b.id, a.paragraph_index, a.created_at, a.id"
    return rows_to_dicts(conn.execute(sql, values).fetchall())


def render_chat_export(chat_groups, fmt):
    lines = []
    for group in chat_groups:
        conversation = group["conversation"]
        messages = group["messages"]
        title = conversation.get("title") or f"对话 {conversation.get('id')}"
        if fmt == "md":
            lines.extend([
                f"## {title}",
                "",
                f"- 创建：{export_timestamp(conversation.get('created_at'))}",
                f"- 更新：{export_timestamp(conversation.get('updated_at'))}",
                "",
            ])
        else:
            lines.extend([
                f"=== {title} ===",
                f"创建：{export_timestamp(conversation.get('created_at'))}",
                f"更新：{export_timestamp(conversation.get('updated_at'))}",
                "",
            ])
        previous_key = None
        for message in messages:
            key = export_date_key(message.get("created_at"))
            if key != previous_key:
                if previous_key:
                    lines.extend(["", "---" if fmt == "md" else "-" * 24, ""])
                label = export_date_label(message.get("created_at"))
                if fmt == "md":
                    lines.extend([f"### {label}", ""])
                else:
                    lines.extend([f"----- {label} -----", ""])
                previous_key = key
            role = "AI" if message.get("role") == "assistant" else "用户"
            timestamp = export_timestamp(message.get("created_at"))
            if fmt == "md":
                lines.append(f"**{role}** · {timestamp}")
            else:
                lines.append(f"{role} · {timestamp}")
            content = str(message.get("content") or "").strip()
            if content:
                lines.extend(["", content])
            placeholders = attachment_placeholders(message.get("attachments"))
            if placeholders:
                lines.extend(["", *placeholders])
            lines.append("")
        lines.append("")
    return lines


def render_annotations_export(rows, fmt):
    if not rows:
        return []
    lines = []
    current_book = None
    current_paragraph = None
    for row in rows:
        book_id = row.get("book_id")
        paragraph_index = row.get("paragraph_index")
        if book_id != current_book:
            if lines:
                lines.append("")
            title = row.get("book_title") or f"书籍 {book_id}"
            lines.extend([f"## 《{title}》" if fmt == "md" else f"=== 《{title}》 ===", ""])
            current_book = book_id
            current_paragraph = None
        if paragraph_index != current_paragraph:
            heading = f"段落 {int(paragraph_index or 0) + 1}"
            paragraph = str(row.get("paragraph_content") or "").strip()
            if fmt == "md":
                lines.extend([f"### {heading}", "", paragraph, ""])
            else:
                lines.extend([f"-- {heading} --", paragraph, ""])
            current_paragraph = paragraph_index
        role = "AI回复" if row.get("role") == "ai" else "用户批注"
        timestamp = export_timestamp(row.get("created_at"))
        if fmt == "md":
            lines.append(f"**{role}** · {timestamp}")
        else:
            lines.append(f"{role} · {timestamp}")
        lines.extend(["", str(row.get("content") or "").strip(), ""])
    return lines


def render_export_file(options, chat_groups, annotation_rows):
    fmt = options["format"]
    lines = [
        "# 澄 - 对话导出" if fmt == "md" else "澄 - 对话导出",
        "",
        f"导出时间：{export_timestamp(now_iso())}",
        f"范围：{options['date_range']}",
        "",
    ]
    if "chat" in options["content_types"]:
        chat_lines = render_chat_export(chat_groups, fmt)
        if chat_lines:
            lines.extend(["# 聊天记录" if fmt == "md" else "聊天记录", "", *chat_lines])
    if "annotations" in options["content_types"]:
        annotation_lines = render_annotations_export(annotation_rows, fmt)
        if annotation_lines:
            lines.extend(["# 伴读批注" if fmt == "md" else "伴读批注", "", *annotation_lines])
    if len(lines) <= 5:
        lines.append("没有符合条件的导出内容。")
    return "\n".join(lines).rstrip() + "\n"


def checkin_streak(conn):
    dates = {
        row["date"]
        for row in conn.execute(
            "SELECT date FROM checkins WHERE date <= ?",
            (today_china().isoformat(),),
        ).fetchall()
    }
    streak = 0
    cursor = today_china()
    while cursor.isoformat() in dates:
        streak += 1
        cursor -= timedelta(days=1)
    return streak


def nonnegative_float(value, field):
    if value in (None, ""):
        return 0.0
    try:
        number = float(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{field} must be a number.") from error
    if number < 0:
        raise ValueError(f"{field} cannot be negative.")
    return number


def nonnegative_int(value, field):
    if value in (None, ""):
        return 0
    try:
        number = int(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{field} must be an integer.") from error
    if number < 0:
        raise ValueError(f"{field} cannot be negative.")
    return number


def decode_text_bytes(raw):
    for encoding in ("utf-8-sig", "utf-8", "gb18030"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def split_book_chapters(text):
    source = str(text or "").strip()
    if not source:
        return [{"index": 1, "title": "全文", "content": ""}]
    matches = list(BOOK_CHAPTER_PATTERN.finditer(source))
    if not matches:
        return [{"index": 1, "title": "全文", "content": source}]

    chapters = []
    if matches[0].start() > 0:
        preface = source[: matches[0].start()].strip()
        if preface:
            chapters.append({"title": "序章", "content": preface})
    for index, match in enumerate(matches):
        next_start = matches[index + 1].start() if index + 1 < len(matches) else len(source)
        title = match.group(0).strip()[:120] or f"第{index + 1}章"
        content = source[match.end() : next_start].strip()
        chapters.append({"title": title, "content": content})
    return [
        {"index": index, **chapter}
        for index, chapter in enumerate(chapters or [{"title": "全文", "content": source}], 1)
    ]


def split_book_paragraphs(text):
    """按换行分段，去空段"""
    return [p.strip() for p in text.split("\n") if p.strip()]


def book_text(filename):
    path = BOOK_DIR / Path(filename).name
    if not path.exists():
        raise FileNotFoundError(filename)
    return path.read_text(encoding="utf-8")


@app.errorhandler(413)
def too_large(_error):
    return jsonify({"error": "File exceeds the 25 MB limit."}), 413


@app.errorhandler(sqlite3.IntegrityError)
def integrity_error(error):
    return jsonify({"error": "Database constraint failed.", "detail": str(error)}), 400


@app.get("/api/health")
def health():
    return jsonify({"status": "ok", "time": now_iso(), "phase": 3})


@app.get("/api/conversations")
def list_conversations():
    with connection() as conn:
        rows = conn.execute(
            "SELECT * FROM conversations ORDER BY updated_at DESC"
        ).fetchall()
    return jsonify(rows_to_dicts(rows))


@app.post("/api/conversations")
def create_conversation():
    data = payload()
    timestamp = now_iso()
    title = str(data.get("title") or "新对话").strip() or "新对话"
    with connection() as conn:
        cursor = conn.execute(
            """
            INSERT INTO conversations(title, created_at, updated_at, archived)
            VALUES (?, ?, ?, 0)
            """,
            (title, timestamp, timestamp),
        )
        result = row_or_none(
            conn, "SELECT * FROM conversations WHERE id = ?", (cursor.lastrowid,)
        )
    return jsonify(result), 201


@app.patch("/api/conversations/<int:conversation_id>")
def update_conversation(conversation_id):
    data = payload()
    allowed = {"title", "archived"}
    updates = {key: data[key] for key in allowed if key in data}
    if not updates:
        return bad_request("Provide title or archived.")
    if "title" in updates:
        updates["title"] = str(updates["title"]).strip()
        if not updates["title"]:
            return bad_request("title cannot be empty.")
    if "archived" in updates:
        updates["archived"] = int(bool(updates["archived"]))
    updates["updated_at"] = now_iso()
    assignment = ", ".join(f"{key} = ?" for key in updates)
    values = [*updates.values(), conversation_id]
    with connection() as conn:
        cursor = conn.execute(
            f"UPDATE conversations SET {assignment} WHERE id = ?", values
        )
        if cursor.rowcount == 0:
            return not_found("Conversation")
        result = row_or_none(
            conn, "SELECT * FROM conversations WHERE id = ?", (conversation_id,)
        )
    return jsonify(result)


@app.delete("/api/conversations/<int:conversation_id>")
def delete_conversation(conversation_id):
    with connection() as conn:
        if not row_or_none(
            conn, "SELECT id FROM conversations WHERE id = ?", (conversation_id,)
        ):
            return not_found("Conversation")
        conn.execute("DELETE FROM messages WHERE conversation_id = ?", (conversation_id,))
        conn.execute(
            "UPDATE usage_logs SET conversation_id = NULL WHERE conversation_id = ?",
            (conversation_id,),
        )
        cursor = conn.execute(
            "DELETE FROM conversations WHERE id = ?", (conversation_id,)
        )
    return jsonify({"deleted": True, "id": conversation_id})


@app.get("/api/conversations/<int:conversation_id>/messages")
def list_messages(conversation_id):
    with connection() as conn:
        if not row_or_none(
            conn, "SELECT id FROM conversations WHERE id = ?", (conversation_id,)
        ):
            return not_found("Conversation")
        rows = conn.execute(
            """
            SELECT * FROM messages
            WHERE conversation_id = ? AND deleted = 0
            ORDER BY created_at, id
            """,
            (conversation_id,),
        ).fetchall()
    messages = rows_to_dicts(rows)
    for message in messages:
        if message["attachments"]:
            message["attachments"] = attachment_items(message["attachments"])
    return jsonify(messages)


@app.patch("/api/messages/<int:message_id>")
def update_message(message_id):
    data = payload()
    allowed = {"content", "starred", "thinking", "thinking_seconds", "attachments"}
    updates = {key: data[key] for key in allowed if key in data}
    if not updates:
        return bad_request("No supported message fields were provided.")
    if "content" in updates and not str(updates["content"]).strip():
        return bad_request("content cannot be empty.")
    if "starred" in updates:
        updates["starred"] = int(bool(updates["starred"]))
    if "attachments" in updates:
        try:
            updates["attachments"] = parse_attachments(updates["attachments"])
        except (TypeError, ValueError):
            return bad_request("attachments must be valid JSON.")
    assignment = ", ".join(f"{key} = ?" for key in updates)
    with connection() as conn:
        cursor = conn.execute(
            f"UPDATE messages SET {assignment} WHERE id = ?",
            [*updates.values(), message_id],
        )
        if cursor.rowcount == 0:
            return not_found("Message")
        result = row_or_none(conn, "SELECT * FROM messages WHERE id = ?", (message_id,))
    if result["attachments"]:
        result["attachments"] = attachment_items(result["attachments"])
    return jsonify(result)


@app.delete("/api/messages/<int:message_id>")
def delete_message(message_id):
    with connection() as conn:
        cursor = conn.execute(
            "UPDATE messages SET deleted = 1 WHERE id = ?", (message_id,)
        )
        if cursor.rowcount == 0:
            return not_found("Message")
    return jsonify({"deleted": True, "id": message_id})


@app.get("/api/search")
def search():
    query = request.args.get("q", "").strip()
    search_type = request.args.get("type", "keyword")
    with connection() as conn:
        if search_type in {"all", "keyword"}:
            if not query:
                return jsonify([])
            rows = rows_to_dicts(
                conn.execute(
                    """
                    SELECT m.*, c.title AS conversation_title
                    FROM messages m
                    JOIN conversations c ON c.id = m.conversation_id
                    WHERE m.deleted = 0
                      AND (m.content LIKE ? OR m.attachments LIKE ?)
                    ORDER BY m.created_at DESC, m.id DESC
                    """,
                    (f"%{query}%", f"%{query}%"),
                ).fetchall()
            )
            groups = {}
            for row in rows:
                if row.get("attachments"):
                    row["attachments"] = attachment_items(row["attachments"])
                key = row["conversation_id"]
                group = groups.setdefault(
                    key,
                    {
                        "conversation_id": key,
                        "conversation_title": row.get("conversation_title") or "新对话",
                        "count": 0,
                        "preview": row,
                    },
                )
                group["count"] += 1
            return jsonify(list(groups.values()))

        if search_type == "keyword_detail":
            if not query:
                return jsonify([])
            try:
                conversation_id = int(request.args.get("conversation_id"))
            except (TypeError, ValueError):
                return bad_request("conversation_id is required.")
            rows = rows_to_dicts(
                conn.execute(
                    """
                    SELECT m.*, c.title AS conversation_title
                    FROM messages m
                    JOIN conversations c ON c.id = m.conversation_id
                    WHERE m.deleted = 0
                      AND m.conversation_id = ?
                      AND (m.content LIKE ? OR m.attachments LIKE ?)
                    ORDER BY m.created_at DESC, m.id DESC
                    """,
                    (conversation_id, f"%{query}%", f"%{query}%"),
                ).fetchall()
            )
            for row in rows:
                if row.get("attachments"):
                    row["attachments"] = attachment_items(row["attachments"])
            return jsonify(rows)

        if search_type in {"image", "file"}:
            rows = rows_to_dicts(
                conn.execute(
                    """
                    SELECT m.*, c.title AS conversation_title
                    FROM messages m
                    JOIN conversations c ON c.id = m.conversation_id
                    WHERE m.deleted = 0
                      AND m.attachments IS NOT NULL
                      AND (m.attachments LIKE ? OR m.attachments LIKE ?)
                    ORDER BY m.created_at DESC, m.id DESC
                    """,
                    (
                        f'%\"type\": \"{search_type}\"%',
                        f'%\"type\":\"{search_type}\"%',
                    ),
                ).fetchall()
            )
            results = []
            for row in rows:
                attachments = filter_attachments(row.get("attachments"), search_type)
                if not attachments:
                    continue
                row["attachments"] = attachments
                results.append(row)
            return jsonify(results)

        if search_type == "dates":
            try:
                month = normalize_month(request.args.get("month"))
            except ValueError as error:
                return bad_request(str(error))
            start, end = month_range(month)
            rows = rows_to_dicts(
                conn.execute(
                    """
                    SELECT substr(created_at, 1, 10) AS date,
                           COUNT(*) AS count,
                           COUNT(DISTINCT conversation_id) AS conversation_count
                    FROM messages
                    WHERE deleted = 0 AND created_at >= ? AND created_at < ?
                    GROUP BY substr(created_at, 1, 10)
                    ORDER BY date
                    """,
                    (start, end),
                ).fetchall()
            )
            return jsonify(rows)

        if search_type == "date":
            try:
                day = parse_iso_day(request.args.get("date"))
            except ValueError as error:
                return bad_request(str(error))
            start = day.isoformat()
            end = (day + timedelta(days=1)).isoformat()
            rows = rows_to_dicts(
                conn.execute(
                    """
                    SELECT m.*, c.title AS conversation_title
                    FROM messages m
                    JOIN conversations c ON c.id = m.conversation_id
                    WHERE m.deleted = 0 AND m.created_at >= ? AND m.created_at < ?
                    ORDER BY m.created_at, m.id
                    """,
                    (start, end),
                ).fetchall()
            )
            groups = {}
            for row in rows:
                key = row["conversation_id"]
                group = groups.setdefault(
                    key,
                    {
                        "conversation_id": key,
                        "conversation_title": row.get("conversation_title") or "新对话",
                        "count": 0,
                        "message_id": row["id"],
                        "created_at": row["created_at"],
                        "preview": row.get("content") or "",
                    },
                )
                group["count"] += 1
            return jsonify(list(groups.values()))

    return bad_request("type must be keyword, keyword_detail, image, file, dates, or date.")


def list_resource(table):
    with connection() as conn:
        rows = conn.execute(f"SELECT * FROM {table} ORDER BY id DESC").fetchall()
    return jsonify(rows_to_dicts(rows))


def delete_resource(table, resource_id, label):
    with connection() as conn:
        cursor = conn.execute(f"DELETE FROM {table} WHERE id = ?", (resource_id,))
        if cursor.rowcount == 0:
            return not_found(label)
    return jsonify({"deleted": True, "id": resource_id})


def model_list_url(endpoint, api_format):
    base = str(endpoint or "").strip().rstrip("/")
    if not base:
        raise ValueError("endpoint is required.")
    parsed = urlparse(base)
    host = parsed.hostname or ""
    if api_format == "openai" and host.endswith("openrouter.ai"):
        return f"{parsed.scheme or 'https'}://{parsed.netloc}/api/v1/models"
    if base.endswith("/v1/models"):
        return base
    if base.endswith("/models"):
        return base
    if base.endswith("/v1"):
        return f"{base}/models"
    return f"{base}/v1/models"


def normalize_model_rows(data):
    rows = data.get("data", data) if isinstance(data, dict) else data
    if not isinstance(rows, list):
        return []
    models = []
    for item in rows:
        if not isinstance(item, dict):
            continue
        model_id = str(item.get("id") or "").strip()
        if not model_id:
            continue
        models.append(
            {
                "id": model_id,
                "name": item.get("name") or item.get("display_name") or model_id,
                "created_at": item.get("created_at"),
                "context_length": item.get("context_length")
                or item.get("max_input_tokens"),
            }
        )
    return models


@app.get("/api/presets")
def list_presets():
    with connection() as conn:
        rows = conn.execute("SELECT * FROM api_presets ORDER BY id DESC").fetchall()
    return jsonify([mask_preset(row) for row in rows])


@app.post("/api/models/list")
def list_upstream_models():
    data = payload()
    api_format = data.get("format", "anthropic")
    if api_format not in {"anthropic", "openai"}:
        return bad_request("format must be anthropic or openai.")
    api_key = str(data.get("api_key") or "").strip()
    if not api_key:
        return bad_request("api_key is required.")
    try:
        url = model_list_url(data.get("endpoint"), api_format)
    except ValueError as error:
        return bad_request(str(error))
    parsed = urlparse(url)
    headers = {"Accept": "application/json"}
    if api_format == "anthropic" and (parsed.hostname or "").endswith("anthropic.com"):
        headers["x-api-key"] = api_key
        headers["anthropic-version"] = "2023-06-01"
    else:
        headers["Authorization"] = f"Bearer {api_key}"
        if api_format == "anthropic":
            headers["anthropic-version"] = "2023-06-01"
    try:
        with httpx.Client(timeout=httpx.Timeout(20.0, connect=10.0)) as client:
            response = client.get(url, headers=headers)
            response.raise_for_status()
            upstream = response.json()
    except Exception as error:
        return jsonify({"error": f"模型列表拉取失败：{error}"}), 502
    return jsonify({"models": normalize_model_rows(upstream)})


@app.post("/api/presets")
def create_preset():
    data = payload()
    required = ("name", "endpoint", "api_key", "model")
    if any(not str(data.get(key, "")).strip() for key in required):
        return bad_request("name, endpoint, api_key, and model are required.")
    api_format = data.get("format", "anthropic")
    if api_format not in {"anthropic", "openai"}:
        return bad_request("format must be anthropic or openai.")
    try:
        input_price = nonnegative_float(data.get("input_price"), "input_price")
        output_price = nonnegative_float(data.get("output_price"), "output_price")
    except ValueError as error:
        return bad_request(str(error))
    active = int(bool(data.get("active", False)))
    with connection() as conn:
        if active:
            conn.execute("UPDATE api_presets SET active = 0")
        cursor = conn.execute(
            """
            INSERT INTO api_presets(
                name, endpoint, api_key, model, format, active,
                input_price, output_price
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                data["name"].strip(),
                data["endpoint"].rstrip("/"),
                str(data["api_key"]).strip(),
                data["model"].strip(),
                api_format,
                active,
                input_price,
                output_price,
            ),
        )
        result = row_or_none(
            conn, "SELECT * FROM api_presets WHERE id = ?", (cursor.lastrowid,)
        )
    return jsonify(mask_preset(result)), 201


@app.patch("/api/presets/<int:resource_id>")
def update_preset(resource_id):
    data = payload()
    allowed = {
        "name",
        "endpoint",
        "api_key",
        "model",
        "format",
        "active",
        "input_price",
        "output_price",
    }
    updates = {key: data[key] for key in allowed if key in data}
    if not updates:
        return bad_request("No supported preset fields were provided.")
    if updates.get("format") not in {None, "anthropic", "openai"}:
        return bad_request("format must be anthropic or openai.")
    if "endpoint" in updates:
        updates["endpoint"] = str(updates["endpoint"]).rstrip("/")
    if "api_key" in updates:
        api_key = str(updates.get("api_key") or "").strip()
        if not api_key or looks_masked_api_key(api_key):
            updates.pop("api_key", None)
        else:
            updates["api_key"] = api_key
    for key in ("name", "model"):
        if key in updates:
            updates[key] = str(updates[key]).strip()
            if not updates[key]:
                return bad_request(f"{key} cannot be empty.")
    if "active" in updates:
        updates["active"] = int(bool(updates["active"]))
    try:
        for key in ("input_price", "output_price"):
            if key in updates:
                updates[key] = nonnegative_float(updates[key], key)
    except ValueError as error:
        return bad_request(str(error))
    with connection() as conn:
        if updates.get("active"):
            conn.execute("UPDATE api_presets SET active = 0")
        if not updates:
            result = row_or_none(
                conn, "SELECT * FROM api_presets WHERE id = ?", (resource_id,)
            )
            if not result:
                return not_found("Preset")
            return jsonify(mask_preset(result))
        assignment = ", ".join(f"{key} = ?" for key in updates)
        cursor = conn.execute(
            f"UPDATE api_presets SET {assignment} WHERE id = ?",
            [*updates.values(), resource_id],
        )
        if cursor.rowcount == 0:
            return not_found("Preset")
        result = row_or_none(
            conn, "SELECT * FROM api_presets WHERE id = ?", (resource_id,)
        )
    return jsonify(mask_preset(result))


@app.delete("/api/presets/<int:resource_id>")
def delete_preset(resource_id):
    return delete_resource("api_presets", resource_id, "Preset")


@app.get("/api/mcp_servers")
def list_mcp_servers():
    return list_resource("mcp_servers")


@app.post("/api/mcp_servers")
def create_mcp_server():
    data = payload()
    if not str(data.get("name", "")).strip() or not str(data.get("url", "")).strip():
        return bad_request("name and url are required.")
    with connection() as conn:
        cursor = conn.execute(
            "INSERT INTO mcp_servers(name, url, auth, enabled) VALUES (?, ?, ?, ?)",
            (
                data["name"].strip(),
                data["url"].strip(),
                data.get("auth"),
                int(bool(data.get("enabled", True))),
            ),
        )
        result = row_or_none(
            conn, "SELECT * FROM mcp_servers WHERE id = ?", (cursor.lastrowid,)
        )
    return jsonify(result), 201


@app.patch("/api/mcp_servers/<int:resource_id>")
def update_mcp_server(resource_id):
    data = payload()
    allowed = {"name", "url", "auth", "enabled"}
    updates = {key: data[key] for key in allowed if key in data}
    if not updates:
        return bad_request("No supported MCP server fields were provided.")
    if "enabled" in updates:
        updates["enabled"] = int(bool(updates["enabled"]))
    assignment = ", ".join(f"{key} = ?" for key in updates)
    with connection() as conn:
        cursor = conn.execute(
            f"UPDATE mcp_servers SET {assignment} WHERE id = ?",
            [*updates.values(), resource_id],
        )
        if cursor.rowcount == 0:
            return not_found("MCP server")
        result = row_or_none(
            conn, "SELECT * FROM mcp_servers WHERE id = ?", (resource_id,)
        )
    return jsonify(result)


@app.delete("/api/mcp_servers/<int:resource_id>")
def delete_mcp_server(resource_id):
    return delete_resource("mcp_servers", resource_id, "MCP server")


@app.get("/api/anniversaries")
def list_anniversaries():
    return list_resource("anniversaries")


@app.post("/api/anniversaries")
def create_anniversary():
    data = payload()
    if not str(data.get("name", "")).strip() or not str(data.get("date", "")).strip():
        return bad_request("name and date are required.")
    try:
        date.fromisoformat(data["date"])
    except ValueError:
        return bad_request("date must use YYYY-MM-DD.")
    with connection() as conn:
        cursor = conn.execute(
            "INSERT INTO anniversaries(name, date) VALUES (?, ?)",
            (data["name"].strip(), data["date"]),
        )
        result = row_or_none(
            conn, "SELECT * FROM anniversaries WHERE id = ?", (cursor.lastrowid,)
        )
    return jsonify(result), 201


@app.patch("/api/anniversaries/<int:resource_id>")
def update_anniversary(resource_id):
    data = payload()
    allowed = {"name", "date"}
    updates = {key: data[key] for key in allowed if key in data}
    if not updates:
        return bad_request("Provide name or date.")
    if "date" in updates:
        try:
            date.fromisoformat(updates["date"])
        except ValueError:
            return bad_request("date must use YYYY-MM-DD.")
    assignment = ", ".join(f"{key} = ?" for key in updates)
    with connection() as conn:
        cursor = conn.execute(
            f"UPDATE anniversaries SET {assignment} WHERE id = ?",
            [*updates.values(), resource_id],
        )
        if cursor.rowcount == 0:
            return not_found("Anniversary")
        result = row_or_none(
            conn, "SELECT * FROM anniversaries WHERE id = ?", (resource_id,)
        )
    return jsonify(result)


@app.delete("/api/anniversaries/<int:resource_id>")
def delete_anniversary(resource_id):
    return delete_resource("anniversaries", resource_id, "Anniversary")


@app.get("/api/checkins")
def list_checkins():
    try:
        month = normalize_month(request.args.get("month"))
    except ValueError as error:
        return bad_request(str(error))
    start, end = month_range(month)
    with connection() as conn:
        rows = conn.execute(
            """
            SELECT * FROM checkins
            WHERE date >= ? AND date < ?
            ORDER BY date
            """,
            (start, end),
        ).fetchall()
        streak = checkin_streak(conn)
    return jsonify({"month": month, "streak": streak, "checkins": rows_to_dicts(rows)})


@app.post("/api/checkins")
def create_checkin():
    data = payload()
    checkin_date = today_china().isoformat()
    note = str(data.get("note") or "").strip() or None
    timestamp = now_iso()
    with connection() as conn:
        existing = conn.execute(
            "SELECT id FROM checkins WHERE date = ?", (checkin_date,)
        ).fetchone()
        if existing:
            conn.execute(
                "UPDATE checkins SET note = ? WHERE id = ?",
                (note, existing["id"]),
            )
            status = 200
            checkin_id = existing["id"]
        else:
            cursor = conn.execute(
                "INSERT INTO checkins(date, note, created_at) VALUES (?, ?, ?)",
                (checkin_date, note, timestamp),
            )
            status = 201
            checkin_id = cursor.lastrowid
        result = row_or_none(conn, "SELECT * FROM checkins WHERE id = ?", (checkin_id,))
    return jsonify(result), status


@app.delete("/api/checkins/<int:resource_id>")
def delete_checkin(resource_id):
    return delete_resource("checkins", resource_id, "Checkin")


@app.get("/api/todos")
def list_todos():
    with connection() as conn:
        rows = conn.execute(
            """
            SELECT * FROM todos
            ORDER BY done ASC, due_date IS NULL, due_date ASC, created_at DESC, id DESC
            """
        ).fetchall()
    return jsonify(rows_to_dicts(rows))


@app.post("/api/todos")
def create_todo():
    data = payload()
    content = str(data.get("content") or "").strip()
    if not content:
        return bad_request("content is required.")
    due_date = data.get("due_date")
    if due_date in ("", None):
        due_date = None
    else:
        try:
            due_date = parse_iso_day(due_date, "due_date").isoformat()
        except ValueError as error:
            return bad_request(str(error))
    done = int(bool(data.get("done", False)))
    timestamp = now_iso()
    with connection() as conn:
        cursor = conn.execute(
            """
            INSERT INTO todos(content, due_date, done, created_at, done_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (content, due_date, done, timestamp, timestamp if done else None),
        )
        result = row_or_none(conn, "SELECT * FROM todos WHERE id = ?", (cursor.lastrowid,))
    return jsonify(result), 201


@app.patch("/api/todos/<int:resource_id>")
def update_todo(resource_id):
    data = payload()
    allowed = {"content", "due_date", "done"}
    updates = {key: data[key] for key in allowed if key in data}
    if not updates:
        return bad_request("No supported todo fields were provided.")
    if "content" in updates:
        updates["content"] = str(updates["content"]).strip()
        if not updates["content"]:
            return bad_request("content cannot be empty.")
    if "due_date" in updates:
        if updates["due_date"] in ("", None):
            updates["due_date"] = None
        else:
            try:
                updates["due_date"] = parse_iso_day(updates["due_date"], "due_date").isoformat()
            except ValueError as error:
                return bad_request(str(error))
    if "done" in updates:
        updates["done"] = int(bool(updates["done"]))
        updates["done_at"] = now_iso() if updates["done"] else None
    assignment = ", ".join(f"{key} = ?" for key in updates)
    with connection() as conn:
        cursor = conn.execute(
            f"UPDATE todos SET {assignment} WHERE id = ?",
            [*updates.values(), resource_id],
        )
        if cursor.rowcount == 0:
            return not_found("Todo")
        result = row_or_none(conn, "SELECT * FROM todos WHERE id = ?", (resource_id,))
    return jsonify(result)


@app.delete("/api/todos/<int:resource_id>")
def delete_todo(resource_id):
    return delete_resource("todos", resource_id, "Todo")


@app.get("/api/milestones")
def list_milestones():
    with connection() as conn:
        rows = conn.execute(
            "SELECT * FROM milestones ORDER BY date DESC, id DESC"
        ).fetchall()
    return jsonify(rows_to_dicts(rows))


@app.post("/api/milestones")
def create_milestone():
    data = payload()
    title = str(data.get("title") or "").strip()
    if not title or not str(data.get("date") or "").strip():
        return bad_request("title and date are required.")
    try:
        milestone_date = parse_iso_day(data["date"]).isoformat()
    except ValueError as error:
        return bad_request(str(error))
    note = str(data.get("note") or "").strip() or None
    with connection() as conn:
        cursor = conn.execute(
            """
            INSERT INTO milestones(title, date, note, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (title, milestone_date, note, now_iso()),
        )
        result = row_or_none(
            conn, "SELECT * FROM milestones WHERE id = ?", (cursor.lastrowid,)
        )
    return jsonify(result), 201


@app.delete("/api/milestones/<int:resource_id>")
def delete_milestone(resource_id):
    return delete_resource("milestones", resource_id, "Milestone")


@app.get("/api/books")
def list_books():
    with connection() as conn:
        rows = conn.execute(
            """
            SELECT * FROM books
            ORDER BY COALESCE(last_read_at, created_at) DESC, id DESC
            """
        ).fetchall()
    return jsonify(rows_to_dicts(rows))


@app.post("/api/books")
def create_book():
    if "file" not in request.files:
        return bad_request("Multipart field 'file' is required.")
    file = request.files["file"]
    original_filename = secure_filename(file.filename or "")
    if not original_filename:
        return bad_request("A valid filename is required.")
    if not original_filename.lower().endswith(".txt"):
        return bad_request("Only .txt books are supported.")
    raw = file.read()
    text = decode_text_bytes(raw)
    chapters = split_book_chapters(text)
    paragraphs = split_book_paragraphs(text)
    timestamp = datetime.now(CHINA_TZ).strftime("%Y%m%d%H%M%S%f")
    stored_name = f"{timestamp}-{original_filename}"
    title = str(request.form.get("title") or Path(original_filename).stem).strip()
    BOOK_DIR.mkdir(parents=True, exist_ok=True)
    (BOOK_DIR / stored_name).write_text(text, encoding="utf-8")
    with connection() as conn:
        cursor = conn.execute(
            """
            INSERT INTO books(
                title, filename, original_filename, total_chars,
                total_chapters, total_paragraphs, total_pages,
                current_chapter, current_page, position, progress,
                created_at, last_read_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, 0, 0, ?, NULL)
            """,
            (
                title,
                stored_name,
                file.filename,
                len(text),
                len(chapters),
                len(paragraphs),
                1,
                now_iso(),
            ),
        )
        book_id = cursor.lastrowid
        conn.executemany(
            """
            INSERT INTO book_paragraphs(book_id, paragraph_index, page_number, content)
            VALUES (?, ?, 1, ?)
            """,
            [
                (book_id, index, paragraph)
                for index, paragraph in enumerate(paragraphs)
            ],
        )
        result = row_or_none(conn, "SELECT * FROM books WHERE id = ?", (book_id,))
    return jsonify(result), 201


@app.get("/api/books/<int:book_id>")
def get_book(book_id):
    with connection() as conn:
        book = row_or_none(conn, "SELECT * FROM books WHERE id = ?", (book_id,))
    if not book:
        return not_found("Book")
    try:
        chapters = split_book_chapters(book_text(book["filename"]))
    except FileNotFoundError:
        return jsonify({"error": "Book file is missing."}), 404
    current = max(1, min(int(book.get("current_chapter") or 1), len(chapters)))
    return jsonify(
        {
            "book": {**book, "total_chapters": len(chapters), "current_chapter": current},
            "chapter": chapters[current - 1],
        }
    )


@app.get("/api/books/<int:book_id>/pages/<int:page>")
def get_book_page(book_id, page):
    with connection() as conn:
        book = row_or_none(conn, "SELECT * FROM books WHERE id = ?", (book_id,))
        if not book:
            return not_found("Book")
        paragraphs = conn.execute(
            """
            SELECT paragraph_index, content FROM book_paragraphs
            WHERE book_id = ? AND page_number = ?
            ORDER BY paragraph_index
            """,
            (book_id, page),
        ).fetchall()
        annotations = conn.execute(
            """
            SELECT * FROM book_annotations
            WHERE book_id = ?
              AND paragraph_index IN (
                SELECT paragraph_index FROM book_paragraphs
                WHERE book_id = ? AND page_number = ?
              )
            ORDER BY paragraph_index, created_at
            """,
            (book_id, book_id, page),
        ).fetchall()
        conn.execute(
            "UPDATE books SET current_page = ?, last_read_at = ? WHERE id = ?",
            (page, now_iso(), book_id),
        )
    return jsonify(
        {
            "book_id": book_id,
            "page": page,
            "total_pages": book.get("total_pages") or 1,
            "paragraphs": rows_to_dicts(paragraphs),
            "annotations": rows_to_dicts(annotations),
        }
    )


@app.get("/api/books/<int:book_id>/all")
def get_book_all(book_id):
    with connection() as conn:
        book = row_or_none(conn, "SELECT * FROM books WHERE id = ?", (book_id,))
        if not book:
            return not_found("Book")
        paragraphs = conn.execute(
            """
            SELECT paragraph_index, content FROM book_paragraphs
            WHERE book_id = ?
            ORDER BY paragraph_index
            """,
            (book_id,),
        ).fetchall()
        annotations = conn.execute(
            """
            SELECT * FROM book_annotations
            WHERE book_id = ?
            ORDER BY paragraph_index, created_at
            """,
            (book_id,),
        ).fetchall()
    return jsonify(
        {
            "book": book,
            "paragraphs": rows_to_dicts(paragraphs),
            "annotations": rows_to_dicts(annotations),
        }
    )


@app.post("/api/books/<int:book_id>/annotations")
def create_annotation(book_id):
    data = payload()
    try:
        paragraph_index = int(data.get("paragraph_index"))
    except (TypeError, ValueError):
        return bad_request("paragraph_index must be a non-negative integer.")
    content = str(data.get("content") or "").strip()
    role = data.get("role", "user")
    if paragraph_index < 0:
        return bad_request("paragraph_index must be a non-negative integer.")
    if not content:
        return bad_request("paragraph_index and content are required.")
    if role not in ("user", "ai"):
        return bad_request("role must be 'user' or 'ai'.")
    with connection() as conn:
        book = row_or_none(conn, "SELECT * FROM books WHERE id = ?", (book_id,))
        if not book:
            return not_found("Book")
        cursor = conn.execute(
            """
            INSERT INTO book_annotations(book_id, paragraph_index, role, content, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (book_id, paragraph_index, role, content, now_iso()),
        )
        result = row_or_none(
            conn, "SELECT * FROM book_annotations WHERE id = ?", (cursor.lastrowid,)
        )
    return jsonify(result), 201


@app.post("/api/books/<int:book_id>/annotations/<int:paragraph_index>/ai-reply")
def ai_reply_annotation(book_id, paragraph_index):
    with connection() as conn:
        book = row_or_none(conn, "SELECT * FROM books WHERE id = ?", (book_id,))
        if not book:
            return not_found("Book")
        para = row_or_none(
            conn,
            """
            SELECT content FROM book_paragraphs
            WHERE book_id = ? AND paragraph_index = ?
            """,
            (book_id, paragraph_index),
        )
        if not para:
            return not_found("Paragraph")
        user_annos = conn.execute(
            """
            SELECT content FROM book_annotations
            WHERE book_id = ? AND paragraph_index = ? AND role = 'user'
            ORDER BY created_at
            """,
            (book_id, paragraph_index),
        ).fetchall()
        preset = conn.execute(
            "SELECT * FROM api_presets WHERE active = 1 ORDER BY id DESC LIMIT 1"
        ).fetchone()
        settings = {
            row["key"]: row["value"] or ""
            for row in conn.execute(
                """
                SELECT key, value FROM settings
                WHERE key IN ('system_prompt', 'profile')
                """
            ).fetchall()
        }
    if not preset:
        return jsonify({"error": "No active API preset is configured."}), 409
    system = "\n\n".join(
        value.strip()
        for value in (settings.get("system_prompt", ""), settings.get("profile", ""))
        if value.strip()
    )
    user_thoughts = "\n".join(a["content"] for a in user_annos).strip()
    prompt = (
        f"婷正在读《{book['title']}》，读到这段话：\n\n"
        f"“{para['content']}”\n\n"
        f"她的想法：{user_thoughts}\n\n"
        "请作为澄（她的伴侣），用简短温柔的方式回应她的想法。"
        "不要复述原文，直接回应。1-3句话即可。"
    )
    reply = short_completion(dict(preset), prompt, max_tokens=200, system=system).strip()
    with connection() as conn:
        cursor = conn.execute(
            """
            INSERT INTO book_annotations(book_id, paragraph_index, role, content, created_at)
            VALUES (?, ?, 'ai', ?, ?)
            """,
            (book_id, paragraph_index, reply, now_iso()),
        )
        result = row_or_none(
            conn, "SELECT * FROM book_annotations WHERE id = ?", (cursor.lastrowid,)
        )
    return jsonify(result), 201


@app.get("/api/books/<int:book_id>/annotations")
def list_annotations(book_id):
    with connection() as conn:
        book = row_or_none(conn, "SELECT * FROM books WHERE id = ?", (book_id,))
        if not book:
            return not_found("Book")
        rows = conn.execute(
            """
            SELECT * FROM book_annotations
            WHERE book_id = ?
            ORDER BY paragraph_index, created_at
            """,
            (book_id,),
        ).fetchall()
    return jsonify(rows_to_dicts(rows))


@app.post("/api/books/<int:book_id>/progress")
def update_book_progress(book_id):
    data = payload()
    try:
        scroll_pct = float(data.get("scroll_pct", 0))
    except (TypeError, ValueError):
        return bad_request("scroll_pct must be a number.")
    with connection() as conn:
        book = row_or_none(conn, "SELECT * FROM books WHERE id = ?", (book_id,))
        if not book:
            return not_found("Book")
        conn.execute(
            "UPDATE books SET progress = ?, last_read_at = ? WHERE id = ?",
            (round(scroll_pct, 2), now_iso(), book_id),
        )
    return jsonify({"ok": True})


@app.patch("/api/books/<int:book_id>")
def update_book(book_id):
    data = payload()
    allowed = {"title", "current_chapter", "current_page", "progress", "position"}
    updates = {key: data[key] for key in allowed if key in data}
    if not updates:
        return bad_request("No supported book fields were provided.")
    with connection() as conn:
        book = row_or_none(conn, "SELECT * FROM books WHERE id = ?", (book_id,))
        if not book:
            return not_found("Book")
        if "title" in updates:
            updates["title"] = str(updates["title"]).strip()
            if not updates["title"]:
                return bad_request("title cannot be empty.")
        try:
            if "current_chapter" in updates:
                chapter = nonnegative_int(updates["current_chapter"], "current_chapter")
                total = max(1, int(book.get("total_chapters") or 1))
                updates["current_chapter"] = max(1, min(chapter, total))
            if "current_page" in updates:
                page = nonnegative_int(updates["current_page"], "current_page")
                total = max(1, int(book.get("total_pages") or 1))
                updates["current_page"] = max(1, min(page, total))
            if "progress" in updates:
                updates["progress"] = min(1.0, nonnegative_float(updates["progress"], "progress"))
            if "position" in updates:
                updates["position"] = nonnegative_int(updates["position"], "position")
        except ValueError as error:
            return bad_request(str(error))
        updates["last_read_at"] = now_iso()
        assignment = ", ".join(f"{key} = ?" for key in updates)
        cursor = conn.execute(
            f"UPDATE books SET {assignment} WHERE id = ?",
            [*updates.values(), book_id],
        )
        if cursor.rowcount == 0:
            return not_found("Book")
        result = row_or_none(conn, "SELECT * FROM books WHERE id = ?", (book_id,))
    return jsonify(result)


@app.delete("/api/books/<int:book_id>")
def delete_book(book_id):
    with connection() as conn:
        book = row_or_none(conn, "SELECT * FROM books WHERE id = ?", (book_id,))
        if not book:
            return not_found("Book")
        conn.execute("DELETE FROM books WHERE id = ?", (book_id,))
    try:
        (BOOK_DIR / Path(book["filename"]).name).unlink(missing_ok=True)
    except OSError:
        app.logger.exception("Failed to delete book file")
    return jsonify({"deleted": True, "id": book_id})


@app.post("/api/export")
def export_data():
    try:
        options = normalize_export_options(payload())
    except ValueError as error:
        return bad_request(str(error))
    try:
        with connection() as conn:
            chat_groups = load_export_chats(conn, options)
            annotation_rows = load_export_annotations(conn, options)
    except LookupError:
        return not_found("Conversation")
    content = render_export_file(options, chat_groups, annotation_rows)
    timestamp = datetime.now(CHINA_TZ).strftime("%Y%m%d-%H%M%S")
    filename = (
        f"cheng-export-{options['scope']}-{options['date_range']}-"
        f"{timestamp}.{options['format']}"
    )
    content_type = "text/markdown; charset=utf-8" if options["format"] == "md" else "text/plain; charset=utf-8"
    return Response(
        content,
        content_type=content_type,
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


@app.get("/api/usage/summary")
def usage_summary():
    today_prefix = today_china().isoformat()

    def totals(conn, where="", values=()):
        row = conn.execute(
            f"""
            SELECT COUNT(*) AS rounds,
                   COALESCE(SUM(input_tokens), 0) AS input_tokens,
                   COALESCE(SUM(output_tokens), 0) AS output_tokens,
                   COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
                   COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
                   COALESCE(SUM(cost), 0) AS cost
            FROM usage_logs
            {where}
            """,
            values,
        ).fetchone()
        return dict(row)

    with connection() as conn:
        return jsonify(
            {
                "today": totals(conn, "WHERE created_at LIKE ?", (f"{today_prefix}%",)),
                "total": totals(conn),
            }
        )


@app.get("/api/usage/detail")
def usage_detail():
    try:
        days = int(request.args.get("days", 7))
    except ValueError:
        return bad_request("days must be an integer.")
    days = max(1, min(days, 365))
    start = (today_china() - timedelta(days=days - 1)).isoformat()
    with connection() as conn:
        logs = rows_to_dicts(
            conn.execute(
                """
                SELECT * FROM usage_logs
                WHERE created_at >= ?
                ORDER BY created_at DESC, id DESC
                """,
                (start,),
            ).fetchall()
        )
        daily = rows_to_dicts(
            conn.execute(
                """
                SELECT substr(created_at, 1, 10) AS date,
                       COUNT(*) AS rounds,
                       COALESCE(SUM(input_tokens), 0) AS input_tokens,
                       COALESCE(SUM(output_tokens), 0) AS output_tokens,
                       COALESCE(SUM(cost), 0) AS cost
                FROM usage_logs
                WHERE created_at >= ?
                GROUP BY substr(created_at, 1, 10)
                ORDER BY date DESC
                """,
                (start,),
            ).fetchall()
        )
    return jsonify({"days": days, "daily": daily, "logs": logs})


@app.get("/api/calendar")
def calendar_month():
    try:
        month = normalize_month(request.args.get("month"))
    except ValueError as error:
        return bad_request(str(error))
    start, end = month_range(month)
    month_number = month[-2:]
    with connection() as conn:
        checkins = rows_to_dicts(
            conn.execute(
                "SELECT * FROM checkins WHERE date >= ? AND date < ? ORDER BY date",
                (start, end),
            ).fetchall()
        )
        todos = rows_to_dicts(
            conn.execute(
                """
                SELECT * FROM todos
                WHERE due_date >= ? AND due_date < ?
                ORDER BY due_date, id
                """,
                (start, end),
            ).fetchall()
        )
        milestones = rows_to_dicts(
            conn.execute(
                "SELECT * FROM milestones WHERE date >= ? AND date < ? ORDER BY date",
                (start, end),
            ).fetchall()
        )
        anniversaries = rows_to_dicts(
            conn.execute(
                "SELECT * FROM anniversaries WHERE substr(date, 6, 2) = ? ORDER BY date",
                (month_number,),
            ).fetchall()
        )
        streak = checkin_streak(conn)
    return jsonify(
        {
            "month": month,
            "streak": streak,
            "checkins": checkins,
            "todos": todos,
            "milestones": milestones,
            "anniversaries": anniversaries,
        }
    )


@app.get("/api/settings")
def get_settings():
    with connection() as conn:
        rows = conn.execute("SELECT key, value FROM settings ORDER BY key").fetchall()
    return jsonify({row["key"]: row["value"] for row in rows})


@app.patch("/api/settings")
def update_settings():
    data = payload()
    if not isinstance(data, dict) or not data:
        return bad_request("Provide one or more settings.")
    with connection() as conn:
        conn.executemany(
            """
            INSERT INTO settings(key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
            """,
            [(str(key), None if value is None else str(value)) for key, value in data.items()],
        )
    return get_settings()


@app.post("/api/terminal/exec")
def terminal_exec():
    data = payload()
    command = str(data.get("command") or "").strip()
    if not command:
        return bad_request("command is required.")
    import subprocess
    import time

    created_at = now_iso()
    start = time.monotonic()
    env = os.environ.copy()
    env["GIT_CONFIG_COUNT"] = "1"
    env["GIT_CONFIG_KEY_0"] = "safe.directory"
    env["GIT_CONFIG_VALUE_0"] = "*"
    try:
        result = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            timeout=30,
            env=env,
        )
        stdout = result.stdout
        stderr = result.stderr
        returncode = result.returncode
    except subprocess.TimeoutExpired:
        stdout = ""
        stderr = "Command timed out after 30 seconds."
        returncode = -1
    duration_ms = int((time.monotonic() - start) * 1000)
    with connection() as conn:
        conn.execute(
            """
            INSERT INTO terminal_logs(command, stdout, stderr, returncode, duration_ms, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (command, stdout, stderr, returncode, duration_ms, created_at),
        )
    return jsonify(
        {
            "command": command,
            "stdout": stdout,
            "stderr": stderr,
            "returncode": returncode,
            "duration_ms": duration_ms,
        }
    )


@app.get("/api/terminal/history")
def terminal_history():
    with connection() as conn:
        rows = conn.execute(
            "SELECT * FROM terminal_logs ORDER BY id DESC LIMIT 50"
        ).fetchall()
    return jsonify([dict(row) for row in rows])


@app.get("/api/home")
def home():
    china_now = datetime.now(CHINA_TZ)
    hour = china_now.hour
    if 5 <= hour < 11:
        greeting = "早上好。"
    elif 11 <= hour < 14:
        greeting = "中午好，吃了吗。"
    elif 18 <= hour < 23:
        greeting = "晚上好，今天辛苦了。"
    elif hour >= 23 or hour < 5:
        greeting = "还没睡？陪你聊会儿。"
    else:
        greeting = "下午好。"
    with connection() as conn:
        settings = {
            row["key"]: row["value"]
            for row in conn.execute("SELECT key, value FROM settings").fetchall()
        }
        latest = row_or_none(
            conn,
            """
            SELECT c.id, c.title, c.updated_at, c.summary, c.summary_message_id,
                   (
                     SELECT MAX(id) FROM messages
                     WHERE conversation_id = c.id AND deleted = 0
                   ) AS latest_message_id
            FROM conversations c
            ORDER BY updated_at DESC LIMIT 1
            """,
        )
        today_todos = rows_to_dicts(
            conn.execute(
                """
                SELECT * FROM todos
                WHERE due_date = ? AND done = 0
                ORDER BY id
                """,
                (china_now.date().isoformat(),),
            ).fetchall()
        )
        streak = checkin_streak(conn)
    origin = None
    days_together = None
    if settings.get("origin_date"):
        try:
            origin = date.fromisoformat(settings["origin_date"])
            days_together = (
                china_now.date() - origin
            ).days
        except ValueError:
            origin = None
            days_together = None
    upcoming = []
    today = china_now.date()
    if origin:
        years = max(1, today.year - origin.year)
        try:
            candidate = origin.replace(year=origin.year + years)
        except ValueError:
            candidate = origin.replace(year=origin.year + years, day=28)
        if candidate < today:
            years += 1
            try:
                candidate = origin.replace(year=origin.year + years)
            except ValueError:
                candidate = origin.replace(year=origin.year + years, day=28)
        days = (candidate - today).days
        upcoming.append({
            "id": "origin_date",
            "name": f"认识{years}周年",
            "date": candidate.isoformat(),
            "days_until": days,
        })
    today_memory = None
    if latest and latest.get("latest_message_id") and (
        not latest.get("summary")
        or latest.get("summary_message_id") != latest.get("latest_message_id")
    ):
        queue_home_summary(latest["id"])
    try:
        today_memory = memory_today()
    except Exception:
        app.logger.exception("Today memory lookup failed")
    return jsonify(
        {
            "greeting": greeting,
            "days_together": days_together,
            "last_conversation": latest,
            "upcoming_anniversaries": upcoming,
            "today_memory": today_memory,
            "today_todos": today_todos,
            "memory_status": mcp_phase_status(),
            "streak": streak,
        }
    )


@app.post("/api/upload")
def upload():
    if "file" not in request.files:
        return bad_request("Multipart field 'file' is required.")
    file = request.files["file"]
    filename = secure_filename(file.filename or "")
    if not filename:
        return bad_request("A valid filename is required.")
    suffix = Path(filename).suffix.lower()
    mimetype = (file.mimetype or mimetypes.guess_type(filename)[0] or "").lower()
    document_mimes = {
        ".pdf": {"application/pdf"},
        ".txt": {"text/plain"},
        ".md": {"text/markdown", "text/plain"},
        ".docx": {"application/vnd.openxmlformats-officedocument.wordprocessingml.document"},
        ".xlsx": {"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"},
    }
    blocked_suffixes = {".html", ".htm", ".svg", ".js", ".mjs", ".php", ".exe", ".bat", ".cmd", ".sh"}
    if suffix in blocked_suffixes:
        return bad_request("This file type is not allowed.")
    is_image = mimetype.startswith("image/") and suffix in {
        ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".heic", ".heif"
    }
    is_document = suffix in document_mimes and (
        mimetype in document_mimes[suffix] or not mimetype
    )
    if not is_image and not is_document:
        return bad_request("Only images and common documents are allowed.")
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(CHINA_TZ).strftime("%Y%m%d%H%M%S%f")
    stored_name = f"{timestamp}-{filename}"
    file.save(UPLOAD_DIR / stored_name)
    path = f"/uploads/{stored_name}"
    return jsonify(
        {
            "name": file.filename,
            "path": path,
            "url": signed_upload_url(path),
            "type": "image" if is_image else "file",
            "mime_type": mimetype or file.mimetype,
        }
    ), 201


@app.get("/uploads/<path:filename>")
def serve_upload(filename):
    normalized = filename.replace("\\", "/")
    if not (upload_bearer_authorized() or valid_upload_signature(normalized)):
        response = jsonify(
            {
                "error": "Unauthorized",
                "message": "A valid upload signature is required.",
            }
        )
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response, 401
    response = send_from_directory(UPLOAD_DIR, normalized)
    response.headers["X-Content-Type-Options"] = "nosniff"
    mimetype = (response.mimetype or mimetypes.guess_type(normalized)[0] or "").lower()
    if not mimetype.startswith("image/"):
        response.headers["Content-Disposition"] = f'attachment; filename="{Path(normalized).name}"'
    return response


@app.post("/api/chat")
def chat():
    data = payload()
    try:
        conversation_id = int(data.get("conversation_id"))
    except (TypeError, ValueError):
        return bad_request("conversation_id must be an integer.")
    try:
        context = load_chat_context(
            conversation_id,
            data.get("content"),
            data.get("attachments"),
        )
    except ChatSetupError as error:
        return jsonify({"error": str(error)}), error.status_code
    return Response(
        stream_with_context(chat_events(context)),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@app.post("/api/chat/regenerate")
def regenerate_chat():
    data = payload()
    try:
        message_id = int(data.get("message_id"))
    except (TypeError, ValueError):
        return bad_request("message_id must be an integer.")
    try:
        context = load_regeneration_context(message_id)
    except ChatSetupError as error:
        return jsonify({"error": str(error)}), error.status_code
    return Response(
        stream_with_context(chat_events(context)),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@app.post("/api/chat/edit")
def edit_chat_message():
    data = payload()
    try:
        message_id = int(data.get("message_id"))
    except (TypeError, ValueError):
        return bad_request("message_id must be an integer.")
    try:
        context = load_edit_context(message_id, data.get("content"))
    except ChatSetupError as error:
        return jsonify({"error": str(error)}), error.status_code
    return Response(
        stream_with_context(chat_events(context)),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@app.get("/api/memory/<string:resource>")
def memory(resource):
    if resource not in {"buckets", "archives", "emotion_trend"}:
        return not_found("Memory resource")
    try:
        handlers = {
            "buckets": memory_buckets,
            "archives": memory_archives,
            "emotion_trend": memory_emotion_trend,
        }
        return jsonify(handlers[resource]())
    except Exception as error:
        app.logger.exception("Memory endpoint failed")
        return jsonify({"error": str(error), "resource": resource}), 502


@app.get("/api/memory/buckets/<path:bucket_id>")
def memory_bucket(bucket_id):
    try:
        return jsonify(memory_bucket_detail(bucket_id))
    except Exception as error:
        app.logger.exception("Memory bucket detail failed")
        return jsonify({"error": str(error), "bucket_id": bucket_id}), 502


init_db()
warm_tools_async()


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=False)
