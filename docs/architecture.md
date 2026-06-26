# dJinn Architecture

## 전체 구조

```
┌─────────────────────────────────────────────┐
│                  Consumer                    │
│          (doil-sb / any Node.js app)         │
└──────────────────┬──────────────────────────┘
                   │ require('@d0iloppa/djinn')
┌──────────────────▼──────────────────────────┐
│                  DJinn                       │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐  │
│  │  Schema  │  │ LRUCache │  │  HitMap   │  │
│  │ validate │  │ O(1) r/w │  │ hit/miss  │  │
│  │ DDL gen  │  │ evict    │  │ byCol     │  │
│  └──────────┘  └──────────┘  └───────────┘  │
│  ┌──────────────────────────────────────┐    │
│  │          better-sqlite3              │    │
│  │   WAL · B-tree Index · Transaction   │    │
│  └──────────────────────────────────────┘    │
│  ┌──────────────────────────────────────┐    │
│  │          MCP Server (optional)       │    │
│  │   auto-generated tools per collection│    │
│  └──────────────────────────────────────┘    │
└─────────────────────────────────────────────┘
                   │
            data.db (파일 하나)
```

---

## 모듈별 역할

### `db.js` — DJinn (조율자)

모든 레이어를 연결하는 중앙 클래스.

- `define()`: Schema → DDL 실행 → 인덱스 생성
- `get()` / `find()`: LRUCache 확인 → miss 시 SQLite 조회 → HitMap 기록
- `put()` / `del()`: SQLite 변경 → 캐시 prefix 무효화
- `transaction()`: `better-sqlite3`의 트랜잭션 래핑
- `heatmap()`: HitMap 스냅샷 노출

Prepared statement는 `_stmts: Map<key, Statement>`에 캐싱되어 재파싱 없이 재사용됩니다.

### `schema.js` — Schema

타입 시스템 + DDL 생성기.

**지원 타입**

| 타입 | SQLite 타입 | 비고 |
|------|------------|------|
| `string` | TEXT | |
| `number` | REAL | NaN 거부 |
| `boolean` | INTEGER | 0/1 저장, boolean 역변환 |
| `json` | TEXT | 자동 직렬화/역직렬화 |

`validate(doc)` 규칙:
1. required 필드 누락 → Error
2. 선택적 필드 누락 → `default` 적용, 없으면 `null` (컬럼 수 고정 보장)
3. `null`은 coerce 없이 그대로 저장

### `cache.js` — LRUCache

```
head ↔ [MRU] ↔ ... ↔ [LRU] ↔ tail
         ↑                ↑
     최근 접근          다음 evict 대상
```

- `get(key)`: Map 조회 O(1) → 노드를 front로 이동
- `set(key, value)`: front에 삽입 → maxSize 초과 시 tail.prev evict
- `invalidatePrefix(prefix)`: 전체 Map 순회로 prefix 매칭 삭제

캐시 키는 `queryKey()` (FNV-1a 기반)로 생성됩니다.

### `hash.js` — Hash Utilities

**FNV-1a 32bit** — 캐시 키 생성용

```
h = 0x811c9dc5
for each byte:
    h = h XOR byte
    h = h × 0x01000193  (FNV prime)
```

선택 이유: SHA 계열 대비 10배 이상 빠르고, 캐시 키 충돌 확률이 실용 범위에서 무시 가능 (2³² = 42억 버킷).

**SHA-256** — 콘텐츠 해시

문서 무결성 검증용. `contentHash(obj)`는 JSON 직렬화 후 첫 16자리만 반환 (저장/비교용).

### `hitmap.js` — HitMap

두 개의 Map으로 hit/miss를 독립 집계합니다.

```
_hits:   key → count   (캐시에서 꺼낸 횟수)
_misses: key → count   (DB 조회가 발생한 횟수)
_labels: key → string  (사람이 읽을 수 있는 레이블)
```

**byCollection()**: key prefix로 컬렉션을 추출해 집계. 시각화의 row 단위.

**coldKeys(n)**: hitRate 오름차순 + 동률 시 total 내림차순 정렬. LRU evict 후보 참조용.

### `mcp.js` — MCP Server

`createMcpServer(djinn)` 호출 시점에 `djinn._collections`를 순회하여 컬렉션별 툴을 동적 생성합니다. 이후 컬렉션이 추가돼도 MCP 서버를 재생성해야 합니다(툴은 연결 시점에 고정).

---

## 데이터 흐름 — `find` 예시

```
db.find('pages', { group: 'wiki' })
  │
  ├─ queryKey('pages', { group: 'wiki' })
  │    └─ FNV-1a('{"collection":"pages","params":{"group":"wiki"}}')
  │    → cacheKey = 'pages:a3f2c1d0'
  │
  ├─ LRUCache.get('pages:a3f2c1d0')
  │    ├─ HIT  → HitMap.recordHit() → return cached result
  │    └─ MISS → HitMap.recordMiss()
  │
  ├─ _stmt('SELECT * FROM pages WHERE group = ?', 'pages{"group":"wiki"}')
  │    └─ 캐싱된 PreparedStatement 반환 (없으면 prepare 후 저장)
  │
  ├─ stmt.all('wiki')   ← B-tree index on 'group' 사용
  │
  ├─ rows.map(_deserialize)   ← json 타입 역직렬화
  │
  └─ LRUCache.set(cacheKey, result) → return result
```

---

## 파일 구조

```
dJinn/
  src/
    index.js      public exports
    db.js         DJinn 클래스 (조율자)
    schema.js     Schema (검증 + DDL)
    cache.js      LRUCache (O(1) LRU)
    hitmap.js     HitMap (히트맵)
    hash.js       FNV-1a + SHA-256
    mcp.js        MCP 서버 생성기
  docs/
    architecture.md  (이 문서)
    rfp.md           요구사항 및 설계 근거
  test/
    smoke.js      통합 테스트
```

---

## 성능 특성

| 연산 | 캐시 HIT | 캐시 MISS |
|------|---------|----------|
| `get` | O(1) Map 조회 | O(log n) B-tree |
| `find` (인덱스 있음) | O(1) | O(log n + k) |
| `find` (인덱스 없음) | O(1) | O(n) full scan |
| `put` | — | O(log n) + 캐시 무효화 |

`better-sqlite3`는 동기 API이지만 네이티브 바인딩으로 동작하며, JSON.parse 기반 파일 I/O 대비 수십 배 빠릅니다. WAL 모드에서 읽기와 쓰기가 병렬화됩니다.
