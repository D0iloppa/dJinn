'use strict';

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

// DJinn 인스턴스 → MCP 서버
// 등록된 컬렉션마다 get/find/put/del/count 툴을 자동 생성
function createMcpServer(djinn, options = {}) {
  const name    = options.name    || 'djinn';
  const version = options.version || '0.1.0';

  const server = new McpServer({ name, version });

  // 등록된 컬렉션 목록
  const collections = [...djinn._collections.keys()];

  // --- 공통 툴 ---

  server.tool(
    'djinn_collections',
    'List all registered collections',
    {},
    async () => ({
      content: [{ type: 'text', text: JSON.stringify({ collections }, null, 2) }],
    })
  );

  server.tool(
    'djinn_heatmap',
    'Get access heatmap — hit/miss counts per key and per collection',
    {},
    async () => ({
      content: [{ type: 'text', text: JSON.stringify(djinn.heatmap(), null, 2) }],
    })
  );

  server.tool(
    'djinn_cache_stats',
    'Get LRU cache statistics',
    {},
    async () => ({
      content: [{ type: 'text', text: JSON.stringify(djinn.cacheStats(), null, 2) }],
    })
  );

  // --- 컬렉션별 자동 생성 툴 ---

  for (const col of collections) {
    const C = col; // 클로저 캡처

    server.tool(
      `djinn_get_${C}`,
      `Get a single document from '${C}' by id`,
      { id: z.string().describe('Document id') },
      async ({ id }) => {
        const doc = djinn.get(C, id);
        return { content: [{ type: 'text', text: JSON.stringify(doc, null, 2) }] };
      }
    );

    server.tool(
      `djinn_find_${C}`,
      `Find documents in '${C}'. Pass where as JSON string (e.g. {"grp":"root"}) or omit for all. Values with % use LIKE (e.g. {"title":"%HBM%"}).`,
      { where: z.string().optional().describe('JSON object of field=value filters (e.g. {"grp":"root"} or {"title":"%HBM%"} for LIKE)') },
      async ({ where }) => {
        let filter = {};
        if (where) { try { filter = JSON.parse(where); } catch { return { content: [{ type: 'text', text: 'Error: where must be valid JSON' }] }; } }
        const docs = djinn.find(C, filter);
        return { content: [{ type: 'text', text: JSON.stringify(docs, null, 2) }] };
      }
    );

    server.tool(
      `djinn_put_${C}`,
      `Insert or replace a document in '${C}'`,
      {
        id:  z.string().describe('Document id'),
        doc: z.string().describe('Document fields as JSON string'),
      },
      async ({ id, doc: docStr }) => {
        let doc;
        try { doc = JSON.parse(docStr); } catch { return { content: [{ type: 'text', text: 'Error: doc must be valid JSON' }] }; }
        try {
          djinn.put(C, id, doc);
          return { content: [{ type: 'text', text: JSON.stringify({ ok: true, id }) }] };
        } catch (e) {
          return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
        }
      }
    );

    server.tool(
      `djinn_del_${C}`,
      `Delete a document from '${C}' by id`,
      { id: z.string().describe('Document id') },
      async ({ id }) => {
        djinn.del(C, id);
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, id }) }] };
      }
    );

    server.tool(
      `djinn_count_${C}`,
      `Count documents in '${C}'. Pass where as JSON string (e.g. {"source":"nodeId"}) or omit for total count.`,
      { where: z.string().optional().describe('JSON object of field=value filters (e.g. {"grp":"root"}); omit for total count') },
      async ({ where }) => {
        let filter = {};
        if (where) { try { filter = JSON.parse(where); } catch { return { content: [{ type: 'text', text: 'Error: where must be valid JSON' }] }; } }
        const n = djinn.count(C, filter);
        return { content: [{ type: 'text', text: JSON.stringify({ count: n, collection: C, where: filter }) }] };
      }
    );
  }

  // --- vec 툴 (VecDriver.attach() 호출 시 자동 등록) ---
  // EmbedDriver가 attach된 경우 config/api_key가 없으면(isConfigured()===false) vec_* 툴도
  // 함께 잠근다 — EmbedDriver 미attach 시(순수 VecDriver 사용자)는 기존 동작 그대로 유지(하위호환).
  const embedGate = !djinn._embed || djinn._embed.isConfigured();

  if (djinn._vec && embedGate) {
    const vec = djinn._vec;

    for (const col of vec._defined) {
      const C = col;

      server.tool(
        `vec_upsert_${C}`,
        `Store an embedding vector for a document in '${C}'. embedding is a JSON float array.`,
        {
          id:        z.string().describe('Document id (must exist in collection)'),
          embedding: z.string().describe('Float array as JSON, e.g. [0.1, 0.2, ...]'),
        },
        async ({ id, embedding: embStr }) => {
          let emb;
          try { emb = JSON.parse(embStr); } catch { return { content: [{ type: 'text', text: 'Error: embedding must be a JSON float array' }] }; }
          if (!Array.isArray(emb)) return { content: [{ type: 'text', text: 'Error: embedding must be an array' }] };
          try {
            vec.upsert(C, id, emb);
            return { content: [{ type: 'text', text: JSON.stringify({ ok: true, id, dim: emb.length }) }] };
          } catch (e) {
            return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
          }
        }
      );

      server.tool(
        `vec_search_${C}`,
        `k-nearest neighbor search in '${C}' by embedding similarity. Returns [{id, distance}] sorted by distance ascending.`,
        {
          embedding: z.string().describe('Query float array as JSON, e.g. [0.1, 0.2, ...]'),
          k:         z.number().int().min(1).max(100).optional().describe('Number of results (default 10)'),
        },
        async ({ embedding: embStr, k = 10 }) => {
          let emb;
          try { emb = JSON.parse(embStr); } catch { return { content: [{ type: 'text', text: 'Error: embedding must be a JSON float array' }] }; }
          try {
            const results = vec.search(C, emb, k);
            return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
          } catch (e) {
            return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
          }
        }
      );

      server.tool(
        `vec_delete_${C}`,
        `Remove the stored embedding for a document in '${C}'`,
        { id: z.string().describe('Document id') },
        async ({ id }) => {
          try {
            vec.delete(C, id);
            return { content: [{ type: 'text', text: JSON.stringify({ ok: true, id }) }] };
          } catch (e) {
            return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
          }
        }
      );

      server.tool(
        `vec_count_${C}`,
        `Count indexed vectors in '${C}'`,
        {},
        async () => {
          const n = vec.count(C);
          return { content: [{ type: 'text', text: JSON.stringify({ count: n, collection: C }) }] };
        }
      );
    }
  }

  // --- graph 툴 (GraphDriver.attach() + define() 호출 시 자동 등록) [v2] ---

  if (djinn._graph) {
    const graph = djinn._graph;

    // 공통 응답 헬퍼
    const ok  = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
    const err = (message) => ({ content: [{ type: 'text', text: `Error: ${message}` }] });

    // '::' 포함/빈 문자열 검증 — §3.3 "모든 툴 공통" 에러 케이스
    const badKey = (key) => key == null || String(key).trim() === '' || String(key).includes('::');
    const keyError = (key) => (key == null || String(key).trim() === '')
      ? 'key must be non-empty'
      : 'key must not contain "::"';

    for (const ns of graph._namespaces) {
      const NS = ns; // 클로저 캡처

      // [v2] key 또는 node_id 중 정확히 하나로 노드를 주소지정 → node_key로 해석.
      // get 계열은 미해석 시 { ok: true, notFound: true } sentinel(호출부가 ok(null) 처리),
      // del/list 계열은 unknown node_id 에러 텍스트를 낸다 — 두 정책을 strict로 구분.
      const resolveNodeKey = (key, node_id, { strict }) => {
        const hasKey = key !== undefined;
        const hasId  = node_id !== undefined;
        if (hasKey === hasId) return { error: 'pass exactly one of key or node_id' };
        if (hasKey) {
          if (badKey(key)) return { error: keyError(key) };
          return { key };
        }
        const resolved = graph.getByNodeId(NS, node_id);
        if (!resolved || resolved.level !== 'node') {
          return strict ? { error: `unknown node_id ${node_id}` } : { notFound: true };
        }
        return { key: resolved.node_key };
      };

      // [v2] (parent_key,child_key) 또는 node_id 중 정확히 하나로 doc을 주소지정.
      // key 필드가 하나라도(부분 포함) 주어졌는데 node_id도 같이 왔으면 거부 — resolveNodeKey와 대칭.
      const resolveDocAddr = (parent_key, child_key, node_id, { strict }) => {
        const hasAnyKeyField = parent_key !== undefined || child_key !== undefined;
        const hasId          = node_id !== undefined;
        if (hasAnyKeyField === hasId) return { error: 'pass exactly one of key or node_id' };
        if (hasAnyKeyField) {
          if (parent_key === undefined || child_key === undefined) {
            return { error: 'pass exactly one of key or node_id' };
          }
          if (badKey(parent_key)) return { error: keyError(parent_key) };
          if (badKey(child_key)) return { error: keyError(child_key) };
          return { parent_key, child_key };
        }
        const resolved = graph.getByNodeId(NS, node_id);
        if (!resolved || resolved.level !== 'doc') {
          return strict ? { error: `unknown node_id ${node_id}` } : { notFound: true };
        }
        return { parent_key: resolved.parent_key, child_key: resolved.child_key };
      };

      server.tool(
        `graph_catalog_${NS}`,
        `SHOW TABLES — list nodes registered in the '${NS}' graph catalog`,
        {},
        async () => {
          const root = graph.catalog(NS);
          const schems = root?.schems || {};
          return ok({
            node_id: root?.node_id ?? 1,
            schems,
            nodeCount: Object.keys(schems).length,
            modified_at: root?.modified_at ?? null,
          });
        }
      );

      server.tool(
        `graph_node_put_${NS}`,
        `CREATE/ALTER TABLE — upsert a node in '${NS}'. Omitted fields keep their existing value. Returns the assigned node_id.`,
        {
          key:          z.string().describe('Node key'),
          description:  z.string().optional().describe('Node description (SHOW TABLES entry)'),
          child_schema: z.string().optional().describe('Field-name → description map, as JSON string'),
        },
        async ({ key, description, child_schema }) => {
          if (badKey(key)) return err(keyError(key));
          let schema;
          if (child_schema !== undefined) {
            try { schema = JSON.parse(child_schema); } catch { return err('child_schema must be valid JSON'); }
          }
          try {
            const result = graph.putNode(NS, key, { description, child_schema: schema });
            return ok({ ok: true, ...result });
          } catch (e) { return err(e.message); }
        }
      );

      server.tool(
        `graph_node_get_${NS}`,
        `Get a single node from '${NS}' by key or node_id (exactly one). child_schema = DDL.`,
        {
          key:     z.string().optional().describe('Node key'),
          node_id: z.number().int().min(1).optional().describe('Node id (alternative to key)'),
        },
        async ({ key, node_id }) => {
          const addr = resolveNodeKey(key, node_id, { strict: false });
          if (addr.error) return err(addr.error);
          if (addr.notFound) return ok(null);
          return ok(graph.getNode(NS, addr.key));
        }
      );

      server.tool(
        `graph_node_del_${NS}`,
        `DROP TABLE — delete a node from '${NS}' by key or node_id (exactly one). Fails if docs exist unless cascade:true.`,
        {
          key:     z.string().optional().describe('Node key'),
          node_id: z.number().int().min(1).optional().describe('Node id (alternative to key)'),
          cascade: z.boolean().optional().describe('Delete all docs under this node too (default false)'),
        },
        async ({ key, node_id, cascade }) => {
          const addr = resolveNodeKey(key, node_id, { strict: true });
          if (addr.error) return err(addr.error);
          const nodeKey = addr.key;
          const useCascade = cascade ?? false;
          if (!useCascade) {
            const n = graph.countDocs(NS, nodeKey);
            if (n > 0) return err(`node '${nodeKey}' has ${n} docs — pass cascade:true`);
          }
          try {
            const result = graph.delNode(NS, nodeKey, { cascade: useCascade });
            return ok({ ok: true, ...result });
          } catch (e) { return err(e.message); }
        }
      );

      server.tool(
        `graph_doc_put_${NS}`,
        `Upsert a doc (row) under a node in '${NS}'. Parent node must already exist. Returns the assigned node_id.`,
        {
          parent_key: z.string().describe('Parent node key'),
          child_key:  z.string().describe('Doc key'),
          data:       z.string().describe('Doc data as JSON string'),
        },
        async ({ parent_key, child_key, data }) => {
          if (badKey(parent_key)) return err(keyError(parent_key));
          if (badKey(child_key)) return err(keyError(child_key));
          let parsed;
          try { parsed = JSON.parse(data); } catch { return err('data must be valid JSON'); }
          if (!graph.getNode(NS, parent_key)) {
            return err(`unknown node '${parent_key}' — create it with graph_node_put_${NS} first`);
          }
          try {
            const result = graph.putDoc(NS, parent_key, child_key, parsed);
            return ok({ ok: true, ...result });
          } catch (e) { return err(e.message); }
        }
      );

      server.tool(
        `graph_doc_get_${NS}`,
        `point lookup a doc under a node in '${NS}' by (parent_key,child_key) or node_id (exactly one)`,
        {
          parent_key: z.string().optional().describe('Parent node key'),
          child_key:  z.string().optional().describe('Doc key'),
          node_id:    z.number().int().min(1).optional().describe('Doc id (alternative to parent_key+child_key)'),
        },
        async ({ parent_key, child_key, node_id }) => {
          const addr = resolveDocAddr(parent_key, child_key, node_id, { strict: false });
          if (addr.error) return err(addr.error);
          if (addr.notFound) return ok(null);
          return ok(graph.getDoc(NS, addr.parent_key, addr.child_key));
        }
      );

      server.tool(
        `graph_doc_list_${NS}`,
        `List docs under a node in '${NS}' by parent_key, or list child nodes of a node_id (parent_id=1 → all nodes). child_key/node_key ascending. Defaults to keys only (no data).`,
        {
          parent_key: z.string().optional().describe('Parent node key'),
          parent_id:  z.number().int().min(1).optional().describe('Parent node_id (alternative to parent_key; 1 = root → list all nodes)'),
          keys_only:  z.boolean().optional().describe('Omit data field (default true)'),
          limit:      z.number().int().min(1).optional(),
          offset:     z.number().int().min(0).optional(),
        },
        async ({ parent_key, parent_id, keys_only, limit, offset }) => {
          const hasKey = parent_key !== undefined;
          const hasId  = parent_id !== undefined;
          if (hasKey === hasId) return err('pass exactly one of key or node_id');
          const ko = keys_only ?? true;
          if (hasKey) {
            if (badKey(parent_key)) return err(keyError(parent_key));
            return ok(graph.listDocs(NS, parent_key, { keysOnly: ko, limit, offset }));
          }
          const resolved = graph.getByNodeId(NS, parent_id);
          if (!resolved) return err(`unknown node_id ${parent_id}`);
          let results = graph.childrenOf(NS, parent_id, { keysOnly: ko });
          if (offset) results = results.slice(offset);
          if (limit != null) results = results.slice(0, limit);
          return ok(results);
        }
      );

      server.tool(
        `graph_doc_del_${NS}`,
        `Delete a doc under a node in '${NS}' by (parent_key,child_key) or node_id (exactly one). Idempotent.`,
        {
          parent_key: z.string().optional().describe('Parent node key'),
          child_key:  z.string().optional().describe('Doc key'),
          node_id:    z.number().int().min(1).optional().describe('Doc id (alternative to parent_key+child_key)'),
        },
        async ({ parent_key, child_key, node_id }) => {
          const addr = resolveDocAddr(parent_key, child_key, node_id, { strict: true });
          if (addr.error) return err(addr.error);
          graph.delDoc(NS, addr.parent_key, addr.child_key);
          return ok({ ok: true, parent_key: addr.parent_key, child_key: addr.child_key });
        }
      );

      server.tool(
        `graph_doc_count_${NS}`,
        `Count docs in '${NS}'. Pass parent_key to scope to one node, omit for total.`,
        { parent_key: z.string().optional().describe('Parent node key (omit for total count)') },
        async ({ parent_key }) => {
          if (parent_key !== undefined && badKey(parent_key)) return err(keyError(parent_key));
          const n = graph.countDocs(NS, parent_key);
          return ok({ count: n, parent_key: parent_key ?? null });
        }
      );
    }
  }

  // --- embed 툴 (EmbedDriver.attach() + config/api_key 설정 완료 시에만 등록) ---
  // config(_sys 네임스페이스)가 없으면 djinn._embed.isConfigured()===false → 이 블록 자체가
  // 스킵되어 embed_* 툴이 등록조차 되지 않는다(잠금). embedGate는 위 vec 블록과 공유.

  if (djinn._embed && embedGate) {
    const embed = djinn._embed;

    server.tool(
      'embed_text',
      'Embed text into a vector using the configured provider (nvidia/gemini). Single entry point — returns dims + raw vector.',
      {
        text: z.string().describe('Text to embed'),
        id:   z.string().optional().describe('Model entry id (omit for default entry)'),
      },
      async ({ text, id }) => {
        try {
          const v = await embed.embed(text, { id });
          return { content: [{ type: 'text', text: JSON.stringify({ dim: v.length, embedding: v }) }] };
        } catch (e) {
          return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
        }
      }
    );

    if (djinn._vec) {
      for (const col of djinn._vec._defined) {
        const C = col; // 클로저 캡처

        server.tool(
          `embed_upsert_${C}`,
          `Embed text and store the resulting vector for a document in '${C}' — one call from text to stored embedding.`,
          {
            id:   z.string().describe('Document id (must exist in collection)'),
            text: z.string().describe('Text to embed and store'),
          },
          async ({ id, text }) => {
            try {
              const dim = await embed.embedAndUpsert(C, id, text);
              return { content: [{ type: 'text', text: JSON.stringify({ ok: true, id, dim }) }] };
            } catch (e) {
              return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
            }
          }
        );

        server.tool(
          `embed_search_${C}`,
          `Embed query text and k-nearest neighbor search in '${C}'. Returns [{id, distance}] sorted by distance ascending.`,
          {
            text: z.string().describe('Query text to embed and search with'),
            k:    z.number().int().min(1).max(100).optional().describe('Number of results (default 10)'),
          },
          async ({ text, k = 10 }) => {
            try {
              const results = await embed.embedAndSearch(C, text, k);
              return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
            } catch (e) {
              return { content: [{ type: 'text', text: `Error: ${e.message}` }] };
            }
          }
        );
      }
    }
  }

  return server;
}

// stdio 트랜스포트로 바로 실행하는 헬퍼
async function serveMcp(djinn, options = {}) {
  const server    = createMcpServer(djinn, options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}

module.exports = { createMcpServer, serveMcp };
