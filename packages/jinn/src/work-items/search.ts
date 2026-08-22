import type { Database as DatabaseType } from 'better-sqlite3';
import { parseTodoId } from './id.js';

/**
 * Free-text Todo search over the FTS5 indexes owned by `search-index.ts`
 * (ICI-1369). The store asks this module for the matching Todo ids in relevance
 * order plus the reason each one matched; every other filter still composes in
 * SQL around that id set, so the page and its counts stay in agreement.
 */

export interface WorkItemMatch {
  /** Where the hit landed. `id` is an exact Todo-id lookup, not a text hit. */
  field: 'id' | 'title' | 'body' | 'comment';
  /** The matching comment, present only when `field` is `comment`. */
  commentId?: string;
  /** Surrounding text with the hits wrapped in `<mark>`. */
  snippet: string;
}

export interface WorkItemTextSearch {
  /** Matching Todo ids, best match first. */
  ids: string[];
  /** Why each id matched, best reason first. Keyed by Todo id. */
  matches: Record<string, WorkItemMatch[]>;
}

/** Ceiling on the ids handed back to the store. Search is how a Todo is found,
 *  not how the ledger is paged, and this keeps the id set well inside SQLite's
 *  bind-parameter budget. */
const CANDIDATE_LIMIT = 500;

/** bm25 scores a hit negatively — the better the match, the more negative. A
 *  comment hit is lifted above zero so every title/body hit outranks every
 *  comment-only hit, while comments keep their order among themselves. */
const COMMENT_SCORE_FLOOR = 1_000;

/** An exact Todo id is an answer rather than a guess, so it precedes all text. */
const EXACT_ID_SCORE = -1_000_000;

// `snippet()` wraps hits in these sentinels rather than in `<mark>` directly: a
// column with no hit still returns its plain leading text, and that has to be
// told apart from a column whose own text contains the tag. They are replaced
// before a snippet leaves this module.
const HIT_OPEN = String.fromCharCode(2);
const HIT_CLOSE = String.fromCharCode(3);

const OWN_FIELD_SQL = `
SELECT wi.id AS itemId,
       snippet(work_items_fts, 0, char(2), char(3), '…', 12) AS titleSnippet,
       snippet(work_items_fts, 1, char(2), char(3), '…', 12) AS bodySnippet,
       bm25(work_items_fts, 4.0, 1.0) AS score
FROM work_items_fts JOIN work_items wi ON wi.rowid = work_items_fts.rowid
WHERE work_items_fts MATCH ?
ORDER BY score
LIMIT ?`;

const COMMENT_SQL = `
SELECT c.work_item_id AS itemId, c.id AS commentId,
       snippet(work_item_comments_fts, 0, char(2), char(3), '…', 12) AS snippet,
       bm25(work_item_comments_fts) AS score
FROM work_item_comments_fts JOIN work_item_comments c ON c.rowid = work_item_comments_fts.rowid
WHERE work_item_comments_fts MATCH ?
ORDER BY score
LIMIT ?`;

/**
 * Turn free text into an FTS5 MATCH expression that can only ever be a
 * conjunction of literal phrases: every whitespace-separated word is reduced to
 * its letter/digit runs and requoted. `"`, `*`, `NEAR(a b)`, `-foo` and the
 * rest therefore arrive as ordinary search terms and can never reach the FTS5
 * parser as syntax. Null when no searchable term survives.
 */
export function toFtsMatchExpression(text: string): string | null {
  const phrases = text
    .split(/\s+/)
    .map((word) => (word.match(/[\p{L}\p{N}]+/gu) ?? []).join(' '))
    .filter((phrase) => phrase.length > 0)
    .map((phrase) => `"${phrase}"`);
  return phrases.length > 0 ? phrases.join(' AND ') : null;
}

function exactTodoId(text: string): string | null {
  try {
    return parseTodoId(text);
  } catch {
    return null; // ordinary text, not an id — the FTS branch handles it
  }
}

function renderSnippet(snippet: string | null): string {
  return (snippet ?? '').split(HIT_OPEN).join('<mark>').split(HIT_CLOSE).join('</mark>');
}

interface OwnFieldRow { itemId: string; titleSnippet: string | null; bodySnippet: string | null; score: number }
interface CommentRow { itemId: string; commentId: string; snippet: string | null; score: number }

type ScoredMatch = WorkItemMatch & { score: number };
type RecordMatch = (itemId: string, score: number, match: WorkItemMatch) => void;

function recordFtsMatches(db: DatabaseType, expression: string, record: RecordMatch): void {
  for (const row of db.prepare(OWN_FIELD_SQL).all(expression, CANDIDATE_LIMIT) as OwnFieldRow[]) {
    if (row.titleSnippet?.includes(HIT_OPEN)) {
      record(row.itemId, row.score, { field: 'title', snippet: renderSnippet(row.titleSnippet) });
    }
    if (row.bodySnippet?.includes(HIT_OPEN)) {
      record(row.itemId, row.score, { field: 'body', snippet: renderSnippet(row.bodySnippet) });
    }
  }
  for (const row of db.prepare(COMMENT_SQL).all(expression, CANDIDATE_LIMIT) as CommentRow[]) {
    record(row.itemId, COMMENT_SCORE_FLOOR + row.score, {
      field: 'comment',
      commentId: row.commentId,
      snippet: renderSnippet(row.snippet),
    });
  }
}

/** Order the Todos by their best reason, and each Todo's reasons by their own. */
function rank(scored: Map<string, ScoredMatch[]>): WorkItemTextSearch {
  const best = new Map<string, number>();
  for (const [itemId, reasons] of scored) {
    reasons.sort((a, b) => a.score - b.score);
    best.set(itemId, reasons[0].score);
  }
  const ids = [...best.keys()]
    .sort((a, b) => best.get(a)! - best.get(b)! || a.localeCompare(b))
    .slice(0, CANDIDATE_LIMIT);
  const matches: Record<string, WorkItemMatch[]> = {};
  for (const id of ids) matches[id] = scored.get(id)!.map(({ score: _score, ...match }) => match);
  return { ids, matches };
}

/** Rank every Todo matching `text`, and record why each one matched. */
export function searchWorkItemText(db: DatabaseType, text: string): WorkItemTextSearch {
  const scored = new Map<string, ScoredMatch[]>();
  const record: RecordMatch = (itemId, score, match) => {
    const reasons = scored.get(itemId) ?? [];
    reasons.push({ ...match, score });
    scored.set(itemId, reasons);
  };

  const exactId = exactTodoId(text);
  if (exactId) record(exactId, EXACT_ID_SCORE, { field: 'id', snippet: exactId });

  const expression = toFtsMatchExpression(text);
  if (expression) recordFtsMatches(db, expression, record);

  return rank(scored);
}
