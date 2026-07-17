# dJinn 그래프 카탈로그 (Graph Catalog) 설계 — v2

> 상태: **v2 개정 확정 대기** · 대상 버전: **0.2.0** · 구현 기준 문서
>
> ai-echo가 손으로 만든 3단 구조(`echo_profile` / `echo_dimension` / `echo_dimension_childs`)를
> 라이브러리 표준 기능으로 일반화한다. 기존 generic collection API(legacy 모드)는 완전 무변경.
>
> v1 설계대로의 구현이 워킹트리에 이미 존재한다(`src/graph.js` 등, 미커밋).
> **v2는 그 구현을 수정하는 기준 문서다** — v1과 달라지는 지점은 아래 "v2 변경점"과
> 본문 곳곳의 `[v2]` 표기로 명시한다.

---

## v2 변경점 (v1 대비 — 사용자 확정)

| # | 변경 | v1 | v2 |
|---|------|----|----|
| 1 | **전 계층 `node_id`(정수) 부여** | 없음 — 문자열 key만 | 루트/자식 노드/손자 doc 전부 네임스페이스 내 유일한 단조증가 정수 `node_id` 보유 |
| 2 | **`parent_id` 링크(adjacency list)** | 손자만 `parent_key`(문자열)로 부모 지칭 | 전 계층이 `parent_id`(정수)로 조상 지칭. 루트 `null` → 자식 노드 `parent_id = 루트.node_id` → 손자 `parent_id = 소속 노드.node_id`. 링크를 따라 트리 순회 가능 |
| 3 | **깊이는 3단 고정 유지** | 3단 고정 | 동일 — 임의 깊이 확장 아님. 링크 *구조*만 전 계층 통일 |
| 4 | **문자열 key 주소 병행 유지** | key가 유일한 주소 | 구조 링크 = node_id/parent_id(정수), 호출 주소 = 기존 key(`parent::child` id 컨벤션 포함) 그대로. MCP 툴은 둘 다 수용 |
| 5 | **시퀀스 관리** | 해당 없음 | `${ns}_root`의 메타 row(`'seq'`)를 transaction 안에서 증가 (§2.5) |
| 6 | **인덱스 추가** | `(parent_key, child_key)` 복합 + 단일들 | + `parent_id`, `node_id` 표현식 인덱스 (§2.3에 역할 분담 명시) |
| 7 | **API/MCP 반환값** | key만 반환 | put 계열이 `node_id` 반환, get/del/list 계열은 key 또는 node_id 양쪽 주소지정 (§1.2, §3) |

구현 수정 대상(v1 구현 기준): `src/graph.js`(시퀀스·doc 형태·주소 해석), `src/db.js`는 v1의
복합 인덱스 확장 그대로(추가 변경 없음), `src/mcp.js`(파라미터 개정), `test/graph-smoke.js`(§5).

---

## 0. 두 모드

| 모드 | 설명 | 변경 |
|------|------|------|
| **legacy** | 현행 `define/get/find/put/del` generic collection API | 없음 (breaking change 금지) |
| **graph catalog** (recommended) | 루트(카탈로그) → 자식(테이블+DDL) → 손자(실데이터)의 3단 고정 깊이 구조 | `GraphDriver` 신규 |

3단 구조의 의미론 — RDB 대응:

```
루트 노드      = information_schema / SHOW TABLES   (1-row, schems: {node_key: description})
                 node_id = 1 (고정), parent_id = null
직계 자식 노드 = 테이블 + DDL                        (node_key, child_schema: {필드명: 설명})
                 parent_id = 1 (루트)
손자 노드      = row (실데이터 JSON doc)             (key 주소: "<parent_key>::<child_key>")
                 parent_id = 소속 노드의 node_id
```

임의 깊이 트리, 스키마 validation 엔진은 **의도적으로 제외**한다 — parent_id 링크는
전 계층에 통일된 순회 수단일 뿐, 깊이는 3단으로 고정한다(사용자 확정). child_schema는
LLM/사람이 읽는 명세(DDL 대용 문서)이지 강제 검증 규칙이 아니다. ai-echo에서 검증 없이
잘 동작한 선례를 따른다.

### 이중 주소 체계 `[v2]`

| 축 | 형태 | 용도 |
|----|------|------|
| **key 주소** | 문자열 — 노드는 `node_key`, 손자는 `parent_key::child_key`(테이블 PK) | 사람/LLM이 부르는 이름. ai-echo 컨벤션 그대로 |
| **id 링크** | 정수 — `node_id` / `parent_id` | 구조적 링크·트리 순회. rename에도 안정적인 불변 식별자 |

테이블 PK(id 컬럼)는 **v1과 동일하게 key 기반을 유지**한다(`'root'` / `node_key` /
`parent_key::child_key`). node_id는 doc 안의 필드 + 표현식 인덱스로 조회한다 — PK를
정수로 바꾸면 ai-echo 손자 id 무변환 이관(§4)과 point-lookup 캐시 경로(djinn.get)를
잃기 때문이다.

---

## 1. API 설계 — 드라이버 attach 패턴 채택

### 1.1 결정: `GraphDriver` (VecDriver와 동일한 attach 패턴)

core 메서드 추가가 아닌 **별도 드라이버**로 간다. 근거:

1. **legacy 무변경 보장** — core `db.js`를 건드리지 않으므로 breaking change가 원천 차단된다
   (단 하나의 예외: §2.3의 define() 복합 인덱스 확장 — 추가적(additive)이며 기존 호출과 100% 호환).
2. **기존 선례와 일관** — `VecDriver.attach(djinn)` → `djinn._vec` → `mcp.js`가 vec_* 툴 자동 등록.
   동일하게 `GraphDriver.attach(djinn)` → `djinn._graph` → graph_* 툴 자동 등록.
3. **선택적 의존** — 그래프 카탈로그를 안 쓰는 소비자는 코드 경로 자체를 타지 않는다.

VecDriver와의 결정적 차이 — **raw SQL 금지**. VecDriver는 vec0 가상 테이블 때문에
`djinn.db`를 직접 만지지만, GraphDriver는 일반 JSON 컬렉션 3개만 쓰므로
**DJinn core 프리미티브(`define/get/find/put/del/transaction`)만 사용**한다.
이로써 LRU 캐시 · HitMap 기록 · `invalidatePrefix`가 아무 추가 코드 없이 자동으로 유지된다.
`[v2]` node_id 시퀀스도 같은 이유로 raw AUTOINCREMENT가 아닌 메타 row + transaction으로
구현한다(§2.5).

### 1.2 클래스 시그니처 전부

```js
// src/graph.js
'use strict';

class GraphDriver {
  /**
   * DJinn 인스턴스에 attach. VecDriver 패턴과 동일.
   * djinn._graph에 드라이버 ref를 저장 → createMcpServer가 감지해 graph_* 툴 자동 등록.
   * @returns {GraphDriver}
   */
  static attach(djinn) {}

  constructor(djinn) {
    this._djinn = djinn;
    this._namespaces = new Set();  // define()된 네임스페이스 — mcp.js가 순회
  }

  // ── 네임스페이스(=카탈로그 인스턴스) ──────────────────────────────

  /**
   * 3단 구조 생성 + 골격 시드 (멱등).
   * - `${ns}_root`, `${ns}_nodes`, `${ns}_docs` 3개 컬렉션을 djinn.define()으로 등록
   * - 루트 row('root')가 없으면 { node_id: 1, parent_id: null, schems:{}, ... } 생성   [v2]
   * - 시퀀스 메타 row('seq')가 없으면 { seq: 1 } 생성 (1 = 루트가 소비)              [v2]
   * - options.nodes가 있으면 각 노드를 "없을 때만" 시드(INSERT OR IGNORE 의미론) —
   *   시드도 putNode 경로를 타므로 각자 node_id를 할당받고 parent_id=1로 링크된다      [v2]
   *   → ai-echo의 generate-init-sql.js/init.sql을 대체한다. 소비자는 코드에서
   *     골격을 선언하고 define()을 서버 시작 시마다 호출하면 된다(항상 멱등).
   *
   * @param {string} ns  네임스페이스 (예: 'echo') — [a-zA-Z_][a-zA-Z0-9_]* 검증
   * @param {object} [options]
   * @param {Array<{key: string, description: string, child_schema: object}>} [options.nodes]
   *        기본 골격. 이미 존재하는 노드는 건드리지 않는다(사용자 수정 보존).
   * @returns {this}
   */
  define(ns, options = {}) {}

  // ── 루트 (SHOW TABLES) ──────────────────────────────────────────

  /**
   * 카탈로그 조회 → { node_id: 1, parent_id: null, schems: {node_key: description},
   *                  created_at, modified_at }                                      [v2]
   * djinn.get(`${ns}_root`, 'root') 위임 — LRU 캐시 자동 적용.
   */
  catalog(ns) {}

  // ── 자식 노드 (테이블 + DDL) ────────────────────────────────────

  /**
   * 노드 upsert = CREATE TABLE / ALTER TABLE.
   * djinn.transaction() 안에서:
   *   1. 신규면 node_id 할당(§2.5 _nextId — 같은 트랜잭션), parent_id = 1          [v2]
   *   2. `${ns}_nodes`에 { node_id, parent_id, node_key, child_schema, ... } put
   *   3. `${ns}_root`의 schems[key] = description 갱신 (원자적 동기화 — §3.4)
   * description/child_schema 생략 시 기존 값 유지(merge). 기존 노드의 node_id는 불변.
   *
   * @returns {{ node_key: string, node_id: number }}                                [v2]
   * @throws  key에 '::' 포함 시 Error('GraphDriver: node key must not contain "::"')
   */
  putNode(ns, key, { description, child_schema } = {}) {}

  /** 노드 단건 조회 → { id, node_id, parent_id, node_key, child_schema, ... } | null */
  getNode(ns, key) {}

  /**
   * 노드 삭제 = DROP TABLE. djinn.transaction() 안에서:
   *   1. cascade가 아니고 손자가 존재하면 Error('GraphDriver: node has docs — pass cascade')
   *   2. cascade면 listDocs로 손자 전부 del
   *   3. 노드 row del + 루트 schems에서 key 제거
   * node_id는 재사용하지 않는다(시퀀스는 계속 전진).                                 [v2]
   * @param {{ cascade?: boolean }} [options]  기본 false(안전 우선)
   * @returns {{ deletedDocs: number }}
   */
  delNode(ns, key, options = {}) {}

  // ── 손자 노드 (실데이터) ────────────────────────────────────────

  /**
   * 손자 upsert. 테이블 PK = makeDocId(parentKey, childKey) = `${parentKey}::${childKey}`.
   * djinn.transaction() 안에서: 신규면 node_id 할당, parent_id = 소속 노드.node_id.  [v2]
   * 부모 노드가 없으면 Error('GraphDriver: unknown node …') — RDB의 "no such table"과
   * 동일한 엄격 모드가 기본. { autoCreateNode: true }를 주면 빈 child_schema로 부모를
   * 자동 생성(같은 transaction — 이때 부모도 node_id를 할당받는다).
   * doc 저장 형태: { node_id, parent_id, parent_key, child_key, data, created_at, modified_at }
   *
   * @returns {{ parent_key, child_key, node_id: number }}                            [v2]
   * @throws childKey에 '::' 포함 시 Error — parentKey는 putNode에서 이미 차단됨
   */
  putDoc(ns, parentKey, childKey, data, options = {}) {}

  /** point lookup → { id, node_id, parent_id, parent_key, child_key, data, ... } | null */
  getDoc(ns, parentKey, childKey) {}

  /**
   * 손자 목록 — child_key 오름차순 보장 (§2.3 복합 인덱스로 정렬된 range 스캔).
   * djinn.find(`${ns}_docs`, { parent_key }, { orderBy: 'child_key', limit, offset }) 위임.
   * @param {{ keysOnly?: boolean, limit?: number, offset?: number }} [options]
   *        keysOnly면 [{ child_key, node_id, created_at, modified_at }]만 반환       [v2]
   */
  listDocs(ns, parentKey, options = {}) {}

  /** 손자 삭제. 존재하지 않아도 no-op (djinn.del과 동일 의미론). node_id 재사용 없음. */
  delDoc(ns, parentKey, childKey) {}

  /** 손자 카운트 → number. djinn.count(`${ns}_docs`, { parent_key }) 위임. */
  countDocs(ns, parentKey) {}

  // ── id 링크 순회  [v2 신규 — 링크 순회에 필요한 최소한만] ────────

  /**
   * node_id로 계층 무관 단건 해석(resolve).
   * 조회 순서: node_id === 1 → 루트 / find(`${ns}_nodes`, { node_id }) /
   * find(`${ns}_docs`, { node_id }) — 각각 node_id 표현식 인덱스를 탄다(§2.3).
   * @returns {{ level: 'root'|'node'|'doc', ...row } | null}
   */
  getByNodeId(ns, nodeId) {}

  /**
   * parent_id 링크를 따라 직계 자식 목록.
   * nodeId === 1 → 자식 노드들(find(`${ns}_nodes`, { parent_id: 1 })),
   * 그 외 → 손자 doc들(find(`${ns}_docs`, { parent_id: nodeId })).
   * 3단 고정이므로 이 두 경우가 전부다 — 재귀 순회 API는 만들지 않는다(과설계 금지).
   * @param {{ keysOnly?: boolean }} [options]
   * @returns {Array<row>}
   */
  childrenOf(ns, nodeId, options = {}) {}

  // ── 유틸 ────────────────────────────────────────────────────────

  /** `${parentKey}::${childKey}` — ai-echo makeChildId 컨벤션 그대로 채택 (§2.4) */
  static makeDocId(parentKey, childKey) {}

  /** [v2 internal] 시퀀스 증가 — 반드시 호출측 transaction 내부에서 사용 (§2.5) */
  _nextId(ns) {}
}

module.exports = { GraphDriver };
```

`src/index.js` export 표면에 `GraphDriver` 한 줄 추가:

```js
module.exports = { DJinn, LRUCache, HitMap, fnv1a, queryKey, contentHash,
                   createMcpServer, serveMcp, VecDriver, GraphDriver };
```

### 1.3 소비자 사용 예 (ai-echo 관점)

```js
const { DJinn, GraphDriver } = require('@d0iloppa/djinn');

const djinn = new DJinn(DB_PATH);
const graph = GraphDriver.attach(djinn);

// init.sql 불필요 — 골격을 코드로 선언, 서버 시작 시마다 멱등 실행
graph.define('echo', {
  nodes: [
    { key: 'tone',  description: '말투 기본 톤 …', child_schema: { base: '기본 톤', /* … */ } },
    { key: 'emoji', description: '이모지 사용 …',  child_schema: { graphic_emoji: '…' } },
    // …
  ],
});

const { node_id } = graph.putDoc('echo', 'tone', 'tone', { base: '반말' }); // → 예: 12
graph.getByNodeId('echo', node_id);          // { level: 'doc', parent_id: 2, ... }
graph.childrenOf('echo', 1);                 // 루트의 직계 = 자식 노드 전부
graph.listDocs('echo', 'register', { keysOnly: true });
```

---

## 2. 물리 스키마

네임스페이스 `ns`당 테이블 3개. 전부 dJinn 표준 `(id TEXT PRIMARY KEY, doc TEXT NOT NULL)`
구조이며 **`GraphDriver.define()` 내부에서 `djinn.define()` 호출로 표현**된다 — raw DDL 없음.

### 2.1 define() 호출 (드라이버 내부)

```js
// 루트 — 'root' row + 'seq' 메타 row. ai-echo echo_profile 대응.                 [v2]
djinn.define(`${ns}_root`, { indexes: ['modified_at'] });

// 자식 노드 — node_key가 id 겸 사실상 PK. ai-echo echo_dimension 대응.
djinn.define(`${ns}_nodes`, {
  indexes: ['node_key', 'node_id', 'parent_id', 'modified_at'],   // [v2] node_id/parent_id 추가
});

// 손자 — 실데이터. ai-echo echo_dimension_childs 대응.
djinn.define(`${ns}_docs`, {
  indexes: [
    ['parent_key', 'child_key'],   // 복합 표현식 인덱스 — §2.3
    'child_key',
    'node_id',                     // [v2] getByNodeId용
    'parent_id',                   // [v2] childrenOf(링크 순회)용
    'modified_at',
  ],
});
```

생성되는 실제 DDL (참조용 — 드라이버가 직접 실행하지 않음):

```sql
CREATE TABLE IF NOT EXISTS echo_docs (id TEXT PRIMARY KEY, doc TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_echo_docs__parent_key__child_key
  ON echo_docs(json_extract(doc, '$.parent_key'),
               json_extract(doc, '$.child_key') COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_echo_docs__child_key   ON echo_docs(json_extract(doc, '$.child_key'));
CREATE INDEX IF NOT EXISTS idx_echo_docs__node_id     ON echo_docs(json_extract(doc, '$.node_id'));
CREATE INDEX IF NOT EXISTS idx_echo_docs__parent_id   ON echo_docs(json_extract(doc, '$.parent_id'));
CREATE INDEX IF NOT EXISTS idx_echo_docs__modified_at ON echo_docs(json_extract(doc, '$.modified_at'));
```

### 2.2 doc 형태와 타임스탬프 컨벤션 `[v2 개정]`

| 테이블 | id (테이블 PK) | doc 필드 |
|--------|----|----------|
| `${ns}_root` | `'root'` 고정 | `node_id: 1`, `parent_id: null`, `schems` (node_key→description 맵), `created_at`, `modified_at` |
| `${ns}_root` | `'seq'` 메타 row | `seq` (마지막으로 발급된 node_id — §2.5) |
| `${ns}_nodes` | `node_key` | `node_id`, `parent_id` (= 1), `node_key`, `child_schema` (필드명→설명 맵), `created_at`, `modified_at` |
| `${ns}_docs` | `parent_key::child_key` | `node_id`, `parent_id` (= 소속 노드.node_id), `parent_key`, `child_key`, `data` (임의 JSON), `created_at`, `modified_at` |

- `node_id`/`parent_id`는 JS number(정수). SQLite JSON은 정수를 무손실 저장하고
  Number.MAX_SAFE_INTEGER(2^53−1)까지 안전 — 로컬 임베디드 스토어의 시퀀스로 충분한 "long".
- 타임스탬프는 ISO 8601 문자열(`new Date().toISOString()`), **드라이버가 관리** — 호출자는 넘기지 않는다.
- upsert 시 `created_at`·`node_id`는 기존 값 보존, `modified_at`만 갱신. **node_id는 생성 시
  1회 발급 후 불변**이다 — key rename(후속 과업)이 생겨도 링크가 살아남는 근거.
- 실데이터는 `data` 필드 하나에 감싼다 — 시스템 필드(node_id/parent_id/parent_key/child_key/타임스탬프)와
  사용자 데이터의 이름 충돌을 원천 차단한다.
- ai-echo의 `isOnboard`/`onboarded_at` 같은 도메인 상태 필드는 **일반화하지 않는다** —
  드라이버는 루트 doc의 모르는 필드를 보존한다(`{ ...root }` 스프레드).

### 2.3 인덱스 전략 — SQLite 네이티브 B-tree, 두 주소 축의 역할 분담 `[v2 개정]`

제약: keyList 조회는 SQLite B-tree 인덱스를 타야 하며(JS 레벨 B+Tree 자체 구현 금지),
point lookup + **정렬된 range 스캔**을 보장해야 한다.

| 인덱스 | 담당 축 | 담당 쿼리 |
|--------|--------|-----------|
| PK(id) B-tree | key 주소 | `getDoc`/`getNode`/`catalog` point lookup — `djinn.get` 경유, LRU 캐시 적용 |
| `(parent_key, child_key COLLATE NOCASE)` 복합 | key 주소 | `listDocs` — 첫 컬럼 equality + 둘째 컬럼 정렬을 인덱스 순회만으로 (정렬된 range 스캔) |
| `(child_key)` 단일 | key 주소 | parent 무관 child_key 역조회 (ai-echo 선례 유지) |
| `(node_id)` 단일 `[v2]` | id 링크 | `getByNodeId` — find({node_id}) point lookup |
| `(parent_id)` 단일 `[v2]` | id 링크 | `childrenOf` — 링크 순회. 정렬이 필요하면 key 축(listDocs)을 쓴다 — parent_id 순회는 "무엇이 달려있나"용이지 정렬 보장은 key 축의 책임 |

복합 인덱스의 `COLLATE NOCASE`는 core `find()`의 `ORDER BY … COLLATE NOCASE`와 콜레이션을
일치시켜 인덱스가 정렬에 실제로 쓰이게 하기 위한 필수 조건이다. 이를 위한 core `define()`의
**유일한 additive 확장**(v1에서 확정, v2 유지):

```js
// db.js define() — indexes 항목이 배열이면 복합 표현식 인덱스 생성.
// 두 번째 이후 컬럼에는 COLLATE NOCASE. 문자열 항목(기존 호출)의 동작은 불변 → 비파괴.
djinn.define('echo_docs', { indexes: [['parent_key', 'child_key'], 'modified_at'] });
```

### 2.4 key 주소 컨벤션 — `<parent_key>::<child_key>` 유지

ai-echo의 `makeChildId` 방식을 손자 테이블 PK로 그대로 유지한다(v1 결정 불변). 근거:

- ai-echo 마이그레이션 시 손자 id 변환이 **불필요** (§4).
- `djinn.get` point lookup(캐시 경유)이 key 주소로 바로 동작.
- PK 자체가 parent prefix로 군집되어 지역성(locality)이 좋다.
- `[v2]` node_id가 생겼어도 PK를 정수로 바꾸지 않는 이유: key 주소는 사람/LLM의 1차
  인터페이스로 병행 유지가 사용자 확정 사항이며, PK 교체는 이관 비용만 늘린다.

모호성 방지 규칙: **node key(=parent_key)와 child_key 모두 `::` 금지**
(putNode/putDoc/define에서 검증, Error). round-trip 파싱 단순화, ai-echo 실사용에서
`::` 포함 키 사례 없음 확인.

### 2.5 node_id 할당 전략 — 메타 row 시퀀스 `[v2 신규]`

dJinn 테이블은 `(id TEXT, doc TEXT)`라 AUTOINCREMENT를 쓸 수 없고, raw SQL도 금지다.
따라서 **네임스페이스 전역 단조증가 시퀀스를 드라이버가 core 프리미티브로 관리**한다:

```js
// ${ns}_root의 'seq' 메타 row: { seq: <마지막 발급 node_id> }
// 반드시 호출측(putNode/putDoc/define)의 djinn.transaction() "내부"에서 호출한다.
_nextId(ns) {
  const row  = this._djinn.get(`${ns}_root`, 'seq');   // { seq: N }
  const next = row.seq + 1;
  this._djinn.put(`${ns}_root`, 'seq', { seq: next });
  return next;
}
```

- **충돌 없음의 근거**: better-sqlite3는 동기 단일 커넥션이라 프로세스 내 인터리빙이
  원천적으로 없고, 시퀀스 증가와 노드/doc 삽입이 **같은 transaction**이므로 중간 실패 시
  둘 다 롤백된다 — 발급됐는데 미사용인 id는 남지 않는다(롤백에 의한 결번 자체는 무해하며
  허용 — AUTOINCREMENT와 동일한 성질).
- **다중 프로세스 주의**: WAL이라도 동시 쓰기 프로세스 2개가 같은 DB를 열면 시퀀스가
  안전하지 않다(read-modify-write 경합). dJinn의 기존 전제(단일 프로세스 임베디드)와
  동일한 제약이며 문서에 명시만 한다 — 잠금 프로토콜 추가는 과설계.
- **왜 루트 doc이 아니라 별도 메타 row인가**: 발급마다 루트 doc을 put하면 `modified_at`
  의미가 오염되고("카탈로그가 변했다"는 신호가 아님) catalog() 결과의 doc 의미론이 흔들린다.
  'seq'를 분리하면 루트 doc은 실제 카탈로그 변경 때만 바뀐다.
- 초기값: define()이 루트를 생성할 때 `{ seq: 1 }` — 1은 루트 자신이 소비. 삭제된
  node_id는 재사용하지 않는다.
- `${ns}_root`는 이제 "1-row"가 아니라 **"root + seq 메타의 2-row"**다. catalog()는
  `get(ns_root, 'root')`만 보므로 소비자 관점 의미는 불변.

---

## 3. MCP 툴 명세

### 3.1 등록 방식 — vec_* 패턴과 동일한 자동 등록

`createMcpServer()` 말미에 다음 블록 추가 (기존 `if (djinn._vec)` 블록과 나란히):

```js
// --- graph 툴 (GraphDriver.attach() + define() 호출 시 자동 등록) ---
if (djinn._graph) {
  const graph = djinn._graph;
  for (const ns of graph._namespaces) {
    // graph_* 툴 등록 (아래 표)
  }
}
```

vec와 마찬가지로 **연결 시점에 툴이 고정**된다 — define() 후 서버를 만들 것
(architecture.md의 기존 제약과 동일).

주의: `graph.define(ns)`가 `djinn.define()`을 호출하므로 `${ns}_root` 등 3개 컬렉션에
대해 **generic djinn_get_* / djinn_put_* 툴도 함께 생성**된다. 이는 legacy 탈출구로
의도적으로 남긴다(raw 접근 — 단, 이 경로로 쓰면 node_id/schems 불변식은 보장되지 않음을
description에 명시). 의미론적 조작은 graph_* 툴을 쓴다.

### 3.2 툴 목록 (네임스페이스당 9개 — v1과 동수, 파라미터만 개정) `[v2 개정]`

MCP 파라미터는 기존 컨벤션대로 **객체는 JSON string**으로 받는다
(`djinn_put_*`의 `doc: z.string()` 선례). 반환은 `{ content: [{ type: 'text', text: JSON.stringify(...) }] }`.

**양쪽 주소지정 규칙**: get/del/list 계열은 key 파라미터와 `node_id`(정수)를 **둘 다
optional**로 받되 **정확히 한 쪽**만 지정해야 한다 — 둘 다 없으면/둘 다 있으면 에러.
node_id로 받은 경우 내부에서 `getByNodeId`로 key를 해석한 뒤 동일 경로를 탄다.
put 계열의 주소는 key로만 받는다(생성 시 node_id가 아직 없으므로) — 반환에 node_id 포함.

| 툴 | 파라미터 (zod) | 동작 |
|----|----------------|------|
| `graph_catalog_${ns}` | 없음 | 루트 반환 = SHOW TABLES. `{ node_id: 1, schems, nodeCount, modified_at }` |
| `graph_node_put_${ns}` | `key: z.string()`, `description: z.string().optional()`, `child_schema: z.string().optional()` (JSON string) | CREATE/ALTER TABLE. `driver.putNode()` — transaction으로 (신규 시 node_id 발급 +) 노드 row + 루트 schems 원자 갱신 (§3.4). 반환 `{ ok, node_key, node_id }` |
| `graph_node_get_${ns}` | `key: z.string().optional()`, `node_id: z.number().int().min(1).optional()` — 정확히 하나 | 노드 조회 (child_schema = DDL 열람, node_id/parent_id 포함). 없으면 `null` |
| `graph_node_del_${ns}` | `key: z.string().optional()`, `node_id: z.number().int().min(1).optional()` — 정확히 하나 · `cascade: z.boolean().optional()` (기본 false) | DROP TABLE. transaction으로 노드+schems(+cascade 시 손자 전부) 삭제 |
| `graph_doc_put_${ns}` | `parent_key: z.string()`, `child_key: z.string()`, `data: z.string()` (JSON string) | 손자 upsert. 부모 노드 없으면 에러 (MCP 계층은 엄격 모드 고정 — autoCreateNode 미노출, 노드는 graph_node_put으로 명시 생성). 반환 `{ ok, parent_key, child_key, node_id }` |
| `graph_doc_get_${ns}` | (`parent_key` + `child_key`) 또는 `node_id` — 두 방식 중 하나 | point lookup (node_id/parent_id 포함). 없으면 `null` |
| `graph_doc_list_${ns}` | `parent_key: z.string().optional()`, `parent_id: z.number().int().min(1).optional()` — 정확히 하나 · `keys_only: z.boolean().optional()` (기본 true), `limit: z.number().int().min(1).optional()`, `offset: z.number().int().min(0).optional()` | child_key 오름차순 목록. parent_id 지정 시 `childrenOf` 경유(링크 순회 — 루트 node_id 1을 주면 자식 노드 목록이 나온다: 별도 children 툴을 만들지 않는 이유). keys_only면 `[{ child_key, node_id, created_at, modified_at }]` |
| `graph_doc_del_${ns}` | (`parent_key` + `child_key`) 또는 `node_id` — 두 방식 중 하나 | 손자 삭제. 멱등 |
| `graph_doc_count_${ns}` | `parent_key: z.string().optional()` | 손자 카운트 (parent 생략 시 전체) |

툴 수를 늘리지 않기 위해 **`getByNodeId`/`childrenOf`의 MCP 노출은 기존 툴의 node_id
파라미터로 흡수**한다 — 계층 무관 resolve는 `graph_node_get`(노드)·`graph_doc_get`(손자)·
`graph_catalog`(루트)의 조합으로, 링크 순회는 `graph_doc_list`의 `parent_id`로 충분하다.

### 3.3 에러 케이스 (모든 툴 공통: `Error: <message>` 텍스트 반환 — mcp.js 기존 방식)

| 케이스 | 메시지 |
|--------|--------|
| `child_schema`/`data`가 유효한 JSON string이 아님 | `Error: <field> must be valid JSON` |
| key/parent_key/child_key에 `::` 포함 | `Error: key must not contain "::"` |
| `graph_doc_put`의 부모 노드 부재 | `Error: unknown node '<key>' — create it with graph_node_put_${ns} first` |
| `graph_node_del` cascade 없이 손자 존재 | `Error: node '<key>' has N docs — pass cascade:true` |
| 빈 key (공백/빈 문자열) | `Error: key must be non-empty` |
| `[v2]` key 주소와 node_id를 둘 다 지정 / 둘 다 생략 | `Error: pass exactly one of key or node_id` |
| `[v2]` 존재하지 않는 node_id로 주소지정 (del/list — get은 null 반환) | `Error: unknown node_id <n>` |
| `[v2]` node_id가 정수가 아니거나 < 1 | zod 레벨 거부 (`z.number().int().min(1)`) |

### 3.4 루트 schems ↔ 자식 노드 원자적 동기화 (+ 시퀀스) `[v2 개정]`

ai-echo `echo_dimension_put`은 노드 put과 루트 put을 **트랜잭션 없이** 순차 실행한다 —
중간 실패 시 카탈로그와 노드가 어긋날 수 있는 알려진 틈. 드라이버는 이를 교정하며,
v2에서는 **시퀀스 증가까지 같은 트랜잭션**에 들어간다:

```js
putNode(ns, key, { description, child_schema } = {}) {
  this._assertKey(key);
  return this._djinn.transaction(() => {
    const now  = new Date().toISOString();
    const prev = this._djinn.get(`${ns}_nodes`, key);
    const nodeId = prev?.node_id ?? this._nextId(ns);          // [v2] 신규만 발급, 기존은 불변
    this._djinn.put(`${ns}_nodes`, key, {
      node_id: nodeId,
      parent_id: 1,                                            // [v2] 루트 링크
      node_key: key,
      child_schema: child_schema ?? prev?.child_schema ?? {},
      created_at: prev?.created_at ?? now,
      modified_at: now,
    });
    const root = this._djinn.get(`${ns}_root`, 'root');
    const schems = { ...root.schems, [key]: description ?? root.schems[key] ?? key };
    this._djinn.put(`${ns}_root`, 'root', { ...root, schems, modified_at: now });
    return { node_key: key, node_id: nodeId };
  });
}
```

- `djinn.transaction()` 하나로 시퀀스 증가 + 노드 put + 루트 put이 all-or-nothing.
- put마다 `invalidatePrefix`가 돌므로 트랜잭션 롤백 시에도 캐시는 안전한 쪽(과잉 무효화)으로 기운다.
- `putDoc`도 동일 구조: transaction 안에서 부모 노드 조회(→ `parent_id` 결정) + 신규 시
  `_nextId` + doc put. `delNode`/autoCreateNode 경로도 transaction으로 묶는다.
- **불변식** (graph_* 경로만 쓰는 한 항상 성립):
  1. `${ns}_root.schems`의 key 집합 == `${ns}_nodes`의 id 집합 (v1과 동일)
  2. `[v2]` node_id는 네임스페이스 내 유일 (루트=1 포함, 발급 후 불변·재사용 없음)
  3. `[v2]` 모든 노드 row의 `parent_id === 1`, 모든 doc row의
     `parent_id === (parent_key로 찾은 노드).node_id` — key 링크와 id 링크가 항상 같은 부모를 가리킨다
  4. `[v2]` `'seq'.seq >= max(존재하는 모든 node_id)`

---

## 4. ai-echo 마이그레이션 경로 (스케치 — 후속 과업)

> 본 설계의 범위 밖이다. 여기서는 경로만 확인해 둔다.

1. **dJinn 0.2.0 반영** — `mcp-server/src/db.js`의 수동 define 4개 중 3개
   (`echo_profile`/`echo_dimension`/`echo_dimension_childs`)를
   `GraphDriver.attach(djinn)` + `graph.define('echo', { nodes: DIMENSIONS })`로 교체.
   `generate-init-sql.js`의 `DIMENSIONS` 배열이 그대로 `nodes` 옵션이 된다 → init.sql 폐기.
2. **데이터 이관 + node_id 소급 부여** `[v2 개정]` — 테이블명이 `echo_profile→echo_root`,
   `echo_dimension→echo_nodes`, `echo_dimension_childs→echo_docs`로 바뀐다. 손자 테이블
   PK는 `parent::child` 그대로라 무변환. 일회성 스크립트가 **transaction 하나**로:
   - 루트 복사: `node_id: 1, parent_id: null` 부여 (`isOnboard` 등 여분 필드 보존),
   - 구 dimension 전체를 `created_at` 오름차순으로 순회하며 `node_id: 2..N`, `parent_id: 1`
     부여 + `echo_key→node_key` 매핑,
   - 구 childs 전체를 같은 순서 기준으로 `node_id: N+1..M`, `parent_id: 소속 노드의 새
     node_id` 부여 + `echo_data→data` 매핑,
   - `'seq'` 메타 row를 `{ seq: M }`으로 기록,
   - 마지막에 §3.4 불변식 2·3·4를 검증하고 위반 시 롤백.
   또는 기존 `echo_migrate_export`/`import`에 신 스키마 타깃을 추가해 같은 절차를 태운다.
3. **서버 툴 위임** — `echo_dimension_put` 등은 시그니처를 유지한 채 내부를
   `djinn._graph` 호출로 교체 (스킬 문서/호출부 무변경 — 반환에 node_id가 추가로 실리는
   것은 additive). 자동 등록되는 `graph_*_echo` 툴과의 공존/치환 여부는 후속 과업에서 결정.

---

## 5. 테스트 계획 — `test/graph-smoke.js` (smoke.js 스타일) `[v2 개정]`

```
[attach/define]
  1. GraphDriver.attach(db) → db._graph === driver
  2. graph.define('g', { nodes: [...] }) → 루트 row(node_id 1, parent_id null) + 'seq' 메타
     row 생성, schems == 시드 키 집합, 시드 노드들의 node_id가 2..N으로 연속·중복 없음
  3. define() 재호출(멱등) → 기존 노드/루트 무변경 + node_id 불변 + seq 미증가
     (사용자 수정 보존: putNode로 description 바꾼 뒤 define() 재실행해도 안 되돌아감)
  4. define() 인덱스 — sqlite_master에서 복합(idx_g_docs__parent_key__child_key) 및
     node_id/parent_id 인덱스 존재 확인 + 기존 문자열 indexes 호출(legacy) 동작 무변경
[노드 = 테이블]
  5. putNode 신규 → node_id 발급·반환, parent_id === 1, 노드 row + 루트 schems 동시 반영
     (원자성: transaction 내 강제 throw 시 노드/schems/seq 셋 다 롤백 — seq 되감김 확인)
  6. putNode 기존(child_schema만) → description·created_at·node_id 보존, modified_at 갱신
  7. putNode('a::b') → throw
  8. delNode(손자 있음, cascade 없음) → throw / cascade:true → 손자 전멸 + schems 제거,
     이후 putNode 재생성 시 새(더 큰) node_id — 재사용 없음 확인
[손자 = 실데이터]
  9. putDoc → 테이블 PK 'parent::child', node_id 발급·반환,
     parent_id === getNode(parent).node_id (불변식 3), getDoc round-trip
 10. putDoc(미존재 노드) → throw / { autoCreateNode:true } → 부모 자동 생성(부모도 node_id
     발급) + schems 반영 — 전부 한 transaction
 11. listDocs → child_key 오름차순 보장 (역순 삽입 후 확인), keysOnly에 data 미포함·node_id
     포함, limit/offset 동작
 12. countDocs, delDoc(멱등 — 2회 호출 무해)
[id 링크]                                                                        [v2]
 13. node_id 유일성 — 루트/노드/손자 전 row의 node_id 수집 → 중복 0, 'seq'.seq >= max
 14. getByNodeId(1) → { level:'root' } / 노드 id → { level:'node' } / 손자 id →
     { level:'doc' } / 미존재 id → null
 15. childrenOf(1) → 자식 노드 전부 / childrenOf(노드 id) → 그 손자 전부 — 각 결과의
     parent_id가 인자와 일치 / childrenOf(손자 id) → [] (3단 고정: 손자는 자식 없음)
 16. 시퀀스 transaction 안전성 — putDoc N회 연속 → node_id가 정확히 N개 증가(결번 없음),
     중간 실패 1회 섞어도 성공분만 반영되고 유일성 유지
[core 통합]
 17. getDoc 2회 → heatmap에서 `g_docs` 컬렉션 hit 기록 확인 (캐시 경유 검증)
 18. putDoc 후 listDocs → 갱신 반영 (invalidatePrefix 검증)
[MCP]
 19. createMcpServer(djinn) 후 graph_catalog_g 등 9개 툴 등록 확인
 20. graph_doc_put_g에 잘못된 JSON data → 'Error: data must be valid JSON'
 21. graph_node_get_g에 key와 node_id 동시 지정/양쪽 생략 →
     'Error: pass exactly one of key or node_id' / node_id 단독 지정 → key 지정과 동일 결과
```

기존 `test/smoke.js`는 무수정 통과해야 한다 (legacy 회귀 게이트).

---

## 6. 버전 정책 — **0.2.0 제안 (채택, v2 무관 동일)**

- 신규 공개 API(`GraphDriver`) + core `define()`의 additive 확장(복합 인덱스) → semver **minor**.
- v1 구현이 미커밋·미릴리스 상태이므로 v1→v2는 버전 이벤트가 아니다 — 0.2.0 하나로 나간다.
- breaking change 없음: 기존 시그니처·동작 전부 유지, `indexes` 문자열 항목 처리 경로 불변.
- 새 의존성 없음 (better-sqlite3/zod/MCP SDK 기존 것만 사용).
- CHANGELOG에 "graph catalog 모드는 recommended, legacy generic collection은 계속 지원"을 명시.

---

## 부록 — 파일 변경 계획 (v1 구현 기준 수정)

| 파일 | 변경 |
|------|------|
| `src/graph.js` | v1 구현 개정 — 시퀀스(_nextId)·doc 형태(node_id/parent_id)·getByNodeId/childrenOf 추가·put 반환값 |
| `src/db.js` | v1의 복합 인덱스 확장 그대로 — v2 추가 변경 없음 |
| `src/mcp.js` | graph_* 툴 파라미터 개정 (key/node_id 양쪽 주소지정, 반환 node_id) |
| `src/index.js` | `GraphDriver` export (v1 그대로) |
| `test/graph-smoke.js` | §5로 개정 (id 링크·시퀀스 항목 추가) |
| `package.json` | `0.1.3` → `0.2.0` |
