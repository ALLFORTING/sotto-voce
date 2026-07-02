from db import connection
from llm import strip_thinking_text


def main():
    changed = 0
    with connection() as conn:
        rows = conn.execute(
            """
            SELECT id, content
            FROM book_annotations
            WHERE content LIKE '%<thinking%' OR content LIKE '%<think%'
            """
        ).fetchall()
        for row in rows:
            cleaned = strip_thinking_text(row["content"])
            if cleaned != row["content"]:
                conn.execute(
                    "UPDATE book_annotations SET content = ? WHERE id = ?",
                    (cleaned, row["id"]),
                )
                changed += 1
    print(f"cleaned {changed} book_annotations rows")


if __name__ == "__main__":
    main()
