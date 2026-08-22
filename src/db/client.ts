import { execSync, spawnSync } from "child_process";
import { getDbPath } from "../lib/config.js";
import type { DatabaseSync, SQLInputValue, StatementResultingChanges } from "node:sqlite";

// ============================================================================
// SQLite Backend Abstraction
// ============================================================================

interface SqliteBackend {
  query(sql: string): string;
  queryJson<T>(sql: string): T[];
  execute(sql: string): void;
}

let cachedBackend: SqliteBackend | null = null;

// Only set when the node:sqlite backend is active - lets run/get/all below
// bind parameters directly instead of interpolating strings into SQL text.
// The sqlite3-CLI fallback (pre-22.5 Node) doesn't support this; callers
// that need it should treat Node 22.5+ as a hard requirement.
let nodeSqliteDb: DatabaseSync | null = null;

/**
 * Try to use Node's built-in SQLite module (Node 22.5+).
 * Falls back to shelling out to sqlite3 CLI if not available.
 */
async function detectBackend(): Promise<SqliteBackend> {
  // Try Node.js built-in SQLite first (Node 22.5+)
  try {
    // Dynamic import to avoid syntax errors on older Node versions
    const sqlite = await import("node:sqlite");
    const dbPath = getDbPath();
    const db = new sqlite.DatabaseSync(dbPath);
    nodeSqliteDb = db;

    return {
      query(sql: string): string {
        const stmt = db.prepare(sql);
        const rows = stmt.all();
        if (rows.length === 0) return "";
        // Format as simple text output (column values separated by |)
        return rows
          .map((row) =>
            Object.values(row as Record<string, unknown>)
              .map((v) => (v === null ? "" : String(v)))
              .join("|")
          )
          .join("\n");
      },
      queryJson<T>(sql: string): T[] {
        const stmt = db.prepare(sql);
        return stmt.all() as T[];
      },
      execute(sql: string): void {
        db.exec(sql);
      },
    };
  } catch {
    // Node.js built-in SQLite not available, try CLI
  }

  // Fallback: Use sqlite3 CLI
  try {
    // Check if sqlite3 is available
    execSync("sqlite3 --version", { stdio: "ignore" });

    return {
      query(sql: string): string {
        const dbPath = getDbPath();
        return execSync(`sqlite3 "${dbPath}" "${sql.replace(/"/g, '\\"')}"`, {
          encoding: "utf-8",
        });
      },
      queryJson<T>(sql: string): T[] {
        const dbPath = getDbPath();
        const result = execSync(`sqlite3 -json "${dbPath}" "${sql.replace(/"/g, '\\"')}"`, {
          encoding: "utf-8",
        });
        if (!result.trim()) return [];
        return JSON.parse(result);
      },
      execute(sql: string): void {
        const dbPath = getDbPath();
        const result = spawnSync("sqlite3", [dbPath], {
          input: sql,
          encoding: "utf-8",
        });
        if (result.error) throw result.error;
        if (result.status !== 0) {
          throw new Error(`SQLite error: ${result.stderr}`);
        }
      },
    };
  } catch {
    throw new Error(
      "SQLite is not available. Please either:\n" +
        "  1. Use Node.js 22.5+ (has built-in SQLite)\n" +
        "  2. Install sqlite3 CLI (brew install sqlite3 / apt install sqlite3)"
    );
  }
}

/**
 * Initialize the SQLite backend. Must be called before using other functions.
 */
export async function initDatabase(): Promise<void> {
  if (!cachedBackend) {
    cachedBackend = await detectBackend();
  }
}

/**
 * Get the backend, throwing if not initialized.
 */
function getBackend(): SqliteBackend {
  if (!cachedBackend) {
    throw new Error("Database not initialized. Call initDatabase() first.");
  }
  return cachedBackend;
}

// ============================================================================
// Public API (synchronous after initialization)
// ============================================================================

export function query(sql: string): string {
  return getBackend().query(sql);
}

export function queryJson<T>(sql: string): T[] {
  return getBackend().queryJson<T>(sql);
}

export function execute(sql: string): void {
  getBackend().execute(sql);
}

export function runScript(script: string): void {
  execute(script);
}

// ============================================================================
// Parameterized queries (node:sqlite backend only)
//
// query/queryJson/execute above predate multi-user support and take raw SQL
// text - fine for the CLI's own trusted queries, but not for code handling
// user-supplied values (emails, session ids, plan JSON). run/get/all below
// bind parameters instead of interpolating them into SQL strings.
// ============================================================================

function getNodeSqliteDb(): DatabaseSync {
  if (!cachedBackend) {
    throw new Error("Database not initialized. Call initDatabase() first.");
  }
  if (!nodeSqliteDb) {
    throw new Error(
      "Parameterized queries require the Node.js built-in SQLite backend (Node 22.5+) - " +
        "the sqlite3-CLI fallback does not support bound parameters."
    );
  }
  return nodeSqliteDb;
}

export function run(sql: string, params: SQLInputValue[] = []): StatementResultingChanges {
  return getNodeSqliteDb()
    .prepare(sql)
    .run(...params);
}

export function get<T>(sql: string, params: SQLInputValue[] = []): T | undefined {
  return getNodeSqliteDb()
    .prepare(sql)
    .get(...params) as T | undefined;
}

export function all<T>(sql: string, params: SQLInputValue[] = []): T[] {
  return getNodeSqliteDb()
    .prepare(sql)
    .all(...params) as T[];
}
