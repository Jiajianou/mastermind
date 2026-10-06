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

export const migrations: readonly string[] = [initialSchema, reviewRounds];
