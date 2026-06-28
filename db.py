import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone, timedelta
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
DB_PATH = DATA_DIR / "cheng.db"
CHINA_TZ = timezone(timedelta(hours=8))


def now_iso():
    return datetime.now(CHINA_TZ).isoformat(timespec="seconds")


@contextmanager
def connection():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def rows_to_dicts(rows):
    return [dict(row) for row in rows]


def init_db():
    schema = """
    CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT DEFAULT '新对话',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        thinking TEXT,
        thinking_seconds REAL,
        attachments TEXT,
        starred INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        deleted INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS api_presets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        api_key TEXT NOT NULL,
        model TEXT NOT NULL,
        format TEXT NOT NULL DEFAULT 'anthropic'
            CHECK(format IN ('anthropic', 'openai')),
        active INTEGER DEFAULT 0,
        input_price REAL DEFAULT 0,
        output_price REAL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
    );

    CREATE TABLE IF NOT EXISTS mcp_servers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        auth TEXT,
        enabled INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS anniversaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        date TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS checkins (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL UNIQUE,
        note TEXT,
        created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS todos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        due_date TEXT,
        done INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        done_at TEXT
    );

    CREATE TABLE IF NOT EXISTS milestones (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        date TEXT NOT NULL,
        note TEXT,
        created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS books (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        filename TEXT NOT NULL,
        original_filename TEXT,
        total_chars INTEGER DEFAULT 0,
        total_chapters INTEGER DEFAULT 1,
        current_chapter INTEGER DEFAULT 1,
        position INTEGER DEFAULT 0,
        progress REAL DEFAULT 0,
        created_at TEXT NOT NULL,
        last_read_at TEXT
    );

    CREATE TABLE IF NOT EXISTS usage_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER REFERENCES conversations(id),
        preset_name TEXT,
        model TEXT,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        cache_read_tokens INTEGER DEFAULT 0,
        cache_write_tokens INTEGER DEFAULT 0,
        cost REAL DEFAULT 0,
        created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS terminal_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        command TEXT NOT NULL,
        stdout TEXT,
        stderr TEXT,
        returncode INTEGER,
        duration_ms INTEGER,
        created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_conversations_updated
        ON conversations(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_conversation
        ON messages(conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_checkins_date
        ON checkins(date);
    CREATE INDEX IF NOT EXISTS idx_todos_done_due
        ON todos(done, due_date);
    CREATE INDEX IF NOT EXISTS idx_milestones_date
        ON milestones(date);
    CREATE INDEX IF NOT EXISTS idx_usage_logs_created
        ON usage_logs(created_at);
    """
    with connection() as conn:
        conn.executescript(schema)
        conversation_columns = {
            row["name"]
            for row in conn.execute("PRAGMA table_info(conversations)").fetchall()
        }
        if "summary" not in conversation_columns:
            conn.execute("ALTER TABLE conversations ADD COLUMN summary TEXT")
        if "summary_message_id" not in conversation_columns:
            conn.execute(
                "ALTER TABLE conversations ADD COLUMN summary_message_id INTEGER"
            )
        preset_columns = {
            row["name"]
            for row in conn.execute("PRAGMA table_info(api_presets)").fetchall()
        }
        if "input_price" not in preset_columns:
            conn.execute("ALTER TABLE api_presets ADD COLUMN input_price REAL DEFAULT 0")
        if "output_price" not in preset_columns:
            conn.execute("ALTER TABLE api_presets ADD COLUMN output_price REAL DEFAULT 0")
        book_columns = {
            row["name"]
            for row in conn.execute("PRAGMA table_info(books)").fetchall()
        }
        if "position" not in book_columns:
            conn.execute("ALTER TABLE books ADD COLUMN position INTEGER DEFAULT 0")
        conn.executemany(
            "INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)",
            [
                ("origin_date", ""),
                ("system_prompt", ""),
                ("profile", ""),
                ("theme", "system"),
            ],
        )
        conn.execute(
            """
            INSERT INTO mcp_servers(name, url, auth, enabled)
            SELECT ?, ?, NULL, 1
            WHERE NOT EXISTS (
                SELECT 1 FROM mcp_servers WHERE url = ?
            )
            """,
            (
                "Ombre Brain",
                "https://ombre-brain-rqym.onrender.com/mcp",
                "https://ombre-brain-rqym.onrender.com/mcp",
            ),
        )


def parse_attachments(value):
    if value is None:
        return None
    if isinstance(value, str):
        json.loads(value)
        return value
    return json.dumps(value, ensure_ascii=False)
