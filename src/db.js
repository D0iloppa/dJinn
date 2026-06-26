'use strict';

const SQLite = require('better-sqlite3');
const { Schema } = require('./schema');
const { LRUCache } = require('./cache');
const { queryKey } = require('./hash');

class DJinn {
  constructor(dbPath, options = {}) {
    this.db = new SQLite(dbPath);
    this.db.pragma('journal_mode = WAL');  // 동시 읽기 성능
    this.db.pragma('foreign_keys = ON');
    this._collections = new Map();  // name → { schema, indexes }
    this._cache = new LRUCache(options.cacheSize ?? 256);
    this._stmts = new Map();        // 준비된 statement 재사용
  }

  // 컬렉션 등록 (테이블 없으면 생성)
  define(name, schema, options = {}) {
    if (!(schema instanceof Schema)) throw new Error('DJinn.define: schema must be a Schema instance');
    this._collections.set(name, { schema, indexes: options.indexes || [] });

    const cols = schema.toSQLColumns();
    const pk = options.primaryKey || 'id';
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${name} (
        ${pk} TEXT PRIMARY KEY,
${cols}
      )
    `);

    for (const field of (options.indexes || [])) {
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_${name}_${field} ON ${name}(${field})`);
    }
    return this;
  }

  // 단건 조회
  get(collection, id) {
    const cacheKey = queryKey(collection, { id });
    const hit = this._cache.get(cacheKey);
    if (hit !== undefined) return hit;

    const stmt = this._stmt(`SELECT * FROM ${collection} WHERE id = ?`, collection);
    const row = stmt.get(id);
    const result = row ? this._deserialize(collection, row) : null;
    this._cache.set(cacheKey, result);
    return result;
  }

  // 조건 조회 (where: { field: value } 단순 equality)
  find(collection, where = {}) {
    const cacheKey = queryKey(collection, where);
    const hit = this._cache.get(cacheKey);
    if (hit !== undefined) return hit;

    const entries = Object.entries(where);
    const sql = entries.length === 0
      ? `SELECT * FROM ${collection}`
      : `SELECT * FROM ${collection} WHERE ${entries.map(([k]) => `${k} = ?`).join(' AND ')}`;

    const stmt = this._stmt(sql, collection + JSON.stringify(where));
    const rows = stmt.all(...entries.map(([, v]) => v));
    const result = rows.map(r => this._deserialize(collection, r));
    this._cache.set(cacheKey, result);
    return result;
  }

  // 삽입 (id 필수)
  put(collection, id, doc) {
    const { schema } = this._getCollection(collection);
    const validated = schema.validate(doc);
    const allFields = { id, ...validated };
    const keys = Object.keys(allFields);
    const sql = `INSERT OR REPLACE INTO ${collection} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
    this._stmt(sql, `put:${collection}`).run(...Object.values(allFields));
    this._cache.invalidatePrefix(collection);
    return id;
  }

  // 삭제
  del(collection, id) {
    this._stmt(`DELETE FROM ${collection} WHERE id = ?`, `del:${collection}`).run(id);
    this._cache.invalidatePrefix(collection);
  }

  // 트랜잭션 (fn 안에서 put/del을 여러 번 호출)
  transaction(fn) {
    return this.db.transaction(fn)();
  }

  // 캐시 통계
  cacheStats() {
    return { size: this._cache.size, maxSize: this._cache.maxSize };
  }

  close() {
    this.db.close();
  }

  // --- internal ---

  _getCollection(name) {
    const col = this._collections.get(name);
    if (!col) throw new Error(`DJinn: unknown collection '${name}' — call define() first`);
    return col;
  }

  // statement 재사용 (prepare 비용 절감)
  _stmt(sql, key) {
    if (!this._stmts.has(key)) this._stmts.set(key, this.db.prepare(sql));
    return this._stmts.get(key);
  }

  _deserialize(collection, row) {
    const { schema } = this._getCollection(collection);
    const out = { ...row };
    for (const [name, def] of Object.entries(schema.fields)) {
      if (def.type === 'json' && typeof out[name] === 'string') {
        try { out[name] = JSON.parse(out[name]); } catch { /* 그대로 */ }
      }
      if (def.type === 'boolean') out[name] = Boolean(out[name]);
    }
    return out;
  }
}

module.exports = { DJinn };
