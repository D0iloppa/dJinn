'use strict';

// 그래프 카탈로그 — 루트(카탈로그) → 자식(테이블+DDL) → 손자(실데이터) 3단 고정 깊이 구조.
// VecDriver와 동일한 attach 패턴이지만 raw SQL은 절대 쓰지 않는다 — djinn의
// get/find/put/del/count/transaction 프리미티브만 사용해 LRU 캐시·HitMap·
// invalidatePrefix가 자동으로 유지되게 한다.
//
// [v2] 이중 주소 체계: key 주소(문자열, PK)는 v1 그대로 유지하고, 그 위에 전 계층
// node_id/parent_id(정수, adjacency list)를 얹는다. 루트 node_id=1·parent_id=null 고정,
// 자식 노드 parent_id=1, 손자 parent_id=소속 노드.node_id. 발급 후 불변·재사용 없음.

const NS_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

class GraphDriver {
  // DJinn 인스턴스에 attach. VecDriver 패턴과 동일.
  static attach(djinn) {
    const driver = new GraphDriver(djinn);
    djinn._graph = driver;
    return driver;
  }

  // `${parentKey}::${childKey}` — ai-echo makeChildId 컨벤션 그대로 채택 (테이블 PK, v1 불변)
  static makeDocId(parentKey, childKey) {
    return `${parentKey}::${childKey}`;
  }

  constructor(djinn) {
    this._djinn = djinn;
    this._namespaces = new Set(); // define()된 네임스페이스 — mcp.js가 순회
  }

  // ── 네임스페이스(=카탈로그 인스턴스) ──────────────────────────────

  // 3단 구조 생성 + 골격 시드 (멱등)
  define(ns, options = {}) {
    if (!NS_RE.test(ns)) {
      throw new Error(`GraphDriver: invalid namespace '${ns}'`);
    }

    this._djinn.define(`${ns}_root`, { indexes: ['modified_at'] });
    this._djinn.define(`${ns}_nodes`, {
      indexes: ['node_key', 'node_id', 'parent_id', 'modified_at'], // [v2] node_id/parent_id 추가
    });
    this._djinn.define(`${ns}_docs`, {
      indexes: [
        ['parent_key', 'child_key'], // 복합 표현식 인덱스 — 정렬된 range 스캔 보장
        'child_key',
        'node_id',    // [v2] getByNodeId용
        'parent_id',  // [v2] childrenOf(링크 순회)용
        'modified_at',
      ],
    });
    this._namespaces.add(ns);

    const now = new Date().toISOString();
    const root = this._djinn.get(`${ns}_root`, 'root');
    if (!root) {
      // 루트는 node_id=1·parent_id=null 고정 [v2]
      this._djinn.put(`${ns}_root`, 'root', {
        node_id: 1,
        parent_id: null,
        schems: {},
        created_at: now,
        modified_at: now,
      });
    }
    const seq = this._djinn.get(`${ns}_root`, 'seq');
    if (!seq) {
      // 시퀀스 메타 row — 1은 루트가 이미 소비했으므로 다음 발급은 2부터 [v2]
      this._djinn.put(`${ns}_root`, 'seq', { seq: 1 });
    }

    for (const node of (options.nodes || [])) {
      const existing = this.getNode(ns, node.key);
      if (!existing) {
        // 시드도 putNode 경로를 타므로 각자 node_id를 할당받고 parent_id=1로 링크된다 [v2]
        this.putNode(ns, node.key, { description: node.description, child_schema: node.child_schema });
      }
    }
    return this;
  }

  // ── 루트 (SHOW TABLES) ──────────────────────────────────────────

  // 카탈로그 조회 → { node_id: 1, parent_id: null, schems, created_at, modified_at }.
  // djinn.get 위임 — LRU 캐시 자동 적용. 'seq' 메타 row는 보지 않는다(소비자 관점 의미 불변).
  catalog(ns) {
    return this._djinn.get(`${ns}_root`, 'root');
  }

  // ── 자식 노드 (테이블 + DDL) ────────────────────────────────────

  // 노드 upsert = CREATE TABLE / ALTER TABLE. transaction 안에서 시퀀스 발급(신규만) +
  // 노드 row + 루트 schems를 원자적으로 동기화한다.
  putNode(ns, key, { description, child_schema } = {}) {
    this._assertKey(key);
    return this._djinn.transaction(() => {
      const now = new Date().toISOString();
      const prev = this._djinn.get(`${ns}_nodes`, key);
      const nodeId = prev?.node_id ?? this._nextId(ns); // [v2] 신규만 발급, 기존은 불변
      this._djinn.put(`${ns}_nodes`, key, {
        node_id: nodeId,
        parent_id: 1, // [v2] 루트 링크
        node_key: key,
        child_schema: child_schema ?? prev?.child_schema ?? {},
        created_at: prev?.created_at ?? now,
        modified_at: now,
      });
      const root = this._djinn.get(`${ns}_root`, 'root');
      if (!root) this._throwUndefined(ns);
      const schems = { ...root.schems, [key]: description ?? root.schems[key] ?? key };
      this._djinn.put(`${ns}_root`, 'root', { ...root, schems, modified_at: now });
      return { node_key: key, node_id: nodeId };
    });
  }

  // 노드 단건 조회 → { id, node_id, parent_id, node_key, child_schema, ... } | null
  getNode(ns, key) {
    return this._djinn.get(`${ns}_nodes`, key);
  }

  // 노드 삭제 = DROP TABLE. cascade 없이 손자가 있으면 에러(안전 우선).
  // node_id는 재사용하지 않는다(시퀀스는 계속 전진) [v2].
  delNode(ns, key, options = {}) {
    this._assertKey(key);
    const cascade = options.cascade ?? false;
    return this._djinn.transaction(() => {
      const docs = this.listDocs(ns, key, { keysOnly: true });
      if (!cascade && docs.length > 0) {
        throw new Error('GraphDriver: node has docs — pass cascade');
      }
      let deletedDocs = 0;
      if (cascade) {
        for (const doc of docs) {
          this._djinn.del(`${ns}_docs`, GraphDriver.makeDocId(key, doc.child_key));
          deletedDocs++;
        }
      }
      this._djinn.del(`${ns}_nodes`, key);
      const root = this._djinn.get(`${ns}_root`, 'root');
      if (root) {
        const schems = { ...root.schems };
        delete schems[key];
        this._djinn.put(`${ns}_root`, 'root', { ...root, schems, modified_at: new Date().toISOString() });
      }
      return { deletedDocs };
    });
  }

  // ── 손자 노드 (실데이터) ────────────────────────────────────────

  // 손자 upsert. 테이블 PK = makeDocId(parentKey, childKey). 부모 노드가 없으면 에러가
  // 기본(엄격 모드) — { autoCreateNode: true }면 빈 child_schema로 부모를 자동 생성
  // (같은 transaction — 이때 부모도 node_id를 할당받는다).
  putDoc(ns, parentKey, childKey, data, options = {}) {
    this._assertKey(childKey);
    const autoCreateNode = options.autoCreateNode ?? false;
    return this._djinn.transaction(() => {
      let node = this._djinn.get(`${ns}_nodes`, parentKey);
      if (!node) {
        if (!autoCreateNode) {
          throw new Error(`GraphDriver: unknown node '${parentKey}'`);
        }
        this.putNode(ns, parentKey, {});
        node = this._djinn.get(`${ns}_nodes`, parentKey);
      }
      const now = new Date().toISOString();
      const id = GraphDriver.makeDocId(parentKey, childKey);
      const prev = this._djinn.get(`${ns}_docs`, id);
      const nodeId = prev?.node_id ?? this._nextId(ns); // [v2] 신규만 발급
      this._djinn.put(`${ns}_docs`, id, {
        node_id: nodeId,
        parent_id: node.node_id, // [v2] 소속 노드로 링크
        parent_key: parentKey,
        child_key: childKey,
        data,
        created_at: prev?.created_at ?? now,
        modified_at: now,
      });
      return { parent_key: parentKey, child_key: childKey, node_id: nodeId };
    });
  }

  // point lookup → { id, node_id, parent_id, parent_key, child_key, data, ... } | null.
  // djinn.get 위임(캐시 적용).
  getDoc(ns, parentKey, childKey) {
    return this._djinn.get(`${ns}_docs`, GraphDriver.makeDocId(parentKey, childKey));
  }

  // 손자 목록 — child_key 오름차순 보장 (복합 인덱스로 정렬된 range 스캔).
  listDocs(ns, parentKey, options = {}) {
    const { keysOnly = false, limit, offset } = options;
    const docs = this._djinn.find(
      `${ns}_docs`,
      { parent_key: parentKey },
      { orderBy: 'child_key', limit, offset }
    );
    if (keysOnly) {
      return docs.map(d => ({
        child_key: d.child_key,
        node_id: d.node_id, // [v2]
        created_at: d.created_at,
        modified_at: d.modified_at,
      }));
    }
    return docs;
  }

  // 손자 삭제. 존재하지 않아도 no-op (djinn.del과 동일 의미론). node_id 재사용 없음.
  delDoc(ns, parentKey, childKey) {
    this._djinn.del(`${ns}_docs`, GraphDriver.makeDocId(parentKey, childKey));
  }

  // 손자 카운트 → number. parentKey 생략 시 전체 카운트.
  countDocs(ns, parentKey) {
    const where = parentKey != null ? { parent_key: parentKey } : {};
    return this._djinn.count(`${ns}_docs`, where);
  }

  // ── id 링크 순회 [v2 신규 — 링크 순회에 필요한 최소한만] ─────────

  // node_id로 계층 무관 단건 해석(resolve). 재귀 순회 API는 만들지 않는다(3단 고정, 과설계 금지).
  getByNodeId(ns, nodeId) {
    if (nodeId === 1) {
      const root = this.catalog(ns);
      return root ? { level: 'root', ...root } : null;
    }
    const nodeRows = this._djinn.find(`${ns}_nodes`, { node_id: nodeId });
    if (nodeRows.length) return { level: 'node', ...nodeRows[0] };
    const docRows = this._djinn.find(`${ns}_docs`, { node_id: nodeId });
    if (docRows.length) return { level: 'doc', ...docRows[0] };
    return null;
  }

  // parent_id 링크를 따라 직계 자식 목록. nodeId===1 → 자식 노드들, 그 외 → 손자 doc들.
  // 3단 고정이므로 이 두 경우가 전부다(손자의 자식은 항상 빈 배열).
  childrenOf(ns, nodeId, options = {}) {
    const { keysOnly = false } = options;
    if (nodeId === 1) {
      const nodes = this._djinn.find(`${ns}_nodes`, { parent_id: 1 });
      if (!keysOnly) return nodes;
      return nodes.map(n => ({
        node_key: n.node_key,
        node_id: n.node_id,
        created_at: n.created_at,
        modified_at: n.modified_at,
      }));
    }
    const docs = this._djinn.find(`${ns}_docs`, { parent_id: nodeId });
    if (!keysOnly) return docs;
    return docs.map(d => ({
      child_key: d.child_key,
      node_id: d.node_id,
      created_at: d.created_at,
      modified_at: d.modified_at,
    }));
  }

  // ── internal ──────────────────────────────────────────────────

  // [v2] 시퀀스 증가 — 반드시 호출측 transaction 내부에서 사용
  _nextId(ns) {
    const row = this._djinn.get(`${ns}_root`, 'seq');
    if (!row) this._throwUndefined(ns);
    const next = row.seq + 1;
    this._djinn.put(`${ns}_root`, 'seq', { seq: next });
    return next;
  }

  _throwUndefined(ns) {
    throw new Error(`GraphDriver: namespace '${ns}' not defined — call define() first`);
  }

  _assertKey(key) {
    if (key == null || String(key).trim() === '') {
      throw new Error('GraphDriver: key must be non-empty');
    }
    if (String(key).includes('::')) {
      throw new Error('GraphDriver: key must not contain "::"');
    }
  }
}

module.exports = { GraphDriver };
