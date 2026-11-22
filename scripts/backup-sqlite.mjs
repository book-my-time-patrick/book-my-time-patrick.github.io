import { chmod, link, mkdtemp, open, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function verify(db) {
  const checks = db.prepare('PRAGMA integrity_check').all();
  if (checks.length !== 1 || checks[0].integrity_check !== 'ok') throw new Error('SQLite 完整性检查失败');
  if (db.prepare('PRAGMA foreign_key_check').get()) throw new Error('SQLite 外键检查失败');
  const migrations = db.prepare('SELECT name FROM d1_migrations ORDER BY id').all();
  if (!migrations.length) throw new Error('未找到预约站迁移记录');
  return migrations.at(-1).name;
}

async function snapshot(sourcePath, outputPath) {
  const output = resolve(outputPath);
  const directory = await mkdtemp(join(dirname(output), '.booking-snapshot-'));
  const temporary = join(directory, 'snapshot.sqlite');
  try {
    const source = new DatabaseSync(sourcePath, { readOnly: true });
    try {
      source.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
      source.prepare('VACUUM INTO ?').run(temporary);
    } finally {
      source.close();
    }
    await chmod(temporary, 0o600);
    const copy = new DatabaseSync(temporary, { readOnly: true });
    let migration;
    try { migration = verify(copy); } finally { copy.close(); }
    const file = await open(temporary, 'r');
    try { await file.sync(); } finally { await file.close(); }
    // Publish only the verified file. link() refuses to overwrite an existing backup.
    await link(temporary, output);
    return migration;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const [source, output, extra] = process.argv.slice(2);
if (!source || !output || extra !== undefined || resolve(source) === resolve(output)) {
  console.error('用法：node scripts/backup-sqlite.mjs <现有 SQLite> <新 SQLite 路径>');
  process.exitCode = 1;
} else {
  try {
    const migration = await snapshot(source, output);
    console.log(`快照已保存，SQLite 完整性和外键检查通过，最后迁移为 ${migration}。`);
  } catch (error) {
    console.error(error?.code === 'EEXIST' ? '目标已存在。请选择一个新文件名。' : '快照失败。请检查源库、目标目录和数据库完整性。');
    process.exitCode = 1;
  }
}
