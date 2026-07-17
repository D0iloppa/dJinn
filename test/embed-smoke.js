'use strict';

const assert = require('node:assert');
const { DJinn, GraphDriver, VecDriver, EmbedDriver, createMcpServer } = require('../src/index');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'embed-smoke.db');
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

async function main() {
  const db = new DJinn(DB_PATH, { cacheSize: 64 });

  // ── [attach] ─────────────────────────────────────────────────────

  const graph = GraphDriver.attach(db);
  const vec = VecDriver.attach(db);
  vec.define('items', 4);
  const embed = EmbedDriver.attach(db);
  assert(db._embed === embed, 'attach 실패');

  // ── [config 미설정 시 잠금] ──────────────────────────────────────

  // 1. defineConfig/setApiKey 전 — isConfigured() === false (throw 아님)
  assert.strictEqual(embed.isConfigured(), false, 'config 미설정 시 isConfigured() false 실패');

  // 2. embed() 자체도 잠김 — 명확한 에러 메시지
  let threwLocked = false;
  try {
    await embed.embed('hello');
  } catch (e) {
    threwLocked = true;
    assert(/locked/i.test(e.message), 'embed() 잠금 에러 메시지 실패');
  }
  assert(threwLocked, 'config 미설정 시 embed() throw 실패');

  // 3. createMcpServer — embed_text / vec_upsert_items 둘 다 미등록 (embedGate에 의해 vec도 잠김)
  const server1 = createMcpServer(db, { name: 'embed-smoke', version: '0.0.0' });
  assert.strictEqual(server1._registeredTools['embed_text'], undefined, 'config 미설정 시 embed_text 등록됨 실패');
  assert.strictEqual(server1._registeredTools['embed_upsert_items'], undefined, 'config 미설정 시 embed_upsert_items 등록됨 실패');
  assert.strictEqual(server1._registeredTools['embed_search_items'], undefined, 'config 미설정 시 embed_search_items 등록됨 실패');
  assert.strictEqual(server1._registeredTools['vec_upsert_items'], undefined, 'config 미설정 시 vec_upsert_items 등록됨(embedGate 실패) 실패');

  // ── [config 설정] ────────────────────────────────────────────────

  // 4. defineConfig — 멱등(2회 호출 무해)
  embed.defineConfig();
  embed.defineConfig();
  assert(graph.getNode('_sys', 'config') !== null, 'defineConfig config 노드 생성 실패');

  // 5. setModels — round-trip
  embed.setModels([
    { id: 'gemini', provider: 'gemini', model: 'gemini-embedding-001' },
    { id: 'bogus',  provider: 'unknown-provider', model: 'x' },
  ]);
  const models = embed.getModels();
  assert(Array.isArray(models) && models.length === 2, 'getModels round-trip 실패');
  assert(models[0].id === 'gemini', 'getModels 순서/내용 실패');

  // 6. getEntry — id 지정/생략(기본=첫 엔트리)/미존재
  assert.strictEqual(embed.getEntry().id, 'gemini', 'getEntry() 기본(첫 엔트리) 실패');
  assert.strictEqual(embed.getEntry('bogus').id, 'bogus', 'getEntry(id) 실패');
  assert.strictEqual(embed.getEntry('nope'), null, 'getEntry(미존재) null 실패');

  // 7. api_key 없음 — 아직 isConfigured() === false
  assert.strictEqual(embed.isConfigured(), false, 'api_key 없이 isConfigured() true 됨 실패');

  // 8. setApiKey — round-trip
  embed.setApiKey('gemini', 'TEST_KEY');
  assert.strictEqual(embed.getApiKey('gemini'), 'TEST_KEY', 'getApiKey round-trip 실패');
  assert.strictEqual(embed.getApiKey('bogus'), null, 'getApiKey(키 없음) null 실패');

  // 9. 이제 isConfigured() === true (기본 엔트리 gemini에 키가 있음)
  assert.strictEqual(embed.isConfigured(), true, 'config+api_key 설정 후 isConfigured() 실패');

  // ── [등록 잠금 해제] ─────────────────────────────────────────────

  // 10. createMcpServer 재호출 — embed_*, vec_* 툴 전부 등록됨
  const server2 = createMcpServer(db, { name: 'embed-smoke', version: '0.0.0' });
  for (const toolName of [
    'embed_text', 'embed_upsert_items', 'embed_search_items',
    'vec_upsert_items', 'vec_search_items', 'vec_delete_items', 'vec_count_items',
  ]) {
    assert(server2._registeredTools[toolName] !== undefined, `config 설정 후 MCP 툴 미등록: ${toolName}`);
  }

  // ── [provider 분기 — fetch 스텁, 실네트워크 호출 없음] ─────────────

  const origFetch = global.fetch;

  // 11. gemini 분기 — 정상 응답 → 벡터 반환
  global.fetch = async (url) => {
    assert(String(url).includes('generativelanguage.googleapis.com'), 'gemini 엔드포인트 URL 실패');
    assert(String(url).includes('key=TEST_KEY'), 'gemini API 키 쿼리파라미터 실패');
    return { ok: true, json: async () => ({ embedding: { values: [0.1, 0.2, 0.3, 0.4] } }) };
  };
  const v = await embed.embed('hello world');
  assert(Array.isArray(v) && v.length === 4, 'embed() gemini 분기 벡터 반환 실패');

  // 12. embed_text 툴 핸들러 — dim + embedding JSON 반환
  const textTool = server2._registeredTools['embed_text'];
  const textRes = await textTool.handler({ text: 'hello world' });
  const textParsed = JSON.parse(textRes.content[0].text);
  assert.strictEqual(textParsed.dim, 4, 'embed_text 툴 dim 실패');
  assert(Array.isArray(textParsed.embedding), 'embed_text 툴 embedding 배열 실패');

  // 13. embed_upsert_items → embed_search_items round-trip (VecDriver 결합)
  const upsertTool = server2._registeredTools['embed_upsert_items'];
  const upsertRes = await upsertTool.handler({ id: 'doc1', text: 'hello' });
  const upsertParsed = JSON.parse(upsertRes.content[0].text);
  assert.strictEqual(upsertParsed.ok, true, 'embed_upsert_items 실패');
  assert.strictEqual(upsertParsed.dim, 4, 'embed_upsert_items dim 실패');
  assert.strictEqual(vec.count('items'), 1, 'embedAndUpsert → VecDriver.upsert 반영 실패');

  const searchTool = server2._registeredTools['embed_search_items'];
  const searchRes = await searchTool.handler({ text: 'hello', k: 5 });
  const searchParsed = JSON.parse(searchRes.content[0].text);
  assert(Array.isArray(searchParsed) && searchParsed.some((r) => r.id === 'doc1'), 'embed_search_items round-trip 실패');

  // 14. 비2xx 응답 → 'API <status>: ...' 에러
  global.fetch = async () => ({ ok: false, status: 500, text: async () => 'server error detail' });
  let threwApiError = false;
  try {
    await embed.embed('x');
  } catch (e) {
    threwApiError = true;
    assert(e.message.startsWith('API 500:'), 'API 에러 메시지 형식 실패');
  }
  assert(threwApiError, '비2xx 응답 시 throw 실패');

  // 15. 알 수 없는 provider → 명확한 에러 (fetch 호출 전에 throw)
  // bogus 엔트리에 키를 채워둔다 — 그래야 새로 추가한 per-entry 키 가드(16번)가 아니라
  // '알 수 없는 provider' 분기 자체를 검증하게 된다(가드 우선순위: 키 누락 > provider 미상).
  embed.setApiKey('bogus', 'BOGUS_KEY');
  global.fetch = async () => { throw new Error('fetch should not be called for unknown provider'); };
  let threwUnknownProvider = false;
  try {
    await embed.embed('x', { id: 'bogus' });
  } catch (e) {
    threwUnknownProvider = true;
    assert(/unknown provider/i.test(e.message), '알 수 없는 provider 에러 메시지 실패');
  }
  assert(threwUnknownProvider, '알 수 없는 provider 시 throw 실패');

  // 16. [회귀 — CRITICAL] per-entry 키 검증. 기본 엔트리(gemini)에 키가 있어 isConfigured()===true여도,
  // id로 지정한 다른 엔트리(nokey)에 키가 없으면 embed()가 그 엔트리 기준으로 다시 잠겨야 한다 —
  // 등록 시점 게이트(isConfigured, 기본 엔트리만 봄)만 믿고 호출 시점에 다른 엔트리로 새는 것 방지.
  // 'Bearer null'/'?key=null'로 실제 요청이 나가면 안 되므로 fetch 호출 자체가 없어야 한다.
  embed.setModels([
    { id: 'gemini', provider: 'gemini', model: 'gemini-embedding-001' },
    { id: 'bogus',  provider: 'unknown-provider', model: 'x' },
    { id: 'nokey',  provider: 'gemini', model: 'gemini-embedding-001' }, // 의도적으로 키 미설정
  ]);
  assert.strictEqual(embed.getApiKey('nokey'), null, 'nokey 엔트리는 키가 없어야 함(사전조건)');
  assert.strictEqual(embed.isConfigured(), true, '기본 엔트리(gemini)는 키 보유 — isConfigured() true 유지(사전조건)');

  let fetchCallCount = 0;
  global.fetch = async () => {
    fetchCallCount++;
    return { ok: true, json: async () => ({ embedding: { values: [0, 0, 0, 0] } }) };
  };

  let threwPerEntryLock = false;
  try {
    await embed.embed('x', { id: 'nokey' });
  } catch (e) {
    threwPerEntryLock = true;
    assert(/locked/i.test(e.message), 'per-entry 키 없음 잠금 에러 메시지 실패');
  }
  assert(threwPerEntryLock, 'per-entry 키 없음인데 embed() throw 안 함(CRITICAL 회귀)');
  assert.strictEqual(fetchCallCount, 0, 'per-entry 키 없음인데 실제 fetch가 호출됨 — 자격증명 유출 회귀(CRITICAL)');

  // embed_text MCP 핸들러 경유로도 동일하게 잠겨야 함(등록은 기본 엔트리 기준으로 열려 있어도)
  const textToolAgain = server2._registeredTools['embed_text'];
  const lockedRes = await textToolAgain.handler({ text: 'x', id: 'nokey' });
  assert(lockedRes.content[0].text.startsWith('Error:'), 'embed_text 툴 경유 per-entry 잠금 실패');
  assert(/locked/i.test(lockedRes.content[0].text), 'embed_text 툴 경유 잠금 에러 메시지 실패');
  assert.strictEqual(fetchCallCount, 0, 'embed_text 툴 경유 시에도 fetch 호출 없어야 함(CRITICAL 회귀)');

  // 17. [회귀 — MEDIUM] gemini 키 URL 인코딩 — '&'/'%'/'#'/'+' 등이 쿼리스트링에서 깨지지 않아야 함
  const specialKey = 'a&b=c#d+e%f';
  embed.setApiKey('gemini', specialKey);
  let capturedUrl = null;
  global.fetch = async (url) => {
    capturedUrl = String(url);
    return { ok: true, json: async () => ({ embedding: { values: [0.1, 0.2, 0.3, 0.4] } }) };
  };
  await embed.embed('encode test');
  assert(capturedUrl.includes('key=' + encodeURIComponent(specialKey)), 'gemini 키 URL 인코딩 실패(MEDIUM 회귀)');
  assert(!capturedUrl.includes('key=' + specialKey), 'gemini 키가 인코딩 없이 그대로 삽입됨(MEDIUM 회귀)');

  global.fetch = origFetch;

  db.close();
  fs.unlinkSync(DB_PATH);

  console.log('✓ EmbedDriver smoke test passed');
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
