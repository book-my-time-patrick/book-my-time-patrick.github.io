import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openSqlite } from '../server/sqlite.js';

const businessTables = ['owners', 'passkeys', 'invites', 'booking_requests', 'open_sessions', 'mailboxes', 'calendar_sources'] as const;
const migrationDir = new URL('../migrations/', import.meta.url);
type Database = ReturnType<typeof openSqlite>;

async function migrationNames(db: Database) {
  const { results } = await db.prepare('SELECT name FROM d1_migrations ORDER BY id').all<{ name: string }>();
  return results.map(row => row.name);
}

async function verifyIntegrity(db: Database) {
  const { results } = await db.prepare('PRAGMA integrity_check').all<{ integrity_check: string }>();
  if (results.length !== 1 || results[0].integrity_check !== 'ok') throw new Error('SQLite 完整性检查失败');
  if (await db.prepare('PRAGMA foreign_key_check').first()) throw new Error('外键检查失败');
}

async function businessCounts(db: Database) {
  return Promise.all(businessTables.map(table =>
    db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<number>('n')));
}

async function verifyExport(source: string) {
  const migrations = (await readdir(migrationDir)).filter(name => name.endsWith('.sql')).sort();
  const sql = await readFile(source, 'utf8');
  if (!sql.trim()) throw new Error('SQL 导出为空');
  const temporary = await mkdtemp(join(tmpdir(), 'booking-d1-verify-'));
  const database = join(temporary, 'restored.sqlite');
  try {
    const importer = new DatabaseSync(database, { enableForeignKeyConstraints: false });
    try {
      // Wrangler can interleave schema and rows before all referenced tables exist.
      // SQLite parses the full export and we explicitly validate all foreign keys below.
      try { importer.exec(sql); }
      catch { throw new Error('SQL 导入失败，请核对 Wrangler 导出是否完整'); }
    } finally {
      importer.close();
    }

    const db = openSqlite(database);
    try {
      await verifyIntegrity(db);
      const restored = await migrationNames(db);
      if (!restored.length || restored.some((name, index) => name !== migrations[index])) {
        throw new Error('导出的迁移记录与当前仓库不一致');
      }
      const before = await businessCounts(db);
      if (before[0] !== 1) throw new Error('正式站管理员记录缺失');
      for (const name of migrations.slice(restored.length)) {
        try { db.migrate(name, await readFile(new URL(name, migrationDir), 'utf8')); }
        catch { throw new Error(`隔离迁移失败（${name}）`); }
      }
      await verifyIntegrity(db);
      const after = await businessCounts(db);
      if (before.some((count, index) => count !== after[index])) throw new Error('迁移前后的业务记录数量不一致');
      if ((await migrationNames(db)).join('\n') !== migrations.join('\n')) throw new Error('隔离迁移记录不完整');
      return { restoredThrough: restored.at(-1), verifiedThrough: migrations.at(-1), applied: migrations.slice(restored.length) };
    } finally {
      db.close();
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

const [source, extra] = process.argv.slice(2);
if (!source || extra !== undefined) {
  console.error('用法：node --import tsx scripts/verify-d1-export.ts <可信的 Wrangler SQL 导出>');
  process.exitCode = 1;
} else {
  try {
    const result = await verifyExport(source);
    console.log(JSON.stringify(result));
  } catch (error) {
    // Avoid copying an export statement or row value to release logs.
    const message = error instanceof Error && /^(SQL 导出为空|SQL 导入失败|SQLite 完整性检查失败|外键检查失败|导出的迁移记录|正式站管理员记录缺失|隔离迁移失败|迁移前后的业务记录|隔离迁移记录)/.test(error.message)
      ? error.message : '无法读取或验证该 SQL 导出';
    console.error(message);
    process.exitCode = 1;
  }
}
