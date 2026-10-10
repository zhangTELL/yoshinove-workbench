/** 一个主题整体保存，避免更新模型列表时出现半份作品或残留记录。 */
export const COMPARISON_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS ai_comparison_topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    prompt TEXT NOT NULL DEFAULT '',
    entries TEXT NOT NULL DEFAULT '[]',
    model_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`
