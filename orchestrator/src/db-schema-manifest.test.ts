/**
 * Manifest of the schema of `timon.db`.
 *
 * The schema exists only as DDL strings replayed at every boot: no version
 * number, no description a reader can open. Whoever reads the database from
 * outside (an export, a backup, an audit tool) has to guess what a given
 * version of Timon holds, and a pull request that adds a column says so only
 * to someone who reads the right hunk of `db.ts`.
 *
 * `db-schema.json` is that description, versioned alongside the code. This
 * test builds a database in a fresh home, describes it by introspection and
 * compares the result to the file: a schema change fails it until the file is
 * regenerated, so the change shows up in the diff, table by table.
 *
 * The `fingerprint` names the schema of a FRESH install of this version. A
 * database upgraded from an older version can differ from it and still be
 * sound (columns in the order they were added, leftovers of a former table):
 * a reader that finds another fingerprint compares table by table before it
 * concludes anything.
 *
 * `TIMON_DB_SCHEMA_UPDATE=1` rewrites the file. It rewrites all of it, a
 * removal included: what an older version still needs is guarded elsewhere
 * (`db-downgrade-compat.test.ts`), not here.
 *
 * Scope: `timon.db` only. `integrations.db`, the events archive and the
 * plugins' own databases are other files, with other owners.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const { db } = await import('./db.js');
// Tables that live outside `db.ts`: two modules create theirs when they load,
// the others on first use. A new one is caught by the second test below.
await import('./backends/accounts.js');
await import('./backends/account-launch.js');
const { ensureDeviceSchema } = await import('./users/devices.js');
const { ensureEgressSchema } = await import('./egress/journal.js');
const { ensureMachineSchema } = await import('./machines/store.js');
const { ensureSecretRequestSchema } = await import('./secrets/requests.js');
const { ensureOutcomeTable } = await import('./plugins-bundled/todo-outcomes/store.js');
ensureDeviceSchema();
ensureEgressSchema();
ensureMachineSchema();
ensureSecretRequestSchema();
ensureOutcomeTable();

const SRC = dirname(fileURLToPath(import.meta.url));
const MANIFEST_FILE = join(SRC, 'db-schema.json');

/**
 * Files whose `CREATE TABLE` is not about `timon.db`: another database file,
 * or a fixture that builds an old schema on purpose.
 */
const OTHER_DATABASES = new Set([
  'plugins/integration-store.ts',
  'plugins/user-connections.ts',
  'data-version-fixtures.ts',
]);

/** Tables that exist only during a rebuild, renamed before the migration ends. */
const TRANSIENT = new Set(['ui_layout_new']);

type Column = { name: string; type: string; notNull: boolean; default: string | null; primaryKey: number };
type Index = { unique: boolean; origin: string; columns: (string | null)[]; sql: string | null };
type ForeignKey = {
  columns: string[];
  references: string;
  referencedColumns: (string | null)[];
  onUpdate: string;
  onDelete: string;
};
type Table = {
  kind: 'table' | 'virtual';
  withoutRowid: boolean;
  /** Only for a virtual table: its module and options are nowhere else. */
  sql?: string;
  columns: Column[];
  indexes: Record<string, Index>;
  foreignKeys: ForeignKey[];
  triggers: Record<string, string>;
};
type Manifest = { _comment: string; fingerprint: string; tables: Record<string, Table> };

/** One line, single spaces: the layout of a DDL string is not a schema change. */
function oneLine(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

function sorted<T>(entries: [string, T][]): Record<string, T> {
  return Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function masterSql(type: string, name: string): string | null {
  const row = db.prepare('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?').get(type, name) as
    | { sql: string | null }
    | undefined;
  return row?.sql ? oneLine(row.sql) : null;
}

function describeTable(name: string, kind: 'table' | 'virtual', withoutRowid: boolean): Table {
  const columns = (
    db.prepare(`PRAGMA table_info("${name}")`).all() as {
      name: string; type: string; notnull: number; dflt_value: string | null; pk: number;
    }[]
  ).map((c) => ({ name: c.name, type: c.type, notNull: c.notnull === 1, default: c.dflt_value, primaryKey: c.pk }));

  const indexes = (
    db.prepare(`PRAGMA index_list("${name}")`).all() as { name: string; unique: number; origin: string }[]
  ).map((index): [string, Index] => {
    const keys = db.prepare(`PRAGMA index_xinfo("${index.name}")`).all() as { name: string | null; key: number }[];
    return [index.name, {
      unique: index.unique === 1,
      origin: index.origin,
      // `null` is an expression: the statement below says which.
      columns: keys.filter((k) => k.key === 1).map((k) => k.name),
      sql: masterSql('index', index.name),
    }];
  });

  const byId = new Map<number, ForeignKey>();
  const rows = db.prepare(`PRAGMA foreign_key_list("${name}")`).all() as {
    id: number; seq: number; table: string; from: string; to: string | null; on_update: string; on_delete: string;
  }[];
  for (const row of rows.sort((a, b) => a.id - b.id || a.seq - b.seq)) {
    const key = byId.get(row.id)
      ?? { columns: [], references: row.table, referencedColumns: [], onUpdate: row.on_update, onDelete: row.on_delete };
    key.columns.push(row.from);
    key.referencedColumns.push(row.to);
    byId.set(row.id, key);
  }
  const foreignKeys = [...byId.values()].sort((a, b) => {
    const x = JSON.stringify(a);
    const y = JSON.stringify(b);
    return x < y ? -1 : x > y ? 1 : 0;
  });

  const triggers = (
    db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?").all(name) as {
      name: string; sql: string;
    }[]
  ).map((t): [string, string] => [t.name, oneLine(t.sql)]);

  return {
    kind,
    withoutRowid,
    ...(kind === 'virtual' ? { sql: masterSql('table', name) ?? '' } : {}),
    columns,
    indexes: sorted(indexes),
    foreignKeys,
    triggers: sorted(triggers),
  };
}

function describeSchema(): Record<string, Table> {
  // `table_list` tells a virtual table from the shadow tables it creates,
  // which are an implementation detail of the module and not ours to describe.
  const tables = db.prepare("PRAGMA table_list").all() as { schema: string; name: string; type: string; wr: number }[];
  return sorted(
    tables
      .filter((t) => t.schema === 'main' && (t.type === 'table' || t.type === 'virtual') && !t.name.startsWith('sqlite_'))
      .map((t): [string, Table] => [t.name, describeTable(t.name, t.type as 'table' | 'virtual', t.wr === 1)]),
  );
}

function fingerprintOf(tables: Record<string, Table>): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(tables)).digest('hex')}`;
}

const actual = describeSchema();

if (process.env.TIMON_DB_SCHEMA_UPDATE === '1') {
  const manifest: Manifest = {
    _comment: 'Schema of timon.db as this version creates it in a fresh home. Generated: never edit by hand. '
      + 'Regenerate with TIMON_DB_SCHEMA_UPDATE=1 npm test -- src/db-schema-manifest.test.ts',
    fingerprint: fingerprintOf(actual),
    tables: actual,
  };
  writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2) + '\n');
}

const manifest = JSON.parse(readFileSync(MANIFEST_FILE, 'utf8')) as Manifest;

test('db-schema.json describes the schema this version creates', () => {
  const names = new Set([...Object.keys(actual), ...Object.keys(manifest.tables)]);
  const changed = [...names]
    .filter((name) => JSON.stringify(actual[name]) !== JSON.stringify(manifest.tables[name]))
    .sort()
    .map((name) => (!(name in manifest.tables) ? `${name} (new)` : !(name in actual) ? `${name} (gone)` : name));
  assert.deepEqual(
    changed,
    [],
    'the schema changed: regenerate db-schema.json with '
      + 'TIMON_DB_SCHEMA_UPDATE=1 npm test -- src/db-schema-manifest.test.ts, and commit it with the change',
  );
  assert.equal(manifest.fingerprint, fingerprintOf(actual), 'db-schema.json was edited by hand: regenerate it');
});

/** Every `.ts` file under `dir` that is not a test, as a path relative to `src/`. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__fixtures__' ? [] : sourceFiles(path);
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) return [];
    return [relative(SRC, path).split(sep).join('/')];
  });
}

test('every table the daemon creates in timon.db is in the manifest', () => {
  // A table created on first use, in a module this file does not load, would
  // be missing from the manifest with nothing to say so.
  const missing: string[] = [];
  for (const file of sourceFiles(SRC)) {
    if (OTHER_DATABASES.has(file)) continue;
    const source = readFileSync(join(SRC, file), 'utf8');
    // The `(` or `USING` after the name tells a statement from a sentence in a
    // comment. A dotted name is a table of an attached database, not of ours.
    const statement = /CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([A-Za-z_]\w*)"?(?:\s*\(|\s+USING\b)/g;
    for (const match of source.matchAll(statement)) {
      const table = match[1]!;
      if (!(table in manifest.tables) && !TRANSIENT.has(table)) missing.push(`${table} (${file})`);
    }
  }
  assert.deepEqual(
    [...new Set(missing)].sort(),
    [],
    'a table is created outside what this test loads: load its module at the top of this file, '
      + 'or list the file in OTHER_DATABASES if it is not about timon.db',
  );
});
