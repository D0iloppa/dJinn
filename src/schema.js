'use strict';

// 지원 타입
const TYPES = new Set(['string', 'number', 'boolean', 'json']);

class Schema {
  // fields: { fieldName: { type, required?, default? } }
  constructor(fields) {
    for (const [name, def] of Object.entries(fields)) {
      if (!TYPES.has(def.type)) throw new Error(`Schema: unknown type '${def.type}' for field '${name}'`);
    }
    this.fields = fields;
  }

  // 삽입/업데이트 전 검증 + default 적용 → 정규화된 객체 반환
  // 선택적 필드가 없어도 항상 모든 필드를 포함 (null) — put SQL이 컬렉션마다 고정됨
  validate(doc) {
    const out = {};
    for (const [name, def] of Object.entries(this.fields)) {
      let val = doc[name];
      if (val === undefined || val === null) {
        if (def.required) throw new Error(`Schema: required field '${name}' missing`);
        val = def.default !== undefined
          ? (typeof def.default === 'function' ? def.default() : def.default)
          : null;
      }
      out[name] = val === null ? null : this._coerce(name, val, def.type);
    }
    return out;
  }

  // SQLite CREATE TABLE 컬럼 정의 생성
  toSQLColumns() {
    return Object.entries(this.fields).map(([name, def]) => {
      const sqlType = { string: 'TEXT', number: 'REAL', boolean: 'INTEGER', json: 'TEXT' }[def.type];
      const notNull = def.required ? ' NOT NULL' : '';
      return `  ${name} ${sqlType}${notNull}`;
    }).join(',\n');
  }

  _coerce(name, val, type) {
    if (type === 'json') return typeof val === 'string' ? val : JSON.stringify(val);
    if (type === 'boolean') return val ? 1 : 0;
    if (type === 'number') {
      const n = Number(val);
      if (isNaN(n)) throw new Error(`Schema: field '${name}' must be a number`);
      return n;
    }
    return String(val);
  }
}

module.exports = { Schema };
