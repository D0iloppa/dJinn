'use strict';

/**
 * DJinn v1 → v2 마이그레이션
 *
 * v1: 컬렉션별 고정 컬럼 (title, grp, source, target, ...)
 * v2: {id TEXT PK, doc TEXT} — JSON blob 단일 컬럼
 *
 * 실행: node migrations/v1_to_v2.js <db_path>
 */

const SQLite = require('better-sqlite3');
const path   = require('path');

const dbPath = process.argv[2] || path.join(__dirname, '../../../data/notion_meta.db');
const db = new SQLite(dbPath);

// 이미 v2인지 확인
const cols = db.prepare('PRAGMA table_info(nodes)').all().map(c => c.name);
if (cols.includes('doc') && !cols.includes('title')) {
  console.log('[migrate] already v2 — nothing to do.');
  db.close();
  process.exit(0);
}

console.log('[migrate] v1 → v2 시작:', dbPath);

const migrate = db.transaction(() => {
  // ── nodes ──
  db.exec(`CREATE TABLE nodes_v2 (id TEXT PRIMARY KEY, doc TEXT NOT NULL)`);
  db.exec(`
    INSERT INTO nodes_v2 (id, doc)
    SELECT id, json_object(
      'title',    COALESCE(title, '(제목 없음)'),
      'grp',      COALESCE(grp, 'root'),
      'url',      url,
      'tags',     json(COALESCE(NULLIF(tags, ''), '[]')),
      'nodeType', COALESCE(nodeType, 'page'),
      'excerpt',  COALESCE(excerpt, '')
    ) FROM nodes
  `);
  db.exec(`DROP TABLE nodes`);
  db.exec(`ALTER TABLE nodes_v2 RENAME TO nodes`);

  // ── edges ──
  db.exec(`CREATE TABLE edges_v2 (id TEXT PRIMARY KEY, doc TEXT NOT NULL)`);
  db.exec(`
    INSERT INTO edges_v2 (id, doc)
    SELECT id, json_object(
      'source',   source,
      'target',   target,
      'edgeType', COALESCE(edgeType, 'child')
    ) FROM edges
  `);
  db.exec(`DROP TABLE edges`);
  db.exec(`ALTER TABLE edges_v2 RENAME TO edges`);

  // ── meta ──
  db.exec(`CREATE TABLE meta_v2 (id TEXT PRIMARY KEY, doc TEXT NOT NULL)`);
  db.exec(`
    INSERT INTO meta_v2 (id, doc)
    SELECT id, json_object('value', value) FROM meta
  `);
  db.exec(`DROP TABLE meta`);
  db.exec(`ALTER TABLE meta_v2 RENAME TO meta`);

  // 버전 마커
  db.exec(`INSERT OR REPLACE INTO meta VALUES ('version', '{"value":"2"}')`);
});

migrate();

// 인덱스 재생성 (DROP TABLE이 구 인덱스를 자동 제거함)
db.exec(`CREATE INDEX IF NOT EXISTS idx_nodes___grp      ON nodes(json_extract(doc, '$.grp'))`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_nodes___nodeType ON nodes(json_extract(doc, '$.nodeType'))`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_edges___source   ON edges(json_extract(doc, '$.source'))`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_edges___target   ON edges(json_extract(doc, '$.target'))`);

const nodeCount = db.prepare('SELECT COUNT(*) AS n FROM nodes').get().n;
const edgeCount = db.prepare('SELECT COUNT(*) AS n FROM edges').get().n;
console.log(`[migrate] 완료 — nodes: ${nodeCount}, edges: ${edgeCount}`);

db.close();
