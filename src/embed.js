'use strict';

// 텍스트 → 벡터 aggregator — VecDriver/GraphDriver 내부에는 관여하지 않는 별도 계층.
// 설정(모델 목록·API 키)은 GraphDriver의 `_sys` 네임스페이스에 저장하고(퍼블릭 API만 사용),
// 임베딩 결과는 VecDriver의 upsert/search로 흘려보낸다. config(api_key)가 없으면
// isConfigured()가 false를 반환 — mcp.js가 이를 보고 vec_*/embed_* 툴 등록 자체를 잠근다.

class EmbedDriver {
  // DJinn 인스턴스에 attach. GraphDriver/VecDriver 패턴과 동일.
  static attach(djinn) {
    const driver = new EmbedDriver(djinn);
    djinn._embed = driver;
    return driver;
  }

  constructor(djinn) {
    this._djinn = djinn;
  }

  // ── 설정 (GraphDriver `_sys` 네임스페이스에 저장) ──────────────────

  // `_sys` 카탈로그 + 'config' 노드 골격 시드 (멱등 — define()이 이미 멱등 보장)
  defineConfig() {
    this._assertGraph();
    this._djinn._graph.define('_sys', {
      nodes: [{
        key: 'config',
        description: 'EmbedDriver 설정(모델 목록/API 키)',
        child_schema: { models: '임베딩 모델 엔트리 목록', apikey: '엔트리별 API 키' },
      }],
    });
    return this;
  }

  // models.json의 embedding 배열 스냅샷을 통째로 저장 — entries: [{id, provider, model, ...}]
  setModels(entries) {
    this._assertGraph();
    return this._djinn._graph.putDoc('_sys', 'config', 'models', { entries });
  }

  // 엔트리별 API 키 저장 (평문 — 암호화는 의도적으로 하지 않음)
  setApiKey(entryId, key) {
    this._assertGraph();
    return this._djinn._graph.putDoc('_sys', 'config', 'apikey/' + entryId, { key });
  }

  // 저장된 모델 엔트리 목록 → entries 배열 | null
  getModels() {
    this._assertGraph();
    const doc = this._djinn._graph.getDoc('_sys', 'config', 'models');
    return doc ? doc.data.entries : null;
  }

  // 엔트리별 API 키 조회 → key 문자열 | null
  getApiKey(entryId) {
    this._assertGraph();
    const doc = this._djinn._graph.getDoc('_sys', 'config', 'apikey/' + entryId);
    return doc ? doc.data.key : null;
  }

  // 임베딩 설정 엔트리 하나 해석 — id 지정 시 그 엔트리, 생략 시 첫 번째(기본값) (_common.py task_cfg 의미론과 동일)
  getEntry(id) {
    this._assertGraph();
    const entries = this.getModels();
    if (!entries || entries.length === 0) return null;
    if (id == null) return entries[0];
    return entries.find((e) => e.id === id) || null;
  }

  // config/api_key 설정 완료 여부 — mcp.js가 등록 시점에 동기 호출하므로 반드시 동기 유지
  // (GraphDriver 읽기는 전부 동기). defineConfig() 호출 전(=_sys 네임스페이스 미정의)에도
  // 안전하게 false를 반환해야 하므로 미정의 컬렉션 조회 에러를 여기서 흡수한다.
  isConfigured() {
    this._assertGraph();
    try {
      if (!this._djinn._graph.getNode('_sys', 'config')) return false;
      const entry = this.getEntry();
      if (!entry) return false;
      const key = this.getApiKey(entry.id);
      return typeof key === 'string' && key.length > 0;
    } catch {
      return false;
    }
  }

  // ── 핵심 엔트리 포인트 — 텍스트 → 벡터 ─────────────────────────────

  // provider별 임베딩 API 호출. api_key 미설정이면 잠금(throw) — isConfigured()가 gate.
  async embed(text, { id, model } = {}) {
    this._assertGraph();
    if (!this.isConfigured()) {
      throw new Error('EmbedDriver: config/api_key not set — embed feature is locked');
    }
    const entry = this.getEntry(id);
    if (!entry) {
      throw new Error(`EmbedDriver: no matching model entry for id '${id}'`);
    }
    const key = this.getApiKey(entry.id);
    // 방어적 이중 잠금 — isConfigured()는 기본(첫) 엔트리만 검사하므로, id로 다른 엔트리를
    // 지정했을 때 그 엔트리에 키가 없으면 여기서 다시 막는다(등록 시점 게이트와 별개로
    // 호출 시점에도 엔트리별로 검증) — 'Bearer null'/'?key=null'로 실제 요청이 나가는 것을 방지.
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error(`EmbedDriver: config/api_key not set for entry '${entry.id}' — embed feature is locked`);
    }

    if (entry.provider === 'nvidia') {
      const res = await fetch('https://integrate.api.nvidia.com/v1/embeddings', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + key,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: model || entry.model,
          input: [text],
          encoding_format: 'float',
          input_type: entry.input_type || 'query',
          truncate: 'NONE',
        }),
      });
      if (!res.ok) {
        const bodyText = await res.text();
        throw new Error('API ' + res.status + ': ' + bodyText.slice(0, 300));
      }
      const json = await res.json();
      return json.data[0].embedding;
    }

    if (entry.provider === 'gemini') {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model || entry.model}:embedContent?key=${encodeURIComponent(key)}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: { parts: [{ text }] } }),
      });
      if (!res.ok) {
        const bodyText = await res.text();
        throw new Error('API ' + res.status + ': ' + bodyText.slice(0, 300));
      }
      const json = await res.json();
      return json.embedding.values;
    }

    throw new Error(`EmbedDriver: unknown provider '${entry.provider}' — supported: nvidia, gemini`);
  }

  // ── 편의 메서드 (embed() + VecDriver 결합) ─────────────────────────

  // 임베딩 후 곧바로 vec 컬렉션에 upsert → 벡터 차원 수 반환
  async embedAndUpsert(collection, docId, text, opts = {}) {
    this._assertVec();
    const v = await this.embed(text, opts);
    this._djinn._vec.upsert(collection, docId, v);
    return v.length;
  }

  // 임베딩 후 곧바로 vec 컬렉션에서 k-NN 검색 → [{id, distance}]
  async embedAndSearch(collection, text, k = 10, opts = {}) {
    this._assertVec();
    const v = await this.embed(text, opts);
    return this._djinn._vec.search(collection, v, k);
  }

  // ── internal ──────────────────────────────────────────────────

  _assertGraph() {
    if (!this._djinn._graph) {
      throw new Error('EmbedDriver: GraphDriver not attached — attach it first (config is stored in the _sys namespace)');
    }
  }

  _assertVec() {
    if (!this._djinn._vec) {
      throw new Error('EmbedDriver: VecDriver not attached');
    }
  }
}

module.exports = { EmbedDriver };
