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

## Quick Start

```bash
npm install @d0iloppa/djinn
```

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

### `db.find(collection, where?)` → `object[]`

equality 조건 조회. `where`가 없으면 전체 반환.

```js
db.find('pages', { group: 'wiki' });
db.find('pages'); // all
```

### `db.put(collection, id, doc)` → `id`

삽입 또는 교체. 스키마 검증 후 캐시 무효화.

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
