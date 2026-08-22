import crypto from 'node:crypto'
import path from 'node:path'
import { createRequire } from 'node:module'

const [sandboxHome, repo] = process.argv.slice(2)
if (!sandboxHome || !repo) throw new Error('usage: seed-chat-grid-drop.mjs <sandbox-home> <repo>')

const requireFromJinn = createRequire(path.join(repo, 'packages/jinn/package.json'))
const Database = requireFromJinn('better-sqlite3')
const db = new Database(path.join(sandboxHome, 'sessions', 'registry.db'))
const now = new Date().toISOString()
const rows = [
  ['sandbox:4', '#4 - Release notes'],
  ['sandbox:5', '#5 - Incident review'],
]
const insert = db.prepare(`
  INSERT OR IGNORE INTO sessions (
    id, engine, source, source_ref, connector, session_key, model, title,
    prompt_excerpt, status, total_cost, total_turns, last_context_tokens,
    created_at, last_activity
  ) VALUES (?, 'claude', 'web', ?, 'web', ?, 'opus', ?, ?, 'idle', 0, 0, 900, ?, ?)
`)

for (const [sourceRef, title] of rows) {
  insert.run(crypto.randomUUID(), sourceRef, `web:${sourceRef}`, title, title, now, now)
}
db.close()
