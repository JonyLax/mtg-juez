CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL, username_lc TEXT NOT NULL UNIQUE, email TEXT NOT NULL, email_lc TEXT NOT NULL UNIQUE, salt TEXT NOT NULL, pass_hash TEXT NOT NULL, kdf_iterations INTEGER NOT NULL, verified INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_login INTEGER, username_changed_at INTEGER, lang TEXT);
CREATE TABLE IF NOT EXISTS tokens (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS tokens_user ON tokens(user_id, kind);
CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS sessions_exp ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS attempts (bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS card_names (printed_lc TEXT NOT NULL, lang TEXT NOT NULL, printed TEXT NOT NULL, english TEXT NOT NULL, PRIMARY KEY (printed_lc, lang));
CREATE INDEX IF NOT EXISTS card_names_prefix ON card_names(printed_lc);
