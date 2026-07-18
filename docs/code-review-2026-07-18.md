# dJinn 0.2.0 코드 리뷰 — 수정 필요 사항

- **리뷰 범위**: `e16ac79..HEAD` (0.2.0 — VecDriver / GraphDriver / EmbedDriver / MCP 확장)
- **리뷰 일자**: 2026-07-18
- **결과**: 심각 2건(보안), 중간 3건, 경미 3건 + 문서 불일치 1건
- **조치 상태**: ✅ **전 항목(1~8 + README) 조치 완료** (2026-07-18)
  - 1: mcp.js — `_` prefix 네임스페이스/컬렉션을 내부 예약으로 취급, 툴 생성 전 경로에서 제외
  - 2: db.js — `toPath`에 `PATH_RE` 화이트리스트 검증 추가(where 키·orderBy·인덱스 경로 일괄), `define`에 `NAME_RE` 검증, MCP find/count 핸들러 try/catch
  - 3: vec.js — `upsert`/`delete`를 `db.transaction`으로 원자화
  - 4: db.js — `_buildWhere`가 shape(경로+연산자) 키를 반환, statement 캐시 키에서 값 제거
  - 5: vec.js — `sqlite-vec` require를 `attach()` 시점 lazy 로드로 이동
  - 6: embed.js — `isConfigured()`를 "키가 설정된 엔트리가 하나라도 있으면 true"로 완화
  - 7: graph.js — root/seq 부재 시 `namespace not defined — call define() first` 명시적 에러
  - 8: vec.js — `NAME_RE` 검증 + 전 메서드에 `_assertDefined` 추가
  - README: `djinn_count_{collection}` 표 추가, `_` prefix 내부 예약 규칙 명시, `isConfigured` 의미 갱신
  - 검증: 기존 smoke 테스트 3종 통과 + 항목별 검증 스크립트(_sys 툴 미생성, 인젝션 차단, stmt 캐시 불변, vec 원자성/검증) 통과

---

## 심각 (즉시 수정 권장)

### 1. `_sys` 네임스페이스가 MCP 툴로 노출되어 API 키가 평문 유출됨

- **위치**: `src/embed.js:25` (`defineConfig`), `src/mcp.js:16,207`
- **문제**: `embed.defineConfig()`가 `graph.define('_sys')`를 호출하면 `_sys`가
  `graph._namespaces`와 `djinn._collections`(`_sys_root/_sys_nodes/_sys_docs`)에
  일반 네임스페이스로 등록된다. `createMcpServer()`는 등록된 모든 네임스페이스·컬렉션을
  순회하며 툴을 만들기 때문에 `graph_doc_get__sys`, `djinn_find__sys_docs` 등이 자동 생성된다.
- **재현**: MCP에서 `graph_doc_get__sys(parent_key='config', child_key='apikey/default')`
  → `{ data: { key: '<평문 API 키>' } }` 반환.
- **영향**: README(212, 476행)의 "API 키는 MCP로는 설정도 조회도 불가능" 보안 주장이 깨짐.
  embed 툴 게이팅(`isConfigured`)과 무관하게 항상 노출된다.
- **수정 제안**: `mcp.js`에서 `_` prefix(또는 `_sys` 고정) 네임스페이스·컬렉션을
  툴 생성 대상에서 제외. 최소한 `_sys_*` 컬렉션과 `_sys` 네임스페이스는 스킵.

### 2. MCP `djinn_find`/`djinn_count`의 where 키를 통한 SQL 인젝션

- **위치**: `src/db.js:206` (`_normalizeWhere`), `src/db.js:212-216` (`_buildWhere`), `src/db.js:9` (`toPath`)
- **문제**: where의 **키**(JSON 경로)가 아무 검증 없이
  `json_extract(doc, '${path}')`로 SQL 문자열에 직접 보간된다. `toPath`는 `$.` prefix만 붙인다.
- **재현**: `djinn_find_{col}` 툴에
  `where = {"t') = 0 UNION SELECT id, doc FROM _sys_docs --": "x"}`
  → 임의 SELECT 실행. embed 툴이 잠겨 있어도 `_sys_docs`의 API 키를 읽을 수 있다
  (발견 1과 결합 시 이중 유출 경로).
- **영향**: MCP로 연결된 LLM(또는 프롬프트 인젝션된 입력)이 DB 내 임의 테이블 조회 가능.
  `orderBy` 보간(`db.js:96,140`)도 동일 취약 — 현재는 host API에서만 도달.
- **수정 제안**: JSON 경로 화이트리스트 검증
  (예: `/^\$?\.?[\w가-힣]+(\.[\w가-힣]+)*$/` 류의 정규식으로 키·orderBy 모두 검증)
  후 통과 못 하면 throw. 인덱스 경로(`define`)도 동일 검증 적용.

---

## 중간

### 3. `VecDriver.upsert`/`delete`가 트랜잭션 없이 다중 write 수행

- **위치**: `src/vec.js:39-57, 84-91`
- **문제**: upsert가 DELETE(vec) → DELETE(map) → INSERT(vec) → INSERT(map) 4개
  statement를 개별 실행. 중간 실패/크래시 시 벡터는 있는데 매핑이 없거나(검색 결과 유실),
  기존 벡터 삭제 후 새 벡터 미삽입(데이터 유실) 상태가 남는다.
- **수정 제안**: `this._db.transaction(...)`으로 묶기. 겸사겸사
  `INSERT OR REPLACE` + `UPDATE ... WHERE rowid` 형태로 statement 수 축소 가능.

### 4. prepared statement 캐시 키에 where '값'이 포함되어 무한 증가

- **위치**: `src/db.js:101` (`find`), `src/db.js:152` (`count`), `src/db.js:220-223` (`_stmt`)
- **문제**: SQL은 값을 `?`로 바인딩해 동일한데, 캐시 키는 `JSON.stringify(norm)`으로
  값까지 포함한다. distinct 값마다 동일 SQL이 새로 prepare되어 `_stmts` Map에 영구 저장 —
  statement 재사용이라는 기능 자체가 무효화되고, 장기 실행 MCP 서버에서 메모리가 누적된다.
  `graph.listDocs`가 parent_key별로 `find`를 호출하므로 graph 모드에서 특히 잘 발생.
- **수정 제안**: 캐시 키를 "경로 + 연산자(=/LIKE) + orderBy/paging 유무"만으로 구성
  (값 제외). LIKE 여부는 값에 의존하므로 키에 `like:` 플래그로만 반영.

### 5. `sqlite-vec` 로드 실패 시 패키지 전체 require 불가

- **위치**: `src/vec.js:3-8`, `src/index.js:8`
- **문제**: `vec.js`가 모듈 로드 시점에 `require('sqlite-vec')` 실패 → throw 하고,
  `index.js`가 이를 무조건 require한다. 네이티브 바이너리가 없는 플랫폼/설치 실패 환경에서는
  VecDriver를 안 쓰는 legacy·graph 사용자까지 `require('@d0iloppa/djinn')` 자체가 실패한다.
  README 설계 철학 "드라이버는 attach로 옵트인 — 쓰지 않으면 존재하지 않는 것과 같다" 위반.
- **수정 제안**: `sqlite-vec` require를 `VecDriver.attach()` 내부로 lazy 이동.
  (선택) package.json에서 `optionalDependencies`로 강등 검토.

---

## 경미

### 6. `embed.isConfigured()`가 기본(첫) 엔트리만 검사 — 게이팅 불일치

- **위치**: `src/embed.js:73-84`
- **문제**: 엔트리 A(키 없음)·B(키 있음) 순서면 B가 완전히 설정돼 있어도 `false`
  → `vec_*`/`embed_*` 툴 전체 미등록. 반대로 A만 키가 있으면 툴은 등록되지만
  `embed_text(id='B')`는 런타임 에러. 등록 게이트와 실제 사용 가능 범위가 불일치.
- **수정 제안**: "키가 설정된 엔트리가 하나라도 있으면 true"로 완화하거나,
  현 동작(기본 엔트리 기준)을 README에 명시.

### 7. `define(ns)` 없이 `putNode`/`putDoc` 호출 시 불명확한 TypeError

- **위치**: `src/graph.js:110` (`root.schems`), `src/graph.js:262-263` (`row.seq`)
- **문제**: define을 건너뛰면 root/seq row가 없어
  `Cannot read properties of null` 류의 원인 불명 에러로 크래시.
- **수정 제안**: `_nextId`/`putNode`에서 root/seq 부재 시
  `GraphDriver: namespace '<ns>' not defined — call define() first` 형태로 명시적 throw.

### 8. `VecDriver` collection 이름 무검증 SQL 보간 — GraphDriver와 비일관

- **위치**: `src/vec.js:26-33` (및 upsert/search/delete/count 전 메서드)
- **문제**: `graph.js`는 `NS_RE`(`graph.js:12`)로 네임스페이스를 검증하는데
  `vec.js`는 `${collection}_vec`를 무검증 보간. 호스트 코드가 외부 입력을
  collection 이름으로 넘기면 임의 SQL 실행 가능.
- **수정 제안**: `NS_RE`와 동일한 식별자 정규식을 `define()` 및 각 메서드 진입점에서 검증.
  (발견 2의 경로 검증과 함께 공용 util로 빼면 일관성 확보.)

---

## 문서 불일치 (README)

- README "Legacy 컬렉션 자동 생성 툴" 표에 `djinn_count_{collection}`이 빠져 있음
  (`src/mcp.js:103-113`에는 존재). 표에 한 줄 추가 필요.
- 발견 1 수정 전까지는 README 212·476행의 "API 키는 MCP로 조회 불가" 문구가 사실과 다름 —
  코드 수정과 함께 유지하거나, 수정 전이라면 문구를 내려야 함.

---

## 권장 수정 순서

1. **발견 1 + 2** (보안 — `_sys` MCP 제외 + 경로 검증, 공용 식별자/경로 util 도입)
2. **발견 8** (같은 util로 vec collection 검증 — 1·2와 한 커밋 가능)
3. **발견 3** (vec 트랜잭션)
4. **발견 4** (stmt 캐시 키)
5. **발견 5, 6, 7 + README** (경미·문서)
