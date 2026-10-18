import type Database from 'better-sqlite3'

export const ASSISTANT_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS assistant_sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  INSERT OR IGNORE INTO assistant_sessions(id, title, created_at)
    VALUES ('main', '新会话', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  CREATE TABLE IF NOT EXISTS assistant_turns (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL DEFAULT 'main',
    prompt TEXT NOT NULL,
    answer TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'undone', 'chat')),
    changes TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_assistant_one_pending
    ON assistant_turns(status) WHERE status = 'pending';
`

export function ensureAssistantSchema(database: Database.Database) {
  database.transaction(() => {
    database.exec(ASSISTANT_SCHEMA_SQL)
    const columns = database.prepare('PRAGMA table_info(assistant_turns)').all() as { name: string }[]
    if (!columns.some(column => column.name === 'session_id')) {
      database.exec("ALTER TABLE assistant_turns ADD COLUMN session_id TEXT NOT NULL DEFAULT 'main'")
      database.exec("UPDATE assistant_sessions SET title = '历史会话' WHERE id = 'main' AND EXISTS(SELECT 1 FROM assistant_turns)")
    }
    database.exec('CREATE INDEX IF NOT EXISTS idx_assistant_session ON assistant_turns(session_id, created_at)')
  })()
}
