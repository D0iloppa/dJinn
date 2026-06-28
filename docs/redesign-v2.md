# DJinn v2 설계 문서 — JSON Document Store

## 배경 및 문제 정의

**DJinn** = **D**oil's **J**son **I**ndexing **N**ode

원래 의도: JSON 파일 영속화 → 유연한 NoSQL 문서 저장소  
실제 구현: SQLite + 컬럼 고정 스키마 ORM → MongoDB와 정반대 방향으로 표류

### 현재 v1의 문제

```
┌─ 현재 nodes 테이블 ─────────────────────────────────────────┐
│  id TEXT PK | title TEXT | grp TEXT | url TEXT | tags TEXT  │
│             | nodeType TEXT | excerpt TEXT                   │
└─────────────────────────────────────────────────────────────┘
```

- `define()` 시 Schema 필드 타입을 일일이 선언해야 함
- 필드 추가 시 ALTER TABLE (마이그레이션 부담)
- `required`, `default`, `_coerce` 등 ORM 레이어 — DJinn의 존재 이유와 무관
- JSON 파일과의 연관성 0%

---

## v2 설계

### 핵심 전환

```
v1: {id, col1, col2, col3, ...}   ← 컬럼 고정, 스키마 필수
v2: {id, doc TEXT}                 ← JSON blob 1개, 스키마 불필요
```

SQLite는 `json_extract(doc, '$.field')` 함수를 지원하며,  
해당 표현식에 인덱스도 생성 가능 → 자주 쿼리되는 필드는 인덱싱 가능.

### 새 테이블 구조

```sql
CREATE TABLE {collection} (
  id  TEXT PRIMARY KEY,
  doc TEXT NOT NULL   -- JSON.stringify() 결과
);

-- 인덱스: JSON path 기반 (선택적)
CREATE INDEX idx_nodes_grp      ON nodes(json_extract(doc, '$.grp'));
CREATE INDEX idx_nodes_nodeType ON nodes(json_extract(doc, '$.nodeType'));
CREATE INDEX idx_edges_source   ON edges(json_extract(doc, '$.source'));
CREATE INDEX idx_edges_target   ON edges(json_extract(doc, '$.target'));
```

### 새 API

```js
// define: Schema 없음. indexes만 선택적으로 선언
db.define('nodes', { indexes: ['$.grp', '$.nodeType'] })
db.define('edges', { indexes: ['$.source', '$.target'] })
db.define('meta')  // 인덱스도 없음

// put: 객체 그대로, 필드 자유
db.put('nodes', 'id123', { title: 'foo', grp: 'root', 새필드: '자유롭게' })

// get: JSON.parse 후 반환
db.get('nodes', 'id123')  // → { title: 'foo', grp: 'root', 새필드: '자유롭게' }

// find: $.field 키로 필터 (% → LIKE)
db.find('nodes', { '$.grp': 'root' })
db.find('nodes', { '$.title': '%HBM%' })
db.find('nodes')           // 전체

// count: 동일한 where 문법
db.count('nodes', { '$.grp': 'root' })

// put/del/transaction: 변경 없음
```

### 제거되는 것

| 제거 | 이유 |
|------|------|
| `Schema` 클래스 | 스키마리스로 전환 |
| `schema.js` | 불필요 |
| `_coerce()` | 타입 강제 불필요 |
| `_deserialize()` | JSON.parse로 단순화 |
| `define()` schema 인자 | options만 남음 |

### 유지되는 것

| 유지 | 이유 |
|------|------|
| LRUCache | 여전히 유효 |
| HitMap | 여전히 유효 |
| FNV-1a queryKey | 캐시 키 생성 |
| MCP auto-generation | djinn_get/find/put/del/count_{col} |
| transaction() | 변경 없음 |

---

## 영향 범위

### @d0iloppa/djinn (패키지 내부)

| 파일 | 변경 |
|------|------|
| `src/db.js` | `define()` 단순화, `put/get/find/count` JSON blob 방식으로 재작성 |
| `src/schema.js` | 삭제 |
| `src/mcp.js` | where 파싱에서 `$.` prefix 지원 추가, 나머지 유지 |
| `src/index.js` | Schema export 제거 |

### doil-sb (소비자)

| 파일 | 변경 |
|------|------|
| `mcp/djinn.js` | `define()` 호출에서 Schema 제거 |
| `routes/graph.js` | Schema 선언 제거, `graphNodeToDb` 단순화 |

---

## 마이그레이션 계획

### 전제
- 현재 DB: `doil-sb/data/notion_meta.db` (v1 컬럼 구조)
- 목표: 동일 파일, `doc TEXT` 구조로 변환
- 다운타임: doil-sb 재시작 1회

### Step 1 — 현재 데이터 덤프 (롤백용)

```bash
sqlite3 doil-sb/data/notion_meta.db .dump > notion_meta_v1_backup.sql
```

### Step 2 — 마이그레이션 스크립트 실행

`migrations/v1_to_v2.js` (신규 작성):

```js
// nodes: 기존 컬럼 → JSON blob
// edges: 기존 컬럼 → JSON blob  
// meta: 기존 컬럼 → JSON blob (구조 동일해 변환 단순)
// 테이블 rename: nodes → nodes_old → 삭제
```

### Step 3 — 패키지 업데이트 및 재배포

```bash
# 1. djinn 패키지 소스 수정 (src/)
# 2. npm pack → doil-sb/d0iloppa-djinn-0.1.0.tgz 갱신
# 3. doil-sb에서 npm install
# 4. doil-sb 재시작
```

### Step 4 — 소비자 코드 수정

```js
// before (graph.js)
db.define('nodes', new Schema({ title: { type:'string', required:true }, ... }), { indexes:['grp'] })

// after
db.define('nodes', { indexes: ['$.grp', '$.nodeType'] })
```

### Step 5 — 검증

```bash
node -e "
const { DJinn } = require('@d0iloppa/djinn');
const db = new DJinn('./data/notion_meta.db');
db.define('nodes', { indexes: ['$.grp'] });
console.log('total:', db.count('nodes'));
console.log('root children:', db.count('edges', { '\$.source': 'e8553a...' }));
"
```

---

## find() 내부 구현 변경

### v1
```sql
SELECT * FROM nodes WHERE grp = 'root'
```

### v2
```sql
SELECT id, doc FROM nodes WHERE json_extract(doc, '$.grp') = 'root'
```

LIKE도 동일하게 적용:
```sql
SELECT id, doc FROM nodes WHERE json_extract(doc, '$.title') LIKE '%HBM%'
```

결과는 `JSON.parse(row.doc)` 후 `{ id, ...doc }` 형태로 반환.

---

## 버전 관리

- v1: `0.1.0` (현재)
- v2: `0.2.0` (스키마리스 전환, breaking change)
- DB 파일 버전: `meta` 컬렉션에 `{ id: 'version', doc: '{"value":"2"}' }` 저장

---

## 작업 순서

1. `src/schema.js` 삭제
2. `src/db.js` 재작성 (doc 방식)
3. `src/mcp.js` where 파싱 `$.` prefix 지원
4. `src/index.js` Schema export 제거
5. `migrations/v1_to_v2.js` 작성
6. 마이그레이션 실행 및 검증
7. `npm pack` → tgz 갱신
8. `doil-sb` 소비자 코드 수정 (djinn.js, graph.js)
9. doil-sb 재시작
