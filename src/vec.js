'use strict';

// sqlite-vec은 attach() 시점에 lazy 로드 — 설치/네이티브 바이너리 문제가 있어도
// VecDriver를 쓰지 않는 사용자는 패키지 require 자체가 막히지 않는다(옵트인 철학).
let sqliteVec = null;
function loadSqliteVec() {
  if (!sqliteVec) {
    try {
      sqliteVec = require('sqlite-vec');
    } catch {
      throw new Error('VecDriver requires sqlite-vec: npm install sqlite-vec');
    }
  }
  return sqliteVec;
}

// collection 이름은 SQL에 보간되므로 반드시 검증 (GraphDriver NS_RE와 동일 규칙)
const NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

class VecDriver {
  // Load extension into DJinn instance and store ref on it
  static attach(djinn) {
    loadSqliteVec().load(djinn.db);
    const driver = new VecDriver(djinn.db);
    djinn._vec = driver;
    return driver;
  }

  constructor(db) {
    this._db = db;
    this._defined = new Set(); // collections with vec tables
  }

  // Create vec0 virtual table + shadow map for text id→rowid
  define(collection, dim = 1536) {
    if (!NAME_RE.test(collection)) {
      throw new Error(`VecDriver: invalid collection name '${collection}'`);
    }
    if (!Number.isInteger(dim) || dim < 1) {
      throw new Error(`VecDriver: invalid dim '${dim}'`);
    }
    this._db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS ${collection}_vec
        USING vec0(embedding float[${dim}]);
      CREATE TABLE IF NOT EXISTS ${collection}_vec_map (
        doc_id    TEXT PRIMARY KEY,
        vec_rowid INTEGER UNIQUE
      );
    `);
    this._defined.add(collection);
    return this;
  }

  // Insert or replace vector for a doc id — 4개 write를 하나의 트랜잭션으로 묶어
  // 중간 실패 시 vec 테이블/map 불일치(고아 벡터·매핑 유실)를 방지한다.
  upsert(collection, docId, embedding) {
    this._assertDefined(collection);
    this._db.transaction(() => {
      const existing = this._db.prepare(
        `SELECT vec_rowid FROM ${collection}_vec_map WHERE doc_id = ?`
      ).get(docId);

      if (existing) {
        this._db.prepare(`DELETE FROM ${collection}_vec WHERE rowid = ?`).run(existing.vec_rowid);
        this._db.prepare(`DELETE FROM ${collection}_vec_map WHERE doc_id = ?`).run(docId);
      }

      const buf = new Float32Array(embedding);
      const { lastInsertRowid } = this._db.prepare(
        `INSERT INTO ${collection}_vec(embedding) VALUES (?)`
      ).run(buf);

      this._db.prepare(
        `INSERT INTO ${collection}_vec_map(doc_id, vec_rowid) VALUES (?, ?)`
      ).run(docId, lastInsertRowid);
    })();
  }

  // k-nearest neighbor search → [{ id, distance }]
  search(collection, embedding, k = 10) {
    this._assertDefined(collection);
    const buf = new Float32Array(embedding);
    const rows = this._db.prepare(`
      SELECT rowid, distance
      FROM ${collection}_vec
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT ?
    `).all(buf, k);

    if (!rows.length) return [];

    const placeholders = rows.map(() => '?').join(',');
    const distMap = new Map(rows.map(r => [Number(r.rowid), r.distance]));
    const mapped = this._db.prepare(
      `SELECT doc_id, vec_rowid FROM ${collection}_vec_map WHERE vec_rowid IN (${placeholders})`
    ).all(...rows.map(r => r.rowid));

    return mapped
      .map(r => ({ id: r.doc_id, distance: distMap.get(Number(r.vec_rowid)) }))
      .sort((a, b) => a.distance - b.distance);
  }

  // Remove vector for a doc id — upsert와 동일하게 원자적으로 처리
  delete(collection, docId) {
    this._assertDefined(collection);
    this._db.transaction(() => {
      const existing = this._db.prepare(
        `SELECT vec_rowid FROM ${collection}_vec_map WHERE doc_id = ?`
      ).get(docId);
      if (!existing) return;
      this._db.prepare(`DELETE FROM ${collection}_vec WHERE rowid = ?`).run(existing.vec_rowid);
      this._db.prepare(`DELETE FROM ${collection}_vec_map WHERE doc_id = ?`).run(docId);
    })();
  }

  // Count indexed vectors in a collection
  count(collection) {
    this._assertDefined(collection);
    return this._db.prepare(`SELECT COUNT(*) AS n FROM ${collection}_vec_map`).get().n;
  }

  // --- internal ---

  _assertDefined(collection) {
    if (!this._defined.has(collection)) {
      throw new Error(`VecDriver: unknown collection '${collection}' — call define() first`);
    }
  }
}

module.exports = { VecDriver };
