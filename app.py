import json
import hmac
import os
import re
import sqlite3
from datetime import date, datetime, timedelta
from pathlib import Path

from flask import Flask, Response, jsonify, request, stream_with_context
from flask_cors import CORS
from werkzeug.utils import secure_filename

from db import CHINA_TZ, connection, init_db, now_iso, parse_attachments, rows_to_dicts
from llm import (
    ChatSetupError,
    chat_events,
    generate_home_summary,
    load_chat_context,
    load_regeneration_context,
)
from mcp_client import (
    memory_archives,
    memory_buckets,
    memory_emotion_trend,
    memory_today,
    phase_status as mcp_phase_status,
    warm_tools_async,
)


BASE_DIR = Path(__file__).resolve().parent
UPLOAD_DIR = BASE_DIR.parent / "frontend" / "uploads"
BOOK_DIR = BASE_DIR / "data" / "books"
MONTH_PATTERN = re.compile(r"^\d{4}-\d{2}$")
BOOK_CHAPTER_PATTERN = re.compile(
    r"(?im)^(第[0-9一二三四五六七八九十百千万零〇两]+[章节回卷部篇].*|Chapter\s+\d+.*)$"
)

app = Flask(__name__)
CORS(app)
app.config["MAX_CONTENT_LENGTH"] = 25 * 1024 * 1024


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


def month_range(month):
    start = parse_iso_day(f"{month}-01", "month")
    if start.month == 12:
        end = start.replace(year=start.year + 1, month=1)
    else:
        end = start.replace(month=start.month + 1)
    return start.isoformat(), end.isoformat()


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
        cursor = conn.execute(
            "DELETE FROM conversations WHERE id = ?", (conversation_id,)
        )
        if cursor.rowcount == 0:
            return not_found("Conversation")
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
            message["attachments"] = json.loads(message["attachments"])
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
        result["attachments"] = json.loads(result["attachments"])
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
    search_type = request.args.get("type", "all")
    if search_type not in {"all", "file", "image"}:
        return bad_request("type must be all, file, or image.")
    if not query:
        return jsonify([])
    clauses = ["m.deleted = 0", "(m.content LIKE ? OR m.attachments LIKE ?)"]
    values = [f"%{query}%", f"%{query}%"]
    if search_type != "all":
        clauses.append("m.attachments LIKE ?")
        values.append(f'%\"type\": \"{search_type}\"%')
    sql = f"""
        SELECT m.*, c.title AS conversation_title
        FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        WHERE {" AND ".join(clauses)}
        ORDER BY m.created_at DESC
    """
    with connection() as conn:
        results = rows_to_dicts(conn.execute(sql, values).fetchall())
    for item in results:
        if item["attachments"]:
            item["attachments"] = json.loads(item["attachments"])
    return jsonify(results)


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


@app.get("/api/presets")
def list_presets():
    return list_resource("api_presets")


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
                data["api_key"],
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
    return jsonify(result), 201


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
    return jsonify(result)


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
                total_chapters, current_chapter, position, progress,
                created_at, last_read_at
            ) VALUES (?, ?, ?, ?, ?, 1, 0, 0, ?, NULL)
            """,
            (title, stored_name, file.filename, len(text), len(chapters), now_iso()),
        )
        result = row_or_none(conn, "SELECT * FROM books WHERE id = ?", (cursor.lastrowid,))
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


@app.patch("/api/books/<int:book_id>")
def update_book(book_id):
    data = payload()
    allowed = {"title", "current_chapter", "progress", "position"}
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
            SELECT c.id, c.title, c.updated_at, c.summary, c.summary_message_id
            FROM conversations c
            ORDER BY updated_at DESC LIMIT 1
            """,
        )
        anniversaries = rows_to_dicts(
            conn.execute("SELECT * FROM anniversaries ORDER BY date").fetchall()
        )
        streak = checkin_streak(conn)
    days_together = None
    if settings.get("origin_date"):
        try:
            days_together = (
                china_now.date() - date.fromisoformat(settings["origin_date"])
            ).days
        except ValueError:
            days_together = None
    upcoming = []
    today = china_now.date()
    for item in anniversaries:
        source = date.fromisoformat(item["date"])
        candidate = source.replace(year=today.year)
        if candidate < today:
            candidate = candidate.replace(year=today.year + 1)
        days = (candidate - today).days
        if days <= 30:
            upcoming.append({**item, "days_until": days})
    today_memory = None
    if latest:
        try:
            latest["summary"] = generate_home_summary(latest["id"])
        except Exception:
            app.logger.exception("Conversation summary generation failed")
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
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(CHINA_TZ).strftime("%Y%m%d%H%M%S%f")
    stored_name = f"{timestamp}-{filename}"
    file.save(UPLOAD_DIR / stored_name)
    return jsonify(
        {
            "name": file.filename,
            "path": f"/uploads/{stored_name}",
            "type": "image" if (file.mimetype or "").startswith("image/") else "file",
            "mime_type": file.mimetype,
        }
    ), 201


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


init_db()
warm_tools_async()


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=False)
