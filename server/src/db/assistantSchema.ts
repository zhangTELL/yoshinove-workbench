export const ASSISTANT_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS assistant_turns (
    id TEXT PRIMARY KEY,
    prompt TEXT NOT NULL,
    answer TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'undone', 'chat')),
    changes TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_assistant_one_pending
    ON assistant_turns(status) WHERE status = 'pending';
`
