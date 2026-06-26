# dJinn — 요구사항 정의서 (RFP)

## 배경

`doil-sb`의 `notion_meta.json`은 Notion 페이지 트리를 그래프 형태로 색인·캐싱하는 단일 JSON 파일이다. 초기에는 수십 KB·수백 노드 규모로 문제가 없었으나, 다음 잠재 이슈가 확인되었다.

| 이슈 | 현재 영향 | 임계점 |
|------|-----------|--------|
| 매 요청 전체 파일 동기 읽기 | 없음 | ~500 KB |
| 매 요청 BFS 재계산 | 없음 | ~500 노드 |
| 전체 파일 덮어쓰기 | 손상 위험 | 즉시 |
| 인덱스 없음 | 없음 | 검색 기능 추가 시 |

이를 해결하면서 **재사용 가능한 라이브러리**로 분리하기 위해 `dJinn`을 설계한다.

---

## 목표

### 기능 요구사항

| ID | 요구사항 | 우선순위 |
|----|----------|---------|
| F-01 | B-tree+ 기반 인덱싱 | 필수 |
| F-02 | LRU 캐싱 (전체 데이터 상주 불가 가정) | 필수 |
| F-03 | 자체 해시함수 (캐시 키 + 콘텐츠 무결성) | 필수 |
| F-04 | 히트맵 — 전체 인덱스 접근 패턴 집계 | 필수 |
| F-05 | MCP 서버 — 컬렉션 기반 툴 자동 생성 | 필수 |
| F-06 | 스키마 검증 + SQLite DDL 자동 생성 | 필수 |
| F-07 | ACID 트랜잭션 | 필수 |

### 비기능 요구사항

| ID | 요구사항 |
|----|----------|
| NF-01 | 별도 Docker 컨테이너 없이 임베디드로 동작 |
| NF-02 | 기존 `doil-sb/routes/graph.js` 변경 최소화 |
| NF-03 | npm 퍼블리싱 가능한 독립 패키지 구조 |
| NF-04 | `notion_meta.json` → `.db` 마이그레이션 경로 제공 |

---

## 설계 결정 및 근거

### SQLite 선택 이유

| 후보 | 탈락 이유 |
|------|----------|
| JSON 파일 직접 | 기존 문제의 원인 |
| MongoDB | Docker 컨테이너 추가, 용량 대비 기능 낭비 |
| NeDB / nedb-fork | 2016년 이후 유지보수 중단, 스키마·해시 미지원 |
| LowDB | JSON 파일 래퍼 수준, 인덱스 없음 |
| **SQLite** | 임베디드, ACID, B-tree, 성숙한 생태계, 파일 하나 |

### 레이어 분리 근거

`readMeta()` / `writeMeta()` 패턴의 문제는 세 가지 관심사(저장, 캐싱, 직렬화)가 한 함수에 뒤섞인 것이다. dJinn은 이를 분리한다.

```
기존:  readMeta() = fs.readFileSync + JSON.parse + 정규화 루프
dJinn: get()     = LRUCache.get → (miss) SQLite.get → deserialize
```

### MCP 레이어 위치 결정

MCP 서버를 doil-sb 레벨이 아닌 라이브러리 레벨에 두는 이유:

1. **컬렉션이 스키마를 안다**: `define()` 호출 후 컬렉션 구조가 dJinn 인스턴스에 있으므로, 툴 정의를 자동 생성할 수 있다.
2. **재사용성**: dJinn을 사용하는 모든 프로젝트가 MCP를 무료로 얻는다.
3. **doil-sb는 마운트만**: `serveMcp(db)` 한 줄로 완성. 툴 정의를 중복 작성하지 않는다.

### 히트맵 설계 근거

히트맵의 역할은 두 가지로 한정한다:

1. **시각화**: VOID//OS admin 패널 등에서 접근 패턴을 그래프로 보여준다.
2. **캐싱 참조**: `coldKeys()`로 hitRate 낮은 키를 식별, 캐시 교체 정책 보조.

히트맵이 **직접 캐시 교체를 수행하지 않는다**. LRU와 HitMap은 독립적이며, 필요 시 외부에서 `coldKeys()`를 참조해 강제 invalidate할 수 있다.

---

## 마이그레이션 계획

### notion_meta.json → dJinn

```
1. DJinn 초기화 + 컬렉션 정의 (nodes, edges)
2. notion_meta.json 읽기
3. nodes[], edges[] → db.transaction() 안에서 put() 일괄 삽입
4. graph.js의 readMeta() / writeMeta() → db.get/find/put/del 교체
5. notion_meta.json 보관 (롤백 대비, 스캔 완료 후 삭제)
```

### graph.js 변경 범위

| 함수 | 변경 |
|------|------|
| `readMeta()` | 삭제 |
| `writeMeta()` | 삭제 |
| `runScanAsync()` 내 저장 | `db.transaction()` + `put()` |
| `GET /data` | `db.find('nodes')` + `db.find('edges')` |
| `GET /data/:id` | `extractSubgraph()`는 그대로, 소스만 교체 |
| `mergeSubgraph()` | 트랜잭션 기반 del/put으로 교체 |

---

## 범위 외 (Out of Scope)

- 분산 / 복제 (단일 프로세스 전용)
- 전문 검색 (FTS)
- 관계형 JOIN
- 다중 쓰기 프로세스 동시 접근
