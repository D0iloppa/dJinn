# dJinn

**Doil's JSON iNdexing Node** — SQLite 기반 임베디드 JSON 스토리지 레이어.

별도 서버 없이 프로세스 내에서 돌아가는 경량 DB 레이어로, B-tree 인덱싱·LRU 캐싱·히트맵을 직접 제어할 수 있습니다. MCP 서버 자동 생성을 지원합니다.

> *dJinn: 악마같이 좋은 녀석. 램프의 요정이자 중동 신화의 정령.*
>
> 현재 버전: **0.2.0**

---

## 두 모드

| 모드 | 설명 |
|------|------|
| **legacy** | 아래 `db.define/get/find/put/del` — generic collection API |
| **graph catalog** (recommended, 0.2.0+) | `GraphDriver` — 루트(카탈로그)→자식(테이블+DDL)→손자(row) 3단 고정 구조. 자세한 내용은 [Graph Catalog](#graph-catalog-recommended) 참고 |

---

## Features

| 기능 | 설명 |
|------|------|
| **B-tree+ 인덱싱** | SQLite WAL 모드 + 필드별 인덱스 자동 생성 (복합 표현식 인덱스 포함) |
| **LRU 캐싱** | doubly linked list + Map 기반 O(1) get/put/evict |
| **자체 해시함수** | FNV-1a (캐시 키) + SHA-256 (콘텐츠 무결성) |
| **히트맵** | 키/컬렉션별 hit·miss 집계 — 시각화 및 캐시 참조용 |
| **MCP 서버** | 등록 컬렉션 기반 툴 자동 생성 |
| **Prepared Statement 재사용** | 쿼리별 statement 캐싱으로 파싱 오버헤드 제거 |
| **그래프 카탈로그** | `GraphDriver.attach()`로 옵트인하는 3단 고정 구조(SHOW TABLES/테이블+DDL/row) + node_id·parent_id 링크 (0.2.0+) |

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

## Graph Catalog (recommended)

`VecDriver`와 동일한 attach 패턴의 별도 드라이버입니다 — core `db.js`는 건드리지 않으므로 legacy generic collection API는 완전히 그대로 유지됩니다. raw SQL은 쓰지 않고 `get/find/put/del/count/transaction` 프리미티브만 사용하므로, LRU 캐시·히트맵·`invalidatePrefix`가 자동으로 유지됩니다.

### 3단 고정 구조

```
루트 노드      = information_schema / SHOW TABLES   (1-row, schems: {node_key: description})
                 node_id = 1 (고정), parent_id = null
직계 자식 노드 = 테이블 + DDL                        (node_key, child_schema: {필드명: 설명})
                 parent_id = 1 (루트)
손자 노드      = row (실데이터 JSON doc)             (key 주소: "<parent_key>::<child_key>")
                 parent_id = 소속 노드의 node_id
```

깊이는 3단으로 고정이며, 임의 깊이 트리나 스키마 validation 엔진은 의도적으로 제외합니다.

### 이중 주소 체계

- **key 주소** — 문자열. 노드는 `node_key`, 손자는 `parent_key::child_key`(테이블 PK). 사람/LLM이 부르는 이름.
- **id 링크** — 정수. 전 계층이 `node_id`/`parent_id`를 보유합니다. 발급 후 불변·재사용 없음 — 링크를 따라 트리 순회가 가능합니다.

두 축은 병행 유지됩니다 — 테이블 PK는 key 주소 그대로이고, node_id는 doc 필드 + 표현식 인덱스로 조회합니다.

### 사용 예

```js
const { DJinn, GraphDriver } = require('@d0iloppa/djinn');

const db = new DJinn('./mydata.db');
const graph = GraphDriver.attach(db);

// 골격 정의 + 시드 (멱등 — 서버 시작마다 호출해도 안전, 기존 노드는 건드리지 않음)
graph.define('echo', {
  nodes: [
    { key: 'tone',  description: '말투 기본 톤', child_schema: { base: '기본 톤' } },
    { key: 'emoji', description: '이모지 사용',   child_schema: { graphic_emoji: '이모지 여부' } },
  ],
});

// 손자(row) upsert — 부모 노드가 미리 있어야 함(엄격 모드). 반환에 node_id 포함
const { node_id } = graph.putDoc('echo', 'tone', 'tone', { base: '반말' });

graph.getDoc('echo', 'tone', 'tone');       // point lookup(캐시 경유) → { data, node_id, parent_id, ... }
graph.getByNodeId('echo', node_id);         // { level: 'doc', parent_id, ... } — id 링크로 계층 무관 조회
graph.childrenOf('echo', 1);                // 루트의 직계 = 등록된 노드 전부 (parent_id 링크 순회)
graph.listDocs('echo', 'tone', { keysOnly: true }); // child_key 오름차순, 데이터 없이 키만
```

`putNode`/`delNode`(cascade 옵션 지원)로 노드(테이블) CRUD, `countDocs`/`delDoc`으로 손자 카운트·삭제도 가능합니다.

> 물리 스키마, 인덱스 전략, node_id 시퀀스 할당, MCP 에러 케이스 등 전체 명세는 **[docs/graph-catalog-design.md](./docs/graph-catalog-design.md)** 참고.

---

## EmbedDriver (0.2.0+)

텍스트 → 벡터 변환을 provider(nvidia/gemini)별로 추상화한 별도 aggregator 계층입니다. `GraphDriver`/`VecDriver`와 동일한 `attach()` 패턴을 쓰지만 그 둘의 내부에는 관여하지 않습니다 — 설정(모델 목록·API 키)은 `GraphDriver`의 `_sys` 네임스페이스에 퍼블릭 API로만 저장하고, 임베딩 결과는 `VecDriver`의 `upsert`/`search`로 흘려보낼 뿐입니다.

- **의존성**: `GraphDriver` attach 필수(설정이 `_sys` 네임스페이스에 저장됨) + `VecDriver` attach 필수(`embedAndUpsert`/`embedAndSearch`용).
- **게이팅**: config(모델 목록) + api_key가 모두 설정되기 전까지 `isConfigured()`가 `false`를 반환하며, `vec_*` 및 `embed_*` MCP 툴이 **등록 자체가 되지 않습니다**(에러 응답이 아니라 기능 자체가 숨겨짐). API 키는 MCP로는 설정도 조회도 불가능하며 — 보안상 host JS API로만 다룹니다.

### 설정 부트스트랩 (host JS API 전용 — MCP 미노출)

| 메서드 | 설명 |
|--------|------|
| `embed.defineConfig()` | `_sys` 카탈로그 + `config` 노드 골격 시드 (멱등) |
| `embed.setModels(entries)` | 모델 엔트리 배열 저장 — `entries: [{id, provider, model, input_type?}, ...]` (models.json의 embedding 배열과 동일 형태) |
| `embed.setApiKey(entryId, key)` | 엔트리별 API 키 저장 (평문 — `_sys/config/apikey/<entryId>` 문서, 암호화는 의도적으로 하지 않음) |
| `embed.getModels()` | 저장된 모델 엔트리 배열 조회 → `entries[] \| null` |
| `embed.getApiKey(entryId)` | 엔트리별 API 키 조회 → `string \| null` |
| `embed.getEntry(id?)` | 엔트리 하나 해석 — `id` 생략 시 첫 번째(기본) 엔트리 |
| `embed.isConfigured()` | config + api_key 설정 완료 여부 (동기 — mcp.js가 등록 시점에 동기 호출) |

### 핵심 엔트리 포인트

- **`async embed.embed(text, { id?, model? })`** → `float[]`. `entry.provider`에 따라 `nvidia`(`/v1/embeddings`) 또는 `gemini`(`embedContent`) 호출. 해석된 엔트리에 키가 없으면 잠금 에러를 throw합니다.
- **`async embed.embedAndUpsert(collection, docId, text, opts?)`** → `embed()` 후 곧바로 `VecDriver`에 upsert, 벡터 차원 수 반환.
- **`async embed.embedAndSearch(collection, text, k = 10, opts?)`** → `embed()` 후 곧바로 `VecDriver`에서 k-NN 검색, `[{id, distance}]` 반환.

### 사용 예

```js
const { DJinn, GraphDriver, VecDriver, EmbedDriver } = require('@d0iloppa/djinn');

const db = new DJinn('./mydata.db');
const graph = GraphDriver.attach(db);
const vec   = VecDriver.attach(db);
const embed = EmbedDriver.attach(db);

vec.define('docs', 1536); // 벡터 차원 수는 provider/model에 맞춰 지정

// 설정 부트스트랩 (host JS에서만 — MCP로는 불가)
embed.defineConfig();
embed.setModels([
  { id: 'default', provider: 'nvidia', model: 'nvidia/nv-embed-v1', input_type: 'query' },
]);
embed.setApiKey('default', process.env.NVIDIA_API_KEY);

// 텍스트 → 벡터 → 저장/검색
await embed.embedAndUpsert('docs', 'doc1', '안녕하세요, dJinn입니다.');
const results = await embed.embedAndSearch('docs', '인사말', 5);
```

`embed.isConfigured()`가 `true`가 되는 순간부터(위 예의 `setApiKey` 호출 이후) `createMcpServer()`/`serveMcp()`가 `embed_*`(및 `vec_*`) 툴을 등록합니다.

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

### Graph Catalog 자동 생성 툴

`GraphDriver.attach(db)` 후 `graph.define(ns, ...)`을 호출한 네임스페이스마다 다음 9개 툴이 생성됩니다 (`createMcpServer()` 호출 시점에 등록되는 네임스페이스가 고정되므로 `define()`을 모두 마친 뒤 서버를 생성해야 합니다):

| 툴 이름 | 설명 |
|---------|------|
| `graph_catalog_{ns}` | 루트 조회 = SHOW TABLES |
| `graph_node_put_{ns}` | 노드 upsert = CREATE/ALTER TABLE (반환에 `node_id` 포함) |
| `graph_node_get_{ns}` | 노드 조회 — `key` 또는 `node_id` 중 정확히 하나로 주소지정 |
| `graph_node_del_{ns}` | 노드 삭제 = DROP TABLE — 손자가 있으면 `cascade:true` 필요 |
| `graph_doc_put_{ns}` | 손자(row) upsert — 부모 노드가 미리 있어야 함 (반환에 `node_id` 포함) |
| `graph_doc_get_{ns}` | 손자 point lookup — `parent_key`+`child_key` 또는 `node_id` |
| `graph_doc_list_{ns}` | 손자/자식 노드 목록 — `parent_key` 또는 `parent_id`(1 = 루트 → 노드 목록) |
| `graph_doc_del_{ns}` | 손자 삭제 (멱등) |
| `graph_doc_count_{ns}` | 손자 카운트 |

`graph.define(ns)`가 내부적으로 `db.define()`도 호출하므로 `${ns}_root`/`${ns}_nodes`/`${ns}_docs` 컬렉션에 대한 `djinn_get_*`/`djinn_put_*` 등 generic 툴도 함께 생성됩니다 — 이는 legacy 탈출구로 의도적으로 남긴 것이며, 의미론적 조작(스키마 동기화 등)은 `graph_*` 툴을 사용해야 합니다.

### EmbedDriver 자동 생성 툴 (0.2.0+)

`EmbedDriver.attach(db)` 후 **config(모델 목록) + api_key가 모두 설정된 경우에만**(`embed.isConfigured() === true`) 다음 툴이 등록됩니다. 미설정 상태에서는 아래 툴들이 서버에 등록조차 되지 않습니다 — 툴 목록에 아예 나타나지 않습니다.

| 툴 이름 | 설명 |
|---------|------|
| `embed_text` | 전역 — 텍스트를 벡터로 변환 (`{dim, embedding}` 반환) |
| `embed_upsert_{collection}` | `VecDriver.define()`으로 등록된 vec 컬렉션마다 생성 — 텍스트를 임베딩해 곧바로 저장 |
| `embed_search_{collection}` | vec 컬렉션마다 생성 — 쿼리 텍스트를 임베딩해 k-NN 검색 (`[{id, distance}]` 반환) |

> API 키 설정(`setApiKey`)은 보안상 MCP 툴로 노출하지 않습니다 — host JS API(`embed.setApiKey(...)`)로만 가능합니다.

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
