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
