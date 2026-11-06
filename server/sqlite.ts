import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import type { SQLInputValue } from 'node:sqlite';
import type { SqlDatabase, SqlStatement, SqlResult } from './db.js';

interface LocalSqlDatabase extends SqlDatabase {
  migrate(name: string, sql: string): void;
}

export function openSqlite(path: string): LocalSqlDatabase {
  const db = new DatabaseSync(path);
  if (path !== ':memory:') chmodSync(path, 0o600);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');
  function transaction<T>(work: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  class Statement implements SqlStatement {
    constructor(readonly query: string, readonly values: SQLInputValue[] = []) {}
    bind(...values: unknown[]) { return new Statement(this.query, values as SQLInputValue[]); }
    async first<T>(column?: string): Promise<T | null> {
      const row = db.prepare(this.query).get(...this.values);
      return row ? (column ? row[column] : row) as T : null;
    }
    async all<T>(): Promise<SqlResult<T>> {
      return { results: db.prepare(this.query).all(...this.values) as T[], success: true };
    }
    async run<T>(): Promise<SqlResult<T>> {
      const result = db.prepare(this.query).run(...this.values);
      return { results: [], meta: { changes: Number(result.changes) }, success: true };
    }
  }
  return {
    prepare(query) { return new Statement(query); },
    async exec(query) { db.exec(query); },
    migrate(name, sql) {
      transaction(() => {
        // Use Wrangler's default ledger so a restored D1 database retains its migration history.
        db.exec(`CREATE TABLE IF NOT EXISTS d1_migrations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT UNIQUE,
          applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
        )`);
        if (db.prepare('SELECT id FROM d1_migrations WHERE name=?').get(name)) return;
        db.exec(sql);
        db.prepare('INSERT INTO d1_migrations(name) VALUES(?)').run(name);
      });
    },
    async batch<T>(statements: SqlStatement[]): Promise<SqlResult<T>[]> {
      return transaction(() => {
        const results: SqlResult<T>[] = [];
        for (const stmt of statements as Statement[]) {
          const statement = db.prepare(stmt.query);
          // all() also executes INSERT/UPDATE RETURNING. D1 batch returns rows and changes.
          const rows = statement.all(...stmt.values) as T[];
          const change = db.prepare('SELECT changes() AS n').get()!;
          results.push({results:rows,meta:{changes:Number(change.n)},success:true});
        }
        return results;
      });
    },
  };
}
