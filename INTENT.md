# DJinn 설계 의도 (INTENT)

> 이 문서는 DJinn이 무엇이고 무엇이 아닌지를 명백히 정의한다.
> 기능을 추가하거나 구조를 변경하기 전에 반드시 이 문서를 먼저 읽어야 한다.

---

## DJinn이 존재하는 이유

노션 페이지 트리를 크롤링해서 그래프 뷰로 렌더링하기 위해,
노드와 엣지 데이터를 **가볍게 영속화하고 조회**할 수단이 필요했다.

초기 구현은 `notion_meta.json` 파일 하나에 전체 데이터를 직렬화하는 방식이었다.
단순하지만 세 가지 문제가 있었다:

1. 쓸 때마다 파일 전체를 재작성해야 함 (점진적 갱신 불가)
2. 읽을 때마다 전체 파싱 (단 하나의 노드를 조회해도)
3. 동시 읽기/쓰기 중 파일이 깨질 수 있음

이 문제를 해결하기 위해 SQLite를 도입했고,
그 위에 LRU 캐시와 HitMap을 얹은 것이 DJinn이다.

---

## DJinn이 하는 일

**JSON 객체를 id로 저장하고, id 또는 필드값으로 꺼낸다.**

그게 전부다.

```js
db.put('nodes', 'abc', { title: '페이지', grp: 'root', 아무필드: '자유' })
db.get('nodes', 'abc')
db.find('nodes', { '$.grp': 'root' })
db.count('nodes', { '$.grp': 'root' })
db.del('nodes', 'abc')
```

---

## DJinn이 하지 않는 일

| 하지 않음 | 이유 |
|-----------|------|
| 필드 타입 강제 | MongoDB에 타입 선언 안 한다. JSON이 알아서 한다. |
| required 검증 | 애플리케이션 레이어의 책임이다. |
| 컬럼 추가 (ALTER TABLE) | 컬럼은 `id`와 `doc` 단 둘뿐이다. 영원히. |
| 스키마 정의 요구 | `define('nodes')` — 스키마 인자 없다. |
| ORM 역할 | DJinn은 SQL을 감추는 도구가 아니다. |

---

## 테이블 구조 — 바뀌지 않는 불변 원칙

```sql
CREATE TABLE {collection} (
  id  TEXT PRIMARY KEY,
  doc TEXT NOT NULL   -- JSON.stringify() 결과
);
```

**`id`와 `doc`, 딱 두 컬럼이다. 새 필드가 생겨도 컬럼을 추가하지 않는다.**
새 필드는 `doc` 안의 JSON에 추가하면 된다.

자주 쿼리되는 필드만 선택적으로 **JSON 경로 인덱스**를 선언한다:

```sql
CREATE INDEX idx_nodes_grp ON nodes(json_extract(doc, '$.grp'));
```

---

## v1의 실수와 교훈

v1에서 `Schema` 클래스가 생긴 경위:

`better-sqlite3`의 prepared statement는 처음 컴파일 시점의 컬럼 수를 고정한다.
Optional 필드를 누락하면 컬럼 수가 달라져 오류가 발생했다.
이를 피하려고 `validate()`가 없는 필드에 `null`을 채워 항상 모든 컬럼을 반환하게 했다.

→ 이것이 Schema 클래스, required, default, type coercion, `toSQLColumns()`, `ALTER TABLE` 자동화로 불어났다.
→ DJinn이 ORM처럼 보이기 시작했다.
→ 이것은 JSON 스토리지가 아니다.

**v2의 해결**: `{id, doc}` 두 컬럼 고정 → prepared statement는 항상 `INSERT INTO t (id, doc) VALUES (?, ?)`
→ 컬럼 수 불일치 문제 자체가 사라진다 → Schema 불필요 → ALTER TABLE 불필요.

---

## 무엇을 추가해도 되는가

아래 기준을 만족하면 추가해도 된다:

- **JSON 문서를 더 잘 저장/조회하기 위한 것인가?** → OK
- **SQLite에서 가져올 수 있는 성능 이점인가?** → OK (인덱스, WAL, 트랜잭션 등)
- **LRU / HitMap 개선인가?** → OK
- **MCP 툴 추가인가?** → OK (컬렉션 기반 자동생성 원칙 유지)

아래는 추가하면 안 된다:

- 필드 타입을 강제하는 어떤 것
- 컬럼을 동적으로 추가하는 어떤 것
- 스키마 선언 없이는 동작 안 하는 어떤 것
- DJinn을 특정 도메인(노션, 그래프 등)에 종속시키는 어떤 것

---

## 한 줄 요약

> DJinn은 **JSON 파일의 불편함을 SQLite로 해소한 경량 문서 스토어**다.
> MongoDB를 만들려는 것도, ORM을 만들려는 것도 아니다.
