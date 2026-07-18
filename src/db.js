'use strict';

const SQLite = require('better-sqlite3');
const { LRUCache } = require('./cache');
const { HitMap } = require('./hitmap');
const { queryKey } = require('./hash');

// 식별자(테이블/컬렉션 이름) — SQL에 보간되므로 반드시 검증
const NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

// JSON 경로 — where 키·orderBy·인덱스 경로가 전부 SQL 문자열에 보간되므로
// 유니코드 문자/숫자/언더스코어 세그먼트만 허용 (SQL 인젝션 차단)
const PATH_RE = /^\$(\.[\p{L}\p{N}_]+)+$/u;

// '$.field' or 'field' → '$.field' (검증 포함)
const toPath = (key) => {
  const path = String(key).startsWith('$.') ? String(key) : `$.${key}`;
  if (!PATH_RE.test(path)) throw new Error(`DJinn: invalid JSON path '${key}'`);
  return path;
};

// SQL-safe index name from json path (e.g. '$.grp' → '__grp')
const pathToIdxSuffix = (path) => path.replace(/[^a-zA-Z0-9]/g, '_');

class DJinn {
  constructor(dbPath, options = {}) {
    this.db = new SQLite(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this._collections = new Map();  // name → { indexes }
    this._cache = new LRUCache(options.cacheSize ?? 256);
    this._hitmap = new HitMap();
    this._stmts = new Map();
  }

  // 컬렉션 등록 — 스키마 없음. indexes는 JSON 경로 (e.g. 'grp' or '$.grp')
  // 항목이 배열이면 복합 표현식 인덱스 생성 (두 번째 이후 컬럼은 COLLATE NOCASE) —
  // find()의 'ORDER BY … COLLATE NOCASE'와 콜레이션을 맞춰 인덱스가 정렬에도 쓰이게 한다.
  define(name, options = {}) {
    if (!NAME_RE.test(name)) throw new Error(`DJinn: invalid collection name '${name}'`);
    this._collections.set(name, { indexes: options.indexes || [] });

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${name} (
        id  TEXT PRIMARY KEY,
        doc TEXT NOT NULL
      )
    `);

    for (const field of (options.indexes || [])) {
      if (Array.isArray(field)) {
        const paths = field.map(toPath);
        const idxName = `idx_${name}${paths.map(pathToIdxSuffix).join('')}`;
        const cols = paths.map((path, i) =>
          i === 0
            ? `json_extract(doc, '${path}')`
            : `json_extract(doc, '${path}') COLLATE NOCASE`
        ).join(', ');
        this.db.exec(
          `CREATE INDEX IF NOT EXISTS ${idxName} ON ${name}(${cols})`
        );
      } else {
        const path = toPath(field);
        this.db.exec(
          `CREATE INDEX IF NOT EXISTS idx_${name}${pathToIdxSuffix(path)} ` +
          `ON ${name}(json_extract(doc, '${path}'))`
        );
      }
    }
    return this;
  }

  // 단건 조회 → { id, ...doc } | null
  get(collection, id) {
    this._getCollection(collection);
    const cacheKey = queryKey(collection, { id });
    const label = `${collection}[id=${id}]`;
    const hit = this._cache.get(cacheKey);
    if (hit !== undefined) { this._hitmap.recordHit(cacheKey, label); return hit; }
    this._hitmap.recordMiss(cacheKey, label);

    const row = this._stmt(`SELECT id, doc FROM ${collection} WHERE id = ?`, `get:${collection}`).get(id);
    const result = row ? { id: row.id, ...JSON.parse(row.doc) } : null;
    this._cache.set(cacheKey, result);
    return result;
  }

  // 조건 조회 → [{ id, ...doc }]
  // where 키: 'grp' 또는 '$.grp' 모두 허용. 값에 % 포함 시 LIKE
  // options: { limit, offset, orderBy, orderDir }
  //   orderBy: JSON 경로 (예: 'title', 'props.저자') — '$.필드' 형식도 허용
  //   orderDir: 'asc' | 'desc' (기본 'asc')
  find(collection, where = {}, options = {}) {
    this._getCollection(collection);
    const norm = this._normalizeWhere(where);
    const { limit, offset, orderBy, orderDir = 'asc' } = options;
    const optKey = orderBy ? `|ob=${orderBy}:${orderDir}` : '';
    const pgKey  = (limit != null || offset) ? `|p=${offset ?? 0},${limit ?? '*'}` : '';
    const cacheKey = queryKey(collection, norm) + optKey + pgKey;
    const label = `${collection}[${Object.entries(norm).map(([k, v]) => `${k}=${v}`).join(',')}]`;
    const hit = this._cache.get(cacheKey);
    if (hit !== undefined) { this._hitmap.recordHit(cacheKey, label); return hit; }
    this._hitmap.recordMiss(cacheKey, label);

    let { sql, vals, shape } = this._buildWhere(`SELECT id, doc FROM ${collection}`, norm);
    if (orderBy) {
      const path = toPath(orderBy);
      sql += ` ORDER BY json_extract(doc, '${path}') COLLATE NOCASE ${orderDir === 'desc' ? 'DESC' : 'ASC'}`;
    }
    if (limit  != null) sql += ` LIMIT ${Number(limit)}`;
    if (offset)         sql += ` OFFSET ${Number(offset)}`;

    const rows = this._stmt(sql, `find:${collection}:${shape}${optKey}${pgKey}`).all(...vals);
    const result = rows.map(r => ({ id: r.id, ...JSON.parse(r.doc) }));
    if (!limit && !offset) this._cache.set(cacheKey, result);
    return result;
  }

  // CSV 직렬화 유틸리티
  // columns: string[] — 'field' 또는 'field:헤더별칭' 형식
  // getVal: (record, field) => string — 커스텀 값 추출 (기본: record[field])
  toCSV(records, columns, getVal) {
    const cols = columns.map(c => {
      const [field, header] = c.split(':');
      return { field: field.trim(), header: (header || field).trim() };
    });
    const defaultGet = (rec, field) => {
      if (field === 'id') return rec.id ?? '';
      const v = rec[field];
      if (Array.isArray(v)) return v.join(';');
      return v == null ? '' : String(v);
    };
    const resolver = getVal || defaultGet;
    const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
    const lines = [
      cols.map(c => esc(c.header)).join(','),
      ...records.map(r => cols.map(c => esc(resolver(r, c.field))).join(',')),
    ];
    return lines.join('\n');
  }

  // 복수 ID 조회 — WHERE id IN (...) + 정렬·페이징 지원
  // options: { orderBy, orderDir, limit, offset } (find()와 동일)
  findByIds(collection, ids, options = {}) {
    this._getCollection(collection);
    if (!ids.length) return [];
    const { limit, offset, orderBy, orderDir = 'asc' } = options;
    const placeholders = ids.map(() => '?').join(',');
    let sql = `SELECT id, doc FROM ${collection} WHERE id IN (${placeholders})`;
    if (orderBy) {
      const path = toPath(orderBy);
      sql += ` ORDER BY json_extract(doc, '${path}') COLLATE NOCASE ${orderDir === 'desc' ? 'DESC' : 'ASC'}`;
    }
    if (limit  != null) sql += ` LIMIT ${Number(limit)}`;
    if (offset)         sql += ` OFFSET ${Number(offset)}`;
    return this.db.prepare(sql).all(...ids).map(r => ({ id: r.id, ...JSON.parse(r.doc) }));
  }

  // 카운트 → number
  count(collection, where = {}) {
    this._getCollection(collection);
    const norm = this._normalizeWhere(where);
    const { sql, vals, shape } = this._buildWhere(`SELECT COUNT(*) AS n FROM ${collection}`, norm);
    return this._stmt(sql, `count:${collection}:${shape}`).get(...vals).n;
  }

  // 삽입/교체 — 객체 그대로 JSON.stringify
  put(collection, id, doc) {
    this._getCollection(collection);
    this._stmt(
      `INSERT OR REPLACE INTO ${collection} (id, doc) VALUES (?, ?)`,
      `put:${collection}`
    ).run(id, JSON.stringify(doc));
    this._cache.invalidatePrefix(collection);
    return id;
  }

  // 삭제
  del(collection, id) {
    this._stmt(`DELETE FROM ${collection} WHERE id = ?`, `del:${collection}`).run(id);
    this._cache.invalidatePrefix(collection);
  }

  // 트랜잭션
  transaction(fn) {
    return this.db.transaction(fn)();
  }

  cacheStats() { return { size: this._cache.size, maxSize: this._cache.maxSize }; }

  heatmap() {
    return {
      global: {
        totalHits:     this._hitmap.totalHits,
        totalMisses:   this._hitmap.totalMisses,
        totalAccess:   this._hitmap.totalAccess,
        globalHitRate: this._hitmap.globalHitRate,
      },
      byCollection: this._hitmap.byCollection(),
      keys:         this._hitmap.snapshot(),
      coldKeys:     this._hitmap.coldKeys(),
    };
  }

  resetHeatmap() { this._hitmap.reset(); }

  close() { this.db.close(); }

  // --- internal ---

  _getCollection(name) {
    const col = this._collections.get(name);
    if (!col) throw new Error(`DJinn: unknown collection '${name}' — call define() first`);
    return col;
  }

  _normalizeWhere(where) {
    return Object.fromEntries(Object.entries(where).map(([k, v]) => [toPath(k), v]));
  }

  // shape: 경로+연산자만으로 구성한 SQL 형태 키 — 값은 ?로 바인딩되어 SQL에 영향이 없으므로
  // statement 캐시 키에서 제외한다(값 포함 시 distinct 값마다 statement가 무한 누적).
  _buildWhere(base, norm) {
    const entries = Object.entries(norm);
    if (!entries.length) return { sql: base, vals: [], shape: '' };
    const clause = entries.map(([path, v]) =>
      String(v).includes('%')
        ? `json_extract(doc, '${path}') LIKE ?`
        : `json_extract(doc, '${path}') = ?`
    ).join(' AND ');
    const shape = entries.map(([path, v]) => path + (String(v).includes('%') ? '~' : '=')).join(',');
    return { sql: `${base} WHERE ${clause}`, vals: entries.map(([, v]) => v), shape };
  }

  _stmt(sql, key) {
    if (!this._stmts.has(key)) this._stmts.set(key, this.db.prepare(sql));
    return this._stmts.get(key);
  }
}

module.exports = { DJinn };
