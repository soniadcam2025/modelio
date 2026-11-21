// Daily off-site backup: every dashboard table from Supabase, written to a separate Cloudflare D1 database
// (binding BACKUP_DB, e.g. `shakhira-backups`). Supabase Free has no downloadable backups; this gives 14 days
// of restorable copies on a different provider at no cost. Restore with supabase/tools/restore-backup.mjs.

export const BACKUP_SCHEMA = `CREATE TABLE IF NOT EXISTS backup_parts (backup_id INTEGER NOT NULL, table_name TEXT NOT NULL, part INTEGER NOT NULL,
  rows INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (backup_id, table_name, part))`;
export const KEEP_DAYS = 14;
const PART_BYTES = 90_000; // D1 statements are limited to 100 KB

export function splitRows(rows, limit = PART_BYTES) {
  const parts = [];
  let cur = [], size = 2;
  for (const r of rows) {
    const s = JSON.stringify(r).length + 1;
    if (cur.length && size + s > limit) { parts.push(cur); cur = []; size = 2; }
    cur.push(r); size += s;
  }
  if (cur.length || !parts.length) parts.push(cur);
  return parts;
}

export async function runBackup(ops, backupDb, now) {
  await backupDb.prepare(BACKUP_SCHEMA).run();
  const data = await ops.exportAll();
  const statements = [];
  let rows = 0, bytes = 0;
  for (const [table, list] of Object.entries(data.tables)) {
    splitRows(list).forEach((part, i) => {
      const json = JSON.stringify(part);
      rows += part.length; bytes += json.length;
      statements.push(backupDb.prepare("INSERT OR REPLACE INTO backup_parts (backup_id, table_name, part, rows, json) VALUES (?, ?, ?, ?, ?)")
        .bind(now, table, i, part.length, json));
    });
  }
  statements.push(backupDb.prepare("DELETE FROM backup_parts WHERE backup_id < ?").bind(now - KEEP_DAYS * 86400));
  await backupDb.batch(statements); // one transaction: a backup is stored completely or not at all
  await ops.run("INSERT INTO backups_log (created_at, kind, rows, bytes, note) VALUES (?, 'daily', ?, ?, ?)", now, rows, bytes, `d1 backup_id ${now}`);
  await ops.setSetting("backup:last", now);
  return { backup_id: now, rows, bytes, tables: Object.keys(data.tables).length };
}

// Rebuild the export format from one stored backup (used by the restore tool and tests).
export async function readBackup(backupDb, backupId) {
  const res = await backupDb.prepare("SELECT table_name, part, json FROM backup_parts WHERE backup_id = ? ORDER BY table_name, part").bind(backupId).all();
  const tables = {};
  for (const r of res.results || []) (tables[r.table_name] ||= []).push(...JSON.parse(r.json));
  return { format: "shakhira-backup-v1", exported_at: backupId, tables };
}
