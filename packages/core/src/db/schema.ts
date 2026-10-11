const initialSchema = `
CREATE TABLE tasks (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, goal TEXT NOT NULL,
  acceptance TEXT NOT NULL, touches TEXT NOT NULL,
  status TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0, round INTEGER NOT NULL DEFAULT 1,
  held INTEGER NOT NULL DEFAULT 0, resume_session TEXT,
  branch TEXT, worktree TEXT, base_commit TEXT,
  created_at TEXT, updated_at TEXT
);
CREATE TABLE task_deps (task_id TEXT, depends_on TEXT, PRIMARY KEY (task_id, depends_on));
CREATE TABLE sessions (
  id INTEGER PRIMARY KEY, task_id TEXT,
  role TEXT,
  round INTEGER, attempt INTEGER, claude_session_id TEXT, pid INTEGER, pgid INTEGER,
  model TEXT,
  status TEXT,
  end_commit TEXT, input_tokens INTEGER, output_tokens INTEGER,
  started_at TEXT, ended_at TEXT
);
CREATE TABLE events (
  id INTEGER PRIMARY KEY, session_id INTEGER, ts TEXT,
  type TEXT,
  summary TEXT, payload TEXT
);
CREATE TABLE checks (
  id INTEGER PRIMARY KEY, task_id TEXT, round INTEGER,
  kind TEXT,
  status TEXT,
  summary TEXT, log_path TEXT, duration_ms INTEGER
);
CREATE TABLE findings (id INTEGER PRIMARY KEY, task_id TEXT, round INTEGER,
  file TEXT, line INTEGER, text TEXT, severity TEXT,
  dismissed INTEGER DEFAULT 0);
CREATE TABLE comments (id INTEGER PRIMARY KEY, task_id TEXT, round INTEGER,
  file TEXT, line_start INTEGER, line_end INTEGER, excerpt TEXT, text TEXT);
CREATE TABLE rebases (id INTEGER PRIMARY KEY, task_id TEXT, status TEXT, log_path TEXT, ts TEXT);
CREATE TABLE chat_messages (id INTEGER PRIMARY KEY, ts TEXT,
  kind TEXT,
  content TEXT, meta TEXT, conductor_session TEXT, turn_id TEXT);
CREATE TABLE proposals (id INTEGER PRIMARY KEY, ts TEXT, action TEXT, args TEXT,
  status TEXT,
  decided_at TEXT, result TEXT);
CREATE TABLE conductor_sessions (id TEXT PRIMARY KEY, started_at TEXT, ended_at TEXT,
  summary TEXT, tokens INTEGER);

CREATE TABLE runtime_flags (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE INDEX task_deps_depends_on ON task_deps (depends_on);
CREATE INDEX sessions_task_id ON sessions (task_id);
CREATE INDEX sessions_status ON sessions (status);
CREATE INDEX events_session_id ON events (session_id);
CREATE INDEX checks_task_id ON checks (task_id, round);
CREATE INDEX checks_status ON checks (status);
CREATE INDEX findings_task_id ON findings (task_id, round);
CREATE INDEX comments_task_id ON comments (task_id, round);
CREATE INDEX rebases_task_id ON rebases (task_id);
CREATE INDEX rebases_status ON rebases (status);
CREATE INDEX proposals_status ON proposals (status);
`;

const reviewRounds = `
CREATE TABLE rounds (
  id INTEGER PRIMARY KEY, task_id TEXT NOT NULL, round INTEGER NOT NULL,
  mode TEXT NOT NULL, instruction TEXT NOT NULL, message TEXT NOT NULL,
  comment_ids TEXT NOT NULL, finding_ids TEXT NOT NULL, failing_check_id INTEGER,
  start_commit TEXT, session_id INTEGER, created_at TEXT NOT NULL,
  UNIQUE (task_id, round)
);
`;

// Chats used to be one stream cut by "New conversation" dividers; each stretch between them becomes a conversation,
// titled by its first owner message, and each Claude session belongs to the conversation its messages are in.
const conversations = `
CREATE TABLE conversations (id INTEGER PRIMARY KEY, title TEXT, started_at TEXT NOT NULL,
  opened INTEGER NOT NULL);
ALTER TABLE chat_messages ADD COLUMN conversation_id INTEGER;
ALTER TABLE conductor_sessions ADD COLUMN conversation_id INTEGER;
UPDATE chat_messages SET conversation_id = 1 + (
  SELECT COUNT(*) FROM chat_messages AS divider
   WHERE divider.kind = 'system' AND divider.meta = '{"conversation":"new"}'
     AND divider.id <= chat_messages.id);
INSERT INTO conversations (id, title, started_at, opened)
  SELECT grouped.conversation_id,
         (SELECT substr(first.content, 1,
                   CASE WHEN instr(first.content, char(10)) > 0
                        THEN min(instr(first.content, char(10)) - 1, 80) ELSE 80 END)
            FROM chat_messages AS first
           WHERE first.conversation_id = grouped.conversation_id AND first.kind = 'user'
           ORDER BY first.id LIMIT 1),
         MIN(grouped.ts), grouped.conversation_id
    FROM chat_messages AS grouped GROUP BY grouped.conversation_id;
DELETE FROM chat_messages WHERE kind = 'system' AND meta = '{"conversation":"new"}';
INSERT INTO conversations (title, started_at, opened)
  SELECT NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 1
   WHERE NOT EXISTS (SELECT 1 FROM conversations);
UPDATE conductor_sessions SET conversation_id = (
  SELECT MAX(conversation_id) FROM chat_messages
   WHERE chat_messages.conductor_session = conductor_sessions.id);
CREATE INDEX chat_messages_conversation ON chat_messages (conversation_id, id);
CREATE INDEX conductor_sessions_conversation ON conductor_sessions (conversation_id);
`;

export const migrations: readonly string[] = [initialSchema, reviewRounds, conversations];
