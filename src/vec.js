'use strict';

let sqliteVec;
try {
  sqliteVec = require('sqlite-vec');
} catch {
  throw new Error('VecDriver requires sqlite-vec: npm install sqlite-vec');
}

class VecDriver {
  // Load extension into DJinn instance and store ref on it
  static attach(djinn) {
    sqliteVec.load(djinn.db);
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

  // Insert or replace vector for a doc id
  upsert(collection, docId, embedding) {
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
  }

  // k-nearest neighbor search → [{ id, distance }]
  search(collection, embedding, k = 10) {
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

  // Remove vector for a doc id
  delete(collection, docId) {
    const existing = this._db.prepare(
      `SELECT vec_rowid FROM ${collection}_vec_map WHERE doc_id = ?`
    ).get(docId);
    if (!existing) return;
    this._db.prepare(`DELETE FROM ${collection}_vec WHERE rowid = ?`).run(existing.vec_rowid);
    this._db.prepare(`DELETE FROM ${collection}_vec_map WHERE doc_id = ?`).run(docId);
  }

  // Count indexed vectors in a collection
  count(collection) {
    return this._db.prepare(`SELECT COUNT(*) AS n FROM ${collection}_vec_map`).get().n;
  }
}

module.exports = { VecDriver };
