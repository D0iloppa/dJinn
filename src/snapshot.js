'use strict';

// 스냅샷 — DB 전체를 "row 하나 = JSON 파일 하나" 텍스트 트리로 내보내고 되읽는다.
// SQLite 바이너리 대신 이 트리를 git에 커밋하면 변경된 row만 diff로 남고, DB는 언제든
// 스냅샷에서 재생성 가능한 캐시가 된다.
//
// VecDriver/GraphDriver와 같은 attach 패턴. core db.js는 건드리지 않는다.
// define()된 컬렉션(= {id, doc} 테이블)만 대상이다 — vec 가상 테이블은 _collections에 없으므로
// 자연히 제외되고, '_' 접두 컬렉션(_sys 등 내부 설정·키)은 기본 제외한다.
//
// 트리 구조
//   <dir>/manifest.json                     { format, collections: { name: { indexes, count, sharded } } }
//   <dir>/<collection>/<file>.json          { id, doc, text? }      (row 수 ≤ shardThreshold)
//   <dir>/<collection>/<xx>/<file>.json                             (초과 시 fnv1a(id) 앞 2자리로 샤딩)
//   <dir>/<collection>/.../<file>.<n>.md    textFields로 뽑아낸 긴 문자열 (예: Markdown 본문)
//
// 결정론: 키 정렬·2칸 들여쓰기·LF 개행으로 직렬화하므로 같은 row는 항상 같은 바이트다.
// 내용이 같으면 파일을 다시 쓰지 않는다 (mtime·git 상태 불변).

const fs = require('fs');
const path = require('path');
const { fnv1a } = require('./hash');

const FORMAT = 'djinn-snapshot/1';
const NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const MAX_NAME = 120;

// 키 정렬 직렬화 — 배열 순서는 보존
function stableStringify(value) {
  const sort = (v) => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])]));
    }
    return v;
  };
  return JSON.stringify(sort(value), null, 2) + '\n';
}

// id → 파일명. 어떤 OS에서도 안전한 문자만 남기고, 대소문자만 다른 id(대소문자 무시 FS)나
// 너무 긴 id는 해시 접미사로 구분한다. 파일명은 식별용일 뿐 — import는 파일 안의 id를 쓴다.
function fileBase(id) {
  const enc = encodeURIComponent(id).replace(/[!'()*~.]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  const needsHash = enc.length > MAX_NAME || /[A-Z]/.test(id);
  return needsHash ? `${enc.slice(0, MAX_NAME)}~${fnv1a(id)}` : enc;
}

const getPath = (obj, dotted) => dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

function setPath(obj, dotted, value) {
  const keys = dotted.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) {
    if (o[k] == null || typeof o[k] !== 'object') return;
    o = o[k];
  }
  if (value === undefined) delete o[keys[keys.length - 1]];
  else o[keys[keys.length - 1]] = value;
}

function writeIfChanged(file, content) {
  try {
    if (fs.readFileSync(file, 'utf8') === content) return false;
  } catch { /* 없음 */ }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return true;
}

function walkFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkFiles(p));
    else out.push(p);
  }
  return out;
}

function removeEmptyDirs(dir) {
  if (!fs.existsSync(dir)) return;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) removeEmptyDirs(path.join(dir, ent.name));
  }
  if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
}

function readManifest(dir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    return m.format === FORMAT ? m : null;
  } catch {
    return null;
  }
}

class SnapshotDriver {
  static attach(djinn) {
    const driver = new SnapshotDriver(djinn);
    djinn._snapshot = driver;
    return driver;
  }

  constructor(djinn) {
    this._djinn = djinn;
  }

  // options:
  //   collections    : string[] | (name) => boolean — 대상 제한 (기본: '_' 접두 제외 전부)
  //   textFields     : { [collection]: string[] } — doc 안의 문자열 필드(점 경로)를 별도 .md 파일로
  //   shardThreshold : 이 row 수를 넘는 컬렉션은 2자리 해시 폴더로 샤딩 (기본 1000)
  // 반환: { collections, rows, written, deleted }
  exportTo(dir, options = {}) {
    const { textFields = {}, shardThreshold = 1000 } = options;
    const names = this._selectCollections(options.collections);
    const prev = readManifest(dir);
    const manifest = { format: FORMAT, collections: {} };
    const stats = { collections: names.length, rows: 0, written: 0, deleted: 0 };

    // 읽기는 한 트랜잭션 안에서 — 컬렉션 간 일관된 시점
    const dump = this._djinn.transaction(() =>
      names.map((name) => ({
        name,
        rows: this._djinn.db.prepare(`SELECT id, doc FROM ${name} ORDER BY id`).all(),
      }))
    );

    for (const { name, rows } of dump) {
      const colDir = path.join(dir, name);
      const sharded = rows.length > shardThreshold;
      const keep = new Set();
      const fields = textFields[name] || [];

      for (const row of rows) {
        const doc = JSON.parse(row.doc);
        const base = fileBase(row.id);
        const sub = sharded ? path.join(colDir, fnv1a(row.id).slice(0, 2)) : colDir;
        const wrapper = { id: row.id, doc };

        fields.forEach((field, i) => {
          const v = getPath(doc, field);
          if (typeof v !== 'string') return;
          const textFile = `${base}.${i}.md`;
          setPath(doc, field, undefined);
          (wrapper.text ||= {})[field] = textFile;
          const p = path.join(sub, textFile);
          keep.add(p);
          if (writeIfChanged(p, v)) stats.written++;
        });

        const p = path.join(sub, `${base}.json`);
        keep.add(p);
        if (writeIfChanged(p, stableStringify(wrapper))) stats.written++;
      }

      for (const f of walkFiles(colDir)) {
        if (!keep.has(f)) { fs.unlinkSync(f); stats.deleted++; }
      }
      removeEmptyDirs(colDir);

      manifest.collections[name] = { indexes: this._djinn._collections.get(name).indexes, count: rows.length, sharded };
      stats.rows += rows.length;
    }

    // 이전 스냅샷에는 있었지만 이번엔 대상이 아닌 컬렉션 폴더 정리
    for (const name of Object.keys(prev?.collections || {})) {
      if (manifest.collections[name] || !NAME_RE.test(name)) continue;
      const colDir = path.join(dir, name);
      for (const f of walkFiles(colDir)) { fs.unlinkSync(f); stats.deleted++; }
      removeEmptyDirs(colDir);
    }

    fs.mkdirSync(dir, { recursive: true });
    if (writeIfChanged(path.join(dir, 'manifest.json'), stableStringify(manifest))) stats.written++;
    return stats;
  }

  // 스냅샷을 DB에 반영한다. 컬렉션이 없으면 manifest의 indexes로 define 한다.
  // options:
  //   collections : 대상 제한 (exportTo와 동일 규칙)
  //   prune       : 스냅샷에 없는 row를 DB에서 지운다 (기본 true — DB를 스냅샷과 일치시킴)
  // 반환: { collections, rows, deleted }
  importFrom(dir, options = {}) {
    const { prune = true } = options;
    const manifest = readManifest(dir);
    if (!manifest) throw new Error(`SnapshotDriver: no ${FORMAT} manifest in '${dir}'`);

    const filter = this._filter(options.collections);
    const names = Object.keys(manifest.collections).filter((n) => NAME_RE.test(n) && filter(n));
    const stats = { collections: names.length, rows: 0, deleted: 0 };

    const plan = names.map((name) => {
      const colDir = path.resolve(dir, name);
      const rows = [];
      for (const f of walkFiles(colDir)) {
        if (!f.endsWith('.json')) continue;
        const w = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (typeof w.id !== 'string' || !w.doc || typeof w.doc !== 'object') {
          throw new Error(`SnapshotDriver: malformed row file '${f}'`);
        }
        for (const [field, textFile] of Object.entries(w.text || {})) {
          if (path.basename(textFile) !== textFile) throw new Error(`SnapshotDriver: bad text file ref in '${f}'`);
          setPath(w.doc, field, fs.readFileSync(path.join(path.dirname(f), textFile), 'utf8'));
        }
        rows.push(w);
      }
      return { name, rows };
    });

    for (const { name } of plan) {
      if (!this._djinn._collections.has(name)) {
        this._djinn.define(name, { indexes: manifest.collections[name].indexes || [] });
      }
    }

    this._djinn.transaction(() => {
      for (const { name, rows } of plan) {
        const put = this._djinn.db.prepare(`INSERT OR REPLACE INTO ${name} (id, doc) VALUES (?, ?)`);
        for (const r of rows) put.run(r.id, JSON.stringify(r.doc));
        stats.rows += rows.length;
        if (prune) {
          const ids = new Set(rows.map((r) => r.id));
          const del = this._djinn.db.prepare(`DELETE FROM ${name} WHERE id = ?`);
          for (const { id } of this._djinn.db.prepare(`SELECT id FROM ${name}`).all()) {
            if (!ids.has(id)) { del.run(id); stats.deleted++; }
          }
        }
      }
    });

    // raw SQL로 썼으므로 캐시 전체 무효화
    this._djinn.clearCache();
    return stats;
  }

  // --- internal ---

  _filter(collections) {
    if (typeof collections === 'function') return collections;
    if (Array.isArray(collections)) return (n) => collections.includes(n);
    return (n) => !n.startsWith('_');
  }

  _selectCollections(collections) {
    const filter = this._filter(collections);
    return [...this._djinn._collections.keys()].filter(filter).sort();
  }
}

module.exports = { SnapshotDriver, stableStringify, fileBase };
