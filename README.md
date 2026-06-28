# dJinn

**Doil's JSON iNdexing Node** — SQLite 기반 임베디드 JSON 스토리지 레이어.

별도 서버 없이 프로세스 내에서 돌아가는 경량 DB 레이어로, B-tree 인덱싱·LRU 캐싱·히트맵을 직접 제어할 수 있습니다. MCP 서버 자동 생성을 지원합니다.

> *dJinn: 악마같이 좋은 녀석. 램프의 요정이자 중동 신화의 정령.*

---

## Features

| 기능 | 설명 |
|------|------|
| **B-tree+ 인덱싱** | SQLite WAL 모드 + 필드별 인덱스 자동 생성 |
| **LRU 캐싱** | doubly linked list + Map 기반 O(1) get/put/evict |
| **자체 해시함수** | FNV-1a (캐시 키) + SHA-256 (콘텐츠 무결성) |
| **히트맵** | 키/컬렉션별 hit·miss 집계 — 시각화 및 캐시 참조용 |
| **MCP 서버** | 등록 컬렉션 기반 툴 자동 생성 |
| **Prepared Statement 재사용** | 쿼리별 statement 캐싱으로 파싱 오버헤드 제거 |

---

## Installation

현재 npm 미등록 패키지입니다. `npm pack`으로 빌드한 tgz를 로컬에서 참조합니다.

```bash
# 1. dJinn 레포에서 패키지 빌드
git clone https://github.com/D0iloppa/dJinn.git
cd dJinn
npm pack
# → d0iloppa-djinn-x.x.x.tgz 생성

# 2. 사용할 프로젝트에서 로컬 tgz로 설치
cp d0iloppa-djinn-x.x.x.tgz /path/to/your-project/
cd /path/to/your-project
npm install ./d0iloppa-djinn-x.x.x.tgz
```

```json
// package.json
{
  "dependencies": {
    "@d0iloppa/djinn": "file:./d0iloppa-djinn-x.x.x.tgz"
  }
}
```

> npm 등록 후에는 `npm install @d0iloppa/djinn`으로 설치 가능합니다.

---

## Quick Start

```js
const { DJinn, Schema } = require('@d0iloppa/djinn');

const db = new DJinn('./mydata.db', { cacheSize: 256 });

const pageSchema = new Schema({
  title: { type: 'string', required: true },
  group: { type: 'string', required: true },
  url:   { type: 'string' },
  tags:  { type: 'json',   default: [] },
});

db.define('pages', pageSchema, {
  primaryKey: 'id',
  indexes: ['group'],
});

// CRUD
db.put('pages', 'abc123', { title: 'Home', group: 'root', url: 'https://...' });
db.get('pages', 'abc123');
db.find('pages', { group: 'root' });
db.del('pages', 'abc123');

// 트랜잭션
db.transaction(() => {
  db.put('pages', 'id1', { title: 'A', group: 'wiki' });
  db.put('pages', 'id2', { title: 'B', group: 'wiki' });
});

// 히트맵
console.log(db.heatmap());

db.close();
```

---

## API Reference

### `new DJinn(dbPath, options?)`

| 옵션 | 타입 | 기본값 | 설명 |
|------|------|--------|------|
| `cacheSize` | `number` | `256` | LRU 캐시 최대 항목 수 |

### `db.define(collection, schema, options?)`

컬렉션(테이블)을 등록합니다. 테이블이 없으면 생성합니다.

| 옵션 | 타입 | 설명 |
|------|------|------|
| `primaryKey` | `string` | 기본키 필드명 (기본: `'id'`) |
| `indexes` | `string[]` | 인덱스를 생성할 필드 목록 |

### `db.get(collection, id)` → `object \| null`

id로 단건 조회. LRU 캐시 우선.

### `db.find(collection, where?, options?)` → `object[]`

equality 조건 조회. `where`가 없으면 전체 반환. `options`로 정렬·페이징을 제어합니다.

```js
db.find('pages', { group: 'wiki' });
db.find('pages'); // all

// 정렬 + 페이징 (모두 optional)
db.find('pages', { group: 'wiki' }, {
  orderBy:  'title',   // JSON 경로 ('title', 'props.저자', '$.url' 모두 허용)
  orderDir: 'asc',     // 'asc' | 'desc' (기본: 'asc')
  limit:    20,
  offset:   40,        // 3페이지 (20 * 2)
});
```

`where` 값에 `%`가 포함되면 자동으로 LIKE 검색으로 전환됩니다.

```js
db.find('pages', { title: '%노션%' }); // title LIKE '%노션%'
```

> 페이징 옵션(`limit`/`offset`)이 있을 때는 캐시를 우회합니다.

### `db.findByIds(collection, ids, options?)` → `object[]`

복수 ID로 한 번에 조회합니다. `WHERE id IN (...)` — primary key B-tree를 활용하며 `find()`와 동일한 정렬·페이징 옵션을 지원합니다.

```js
const ids = ['abc', 'def', 'ghi'];

db.findByIds('pages', ids);

// 정렬 + 페이징 (모두 optional)
db.findByIds('pages', ids, {
  orderBy:  'title',
  orderDir: 'asc',
  limit:    10,
  offset:   0,
});
```

edge 타겟 노드처럼 ID 목록을 먼저 구한 뒤 노드를 일괄 조회할 때 유용합니다.

### `db.toCSV(records, columns, getVal?)` → `string`

레코드 배열을 CSV 문자열로 직렬화합니다.

| 파라미터 | 타입 | 설명 |
|----------|------|------|
| `records` | `object[]` | `find()` 등으로 가져온 레코드 배열 |
| `columns` | `string[]` | 포함할 필드 목록. `'field:헤더별칭'` 형식으로 헤더 이름 지정 가능 |
| `getVal` | `(rec, field) => string` | 커스텀 값 추출 함수 (optional) |

```js
const records = db.find('pages', { group: 'wiki' }, { orderBy: 'title' });

// 기본 사용
db.toCSV(records, ['id', 'title', 'url']);

// 헤더 별칭
db.toCSV(records, ['id:ID', 'title:제목', 'url:링크']);

// 중첩 필드 — 커스텀 resolver로 처리
db.toCSV(records, ['id', 'title:제목', '저자'], (rec, field) => {
  if (field in rec) return String(rec[field] ?? '');
  return String((rec.props || {})[field] ?? ''); // props.저자 등
});
```

### `db.put(collection, id, doc)` → `id`

삽입 또는 교체. 캐시 무효화.

### `db.del(collection, id)`

삭제 후 캐시 무효화.

### `db.transaction(fn)`

`fn` 안의 모든 변경을 하나의 ACID 트랜잭션으로 묶습니다.

### `db.heatmap()` → `HeatmapResult`

```ts
{
  global: { totalHits, totalMisses, totalAccess, globalHitRate },
  byCollection: [{ collection, hits, misses, total, hitRate, keys }],
  keys: [{ key, label, hits, misses, total, hitRate }],  // 접근 빈도 내림차순
  coldKeys: string[],   // hitRate 낮은 키 (캐시 교체 참조용)
}
```

### `db.cacheStats()` → `{ size, maxSize }`

### `db.resetHeatmap()`

히트맵 카운터 초기화.

### `db.close()`

---

## Schema

```js
const { Schema } = require('@d0iloppa/djinn');

new Schema({
  fieldName: {
    type:     'string' | 'number' | 'boolean' | 'json',
    required: true | false,   // 기본: false
    default:  value | () => value,
  }
});
```

`json` 타입은 객체/배열을 자동 직렬화/역직렬화합니다.

---

## Hash Utilities

```js
const { fnv1a, queryKey, contentHash } = require('@d0iloppa/djinn');

fnv1a('hello');                        // → '811c9dc5' (8자리 hex)
queryKey('pages', { group: 'wiki' }); // → 'pages:a3f2c1d0'
contentHash({ title: 'Home' });        // → 'e3b0c44298...' (16자리)
```

---

## MCP Integration

dJinn은 등록된 컬렉션을 기반으로 MCP 툴을 자동 생성합니다.

### 자동 생성 툴

`define()`으로 등록한 컬렉션마다 다음 툴이 생성됩니다:

| 툴 이름 | 설명 |
|---------|------|
| `djinn_get_{collection}` | id로 단건 조회 |
| `djinn_find_{collection}` | where 조건 조회 |
| `djinn_put_{collection}` | 삽입/교체 |
| `djinn_del_{collection}` | 삭제 |

공통 툴: `djinn_collections`, `djinn_heatmap`, `djinn_cache_stats`

### 사용 예시

```js
const { DJinn, Schema, createMcpServer, serveMcp } = require('@d0iloppa/djinn');

const db = new DJinn('./data.db');
db.define('pages', pageSchema, { indexes: ['group'] });

// MCP 서버 생성 (컬렉션 define 완료 후 호출)
const mcpServer = createMcpServer(db, { name: 'my-djinn', version: '1.0.0' });

// stdio 트랜스포트로 즉시 실행
await serveMcp(db, { name: 'my-djinn', version: '1.0.0' });
```

### mcp.json 등록

```json
{
  "mcpServers": {
    "djinn": {
      "type": "stdio",
      "command": "node",
      "args": ["./mcp-entry.js"]
    }
  }
}
```

```js
// mcp-entry.js
const { DJinn, Schema, serveMcp } = require('@d0iloppa/djinn');
const db = new DJinn('./data.db');
db.define('pages', pageSchema, { indexes: ['group'] });
serveMcp(db, { name: 'djinn', version: '0.1.0' });
```

---

## Design Philosophy

> 기능 추가 / 구조 변경 전 반드시 **[INTENT.md](./INTENT.md)** 를 먼저 읽을 것.

- **JSON 문서 스토어**: `{id, doc TEXT}` 두 컬럼 고정. 새 필드는 컬럼이 아니라 `doc` 안에 넣는다.
- **임베디드**: 별도 서버 없이 프로세스 내 동작. SQLite가 B-tree와 ACID를 책임진다.
- **계층 분리**: 스토리지(SQLite) / 캐싱(LRU) / 관측(HitMap) / 인터페이스(MCP) 각자의 역할.
- **스키마 없음**: 타입 강제, required 검증, ALTER TABLE — DJinn의 역할이 아니다.

---

## License

MIT © [D0iloppa](https://github.com/D0iloppa)
