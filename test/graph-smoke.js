'use strict';

const assert = require('node:assert');
const { DJinn, GraphDriver, createMcpServer } = require('../src/index');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'graph-smoke.db');
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const db = new DJinn(DB_PATH, { cacheSize: 64 });

  const SEED_NODES = [
    { key: 'tone',  description: '말투 기본 톤',   child_schema: { base: '기본 톤' } },
    { key: 'emoji', description: '이모지 사용',     child_schema: { graphic_emoji: '이모지 여부' } },
    { key: 'register', description: '격식 수준',    child_schema: { level: '격식 레벨' } },
  ];

  // ── [attach/define] ────────────────────────────────────────────

  // 1. attach
  const graph = GraphDriver.attach(db);
  assert(db._graph === graph, 'attach 실패');

  // 2. define + 골격 시드 — 루트(node_id 1, parent_id null) + 'seq' 메타 row, schems == 시드,
  //    시드 노드 node_id가 2..N 연속·중복 없음
  graph.define('g', { nodes: SEED_NODES });
  const catalog1 = graph.catalog('g');
  assert(catalog1 !== null, '루트 row 생성 실패');
  assert(catalog1.node_id === 1 && catalog1.parent_id === null, '루트 node_id/parent_id 실패');
  const seedKeys = SEED_NODES.map(n => n.key).sort();
  assert(
    JSON.stringify(Object.keys(catalog1.schems).sort()) === JSON.stringify(seedKeys),
    'schems == 시드 키 집합 실패'
  );
  const seqAfterDefine = db.get('g_root', 'seq');
  assert(seqAfterDefine !== null, "'seq' 메타 row 생성 실패");
  const seedNodeIds = SEED_NODES.map(n => graph.getNode('g', n.key).node_id).sort((a, b) => a - b);
  assert(
    JSON.stringify(seedNodeIds) === JSON.stringify([2, 3, 4]),
    '시드 노드 node_id 연속(2..N)·중복 없음 실패'
  );
  assert(seqAfterDefine.seq === 4, "define 직후 'seq' 값 실패");

  // 3. define() 재호출 멱등 — 노드/루트 무변경 + node_id 불변 + seq 미증가
  graph.putNode('g', 'tone', { description: 'CHANGED_BY_USER' });
  const toneIdBefore = graph.getNode('g', 'tone').node_id;
  const seqBeforeRedefine = db.get('g_root', 'seq').seq;
  graph.define('g', { nodes: SEED_NODES });
  const catalog2 = graph.catalog('g');
  assert(catalog2.schems.tone === 'CHANGED_BY_USER', 'define 재호출 시 기존 노드 description 보존 실패');
  assert(
    JSON.stringify(Object.keys(catalog2.schems).sort()) === JSON.stringify(seedKeys),
    'define 재호출 시 노드 집합 변경됨 실패'
  );
  assert(graph.getNode('g', 'tone').node_id === toneIdBefore, 'define 재호출 시 node_id 불변 실패');
  assert(db.get('g_root', 'seq').seq === seqBeforeRedefine, 'define 재호출 시 seq 증가함 실패');

  // 4. 인덱스 확인 — 복합(parent_key,child_key) + node_id/parent_id + legacy 문자열 indexes 무변경
  const idxRow = db.db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name = ?"
  ).get('idx_g_docs__parent_key__child_key');
  assert(idxRow != null, '복합 표현식 인덱스 미생성');

  for (const idxName of ['idx_g_nodes__node_id', 'idx_g_nodes__parent_id', 'idx_g_docs__node_id', 'idx_g_docs__parent_id']) {
    const row = db.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name = ?").get(idxName);
    assert(row != null, `[v2] 인덱스 미생성: ${idxName}`);
  }

  db.define('legacy_nodes', { indexes: ['grp'] });
  db.put('legacy_nodes', 'l1', { title: 'legacy', grp: 'root' });
  const legacyFound = db.find('legacy_nodes', { grp: 'root' });
  assert(legacyFound.length === 1 && legacyFound[0].title === 'legacy', 'legacy 문자열 indexes 동작 회귀');
  const legacyIdxRow = db.db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name = ?"
  ).get('idx_legacy_nodes__grp');
  assert(legacyIdxRow != null, 'legacy 단일 인덱스 미생성');

  // ── [노드 = 테이블] ──────────────────────────────────────────────

  // 5. putNode 신규 → node_id 발급·반환, parent_id === 1, 노드+schems 동시 반영,
  //    transaction 내 강제 throw 시 노드/schems/seq 셋 다 롤백(seq 되감김 확인)
  const seqBeforeRollback = db.get('g_root', 'seq').seq;
  let threw5 = false;
  try {
    db.transaction(() => {
      graph.putNode('g', 'rollbackTest', { description: 'temp', child_schema: {} });
      throw new Error('boom');
    });
  } catch {
    threw5 = true;
  }
  assert(threw5, '강제 throw 전파 실패');
  assert(graph.getNode('g', 'rollbackTest') === null, 'putNode 롤백 시 노드 row 롤백 실패');
  assert(!('rollbackTest' in graph.catalog('g').schems), 'putNode 롤백 시 루트 schems 롤백 실패');
  assert(db.get('g_root', 'seq').seq === seqBeforeRollback, 'putNode 롤백 시 seq 되감김 실패');

  const putStyle = graph.putNode('g', 'style', { description: '문체', child_schema: { formality: '격식' } });
  assert(typeof putStyle.node_id === 'number', 'putNode 반환에 node_id 없음');
  assert(putStyle.node_key === 'style', 'putNode 반환 node_key 실패');
  const styleNode = graph.getNode('g', 'style');
  assert(styleNode !== null && styleNode.node_id === putStyle.node_id, 'putNode 신규 노드 row 실패');
  assert(styleNode.parent_id === 1, 'putNode 신규 노드 parent_id === 1 실패');
  assert(graph.catalog('g').schems.style === '문체', 'putNode 신규 루트 schems 동기화 실패');

  // 6. putNode 기존(child_schema만) → description·created_at·node_id 보존, modified_at 갱신
  const styleBefore = graph.getNode('g', 'style');
  await sleep(2);
  graph.putNode('g', 'style', { child_schema: { formality: '격식(수정)' } });
  const styleAfter = graph.getNode('g', 'style');
  assert(graph.catalog('g').schems.style === '문체', 'putNode description 유지 실패');
  assert(styleAfter.created_at === styleBefore.created_at, 'putNode created_at 보존 실패');
  assert(styleAfter.node_id === styleBefore.node_id, 'putNode node_id 보존 실패');
  assert(styleAfter.modified_at !== styleBefore.modified_at, 'putNode modified_at 갱신 실패');
  assert(styleAfter.child_schema.formality === '격식(수정)', 'putNode child_schema 갱신 실패');

  // 7. putNode('a::b') → throw
  let threw7 = false;
  try { graph.putNode('g', 'a::b', {}); } catch { threw7 = true; }
  assert(threw7, "putNode key '::' 검증 실패");

  // 8. delNode(손자 있음, cascade 없음) → throw / cascade:true → 손자 전멸 + schems 제거,
  //    이후 putNode 재생성 시 새(더 큰) node_id — 재사용 없음
  const styleIdBeforeDelete = graph.getNode('g', 'style').node_id;
  graph.putDoc('g', 'style', 'a', { v: 1 });
  graph.putDoc('g', 'style', 'b', { v: 2 });
  let threw8 = false;
  try { graph.delNode('g', 'style'); } catch { threw8 = true; }
  assert(threw8, 'delNode cascade 없이 손자 존재 시 throw 실패');
  assert(graph.getNode('g', 'style') !== null, 'delNode 실패 시 노드가 남아있어야 함');

  const delResult = graph.delNode('g', 'style', { cascade: true });
  assert(delResult.deletedDocs === 2, 'delNode cascade deletedDocs 카운트 실패');
  assert(graph.getNode('g', 'style') === null, 'delNode cascade 노드 삭제 실패');
  assert(graph.countDocs('g', 'style') === 0, 'delNode cascade 손자 전멸 실패');
  assert(!('style' in graph.catalog('g').schems), 'delNode cascade schems 제거 실패');

  const recreated = graph.putNode('g', 'style', { description: '문체(재생성)' });
  assert(recreated.node_id > styleIdBeforeDelete, 'node_id 재사용 없음(재생성 시 더 큰 값) 실패');

  // ── [손자 = 실데이터] ────────────────────────────────────────────

  // 9. putDoc → 테이블 PK 'parent::child', node_id 발급·반환, parent_id === 부모 node_id, round-trip
  const toneNode = graph.getNode('g', 'tone');
  const putDoc9 = graph.putDoc('g', 'tone', 'tone', { base: '반말' });
  assert(typeof putDoc9.node_id === 'number', 'putDoc 반환에 node_id 없음');
  const doc9 = db.get('g_docs', 'tone::tone');
  assert(doc9 !== null, 'putDoc 테이블 PK 컨벤션 실패');
  assert(doc9.parent_key === 'tone' && doc9.child_key === 'tone', 'putDoc parent/child_key 저장 실패');
  assert(doc9.parent_id === toneNode.node_id, 'putDoc parent_id === 부모 node_id 실패(불변식 3)');
  const got9 = graph.getDoc('g', 'tone', 'tone');
  assert(got9 !== null && got9.data.base === '반말', 'getDoc round-trip 실패');

  // 10. putDoc(미존재 노드) → throw / autoCreateNode:true → 부모 자동 생성(node_id 발급) + schems 반영
  let threw10 = false;
  try { graph.putDoc('g', 'ghostNode', 'x', { v: 1 }); } catch { threw10 = true; }
  assert(threw10, 'putDoc 미존재 부모 노드 시 throw 실패');
  assert(graph.getNode('g', 'ghostNode') === null, 'putDoc 실패 시 노드가 생성되면 안 됨');

  const putDoc10 = graph.putDoc('g', 'ghostNode', 'x', { v: 1 }, { autoCreateNode: true });
  const ghostNode = graph.getNode('g', 'ghostNode');
  assert(ghostNode !== null, 'putDoc autoCreateNode 노드 자동 생성 실패');
  assert(JSON.stringify(ghostNode.child_schema) === '{}', 'putDoc autoCreateNode 빈 스키마 실패');
  assert(graph.catalog('g').schems.ghostNode === 'ghostNode', 'putDoc autoCreateNode schems 반영 실패');
  assert(putDoc10.node_id !== undefined && graph.getDoc('g', 'ghostNode', 'x').node_id === putDoc10.node_id, 'putDoc autoCreateNode doc node_id 실패');
  assert(graph.getDoc('g', 'ghostNode', 'x').parent_id === ghostNode.node_id, 'putDoc autoCreateNode parent_id 링크 실패');

  // 11. listDocs — child_key 오름차순, keysOnly(node_id 포함, data 미포함), limit/offset
  graph.putDoc('g', 'emoji', 'zeta', { n: 1 });
  graph.putDoc('g', 'emoji', 'alpha', { n: 2 });
  graph.putDoc('g', 'emoji', 'mid', { n: 3 });
  const listed = graph.listDocs('g', 'emoji');
  assert(
    JSON.stringify(listed.map(d => d.child_key)) === JSON.stringify(['alpha', 'mid', 'zeta']),
    'listDocs child_key 오름차순 실패'
  );
  assert(listed[0].data !== undefined, 'listDocs 기본(keysOnly:false) data 포함 실패');

  const keysOnlyList = graph.listDocs('g', 'emoji', { keysOnly: true });
  assert(keysOnlyList.every(d => d.data === undefined), 'listDocs keysOnly에 data 미포함 실패');
  assert(keysOnlyList.every(d => typeof d.node_id === 'number'), 'listDocs keysOnly에 node_id 미포함 실패');
  assert(keysOnlyList[0].child_key === 'alpha', 'listDocs keysOnly 정렬 실패');

  const paged = graph.listDocs('g', 'emoji', { limit: 1, offset: 1 });
  assert(paged.length === 1 && paged[0].child_key === 'mid', 'listDocs limit/offset 실패');

  // 12. countDocs, delDoc(멱등)
  assert(graph.countDocs('g', 'emoji') === 3, 'countDocs 실패');
  graph.delDoc('g', 'emoji', 'alpha');
  assert(graph.countDocs('g', 'emoji') === 2, 'delDoc 실패');
  graph.delDoc('g', 'emoji', 'alpha'); // 2회 호출 — 무해
  assert(graph.countDocs('g', 'emoji') === 2, 'delDoc 멱등성 실패');

  // ── [id 링크] [v2] ───────────────────────────────────────────────

  // 13. node_id 유일성 — 루트/노드/손자 전 row의 node_id 수집 → 중복 0, 'seq'.seq >= max
  const allNodeIds = [];
  allNodeIds.push(graph.catalog('g').node_id);
  for (const key of Object.keys(graph.catalog('g').schems)) {
    allNodeIds.push(graph.getNode('g', key).node_id);
  }
  for (const key of Object.keys(graph.catalog('g').schems)) {
    for (const doc of graph.listDocs('g', key)) {
      allNodeIds.push(doc.node_id);
    }
  }
  const uniqueNodeIds = new Set(allNodeIds);
  assert(uniqueNodeIds.size === allNodeIds.length, 'node_id 유일성 실패 — 중복 발견');
  assert(db.get('g_root', 'seq').seq >= Math.max(...allNodeIds), "'seq'.seq >= max(node_id) 실패");

  // 14. getByNodeId — root/node/doc/미존재
  const rootResolved = graph.getByNodeId('g', 1);
  assert(rootResolved !== null && rootResolved.level === 'root', 'getByNodeId(1) level root 실패');

  const toneNodeId = graph.getNode('g', 'tone').node_id;
  const nodeResolved = graph.getByNodeId('g', toneNodeId);
  assert(nodeResolved !== null && nodeResolved.level === 'node' && nodeResolved.node_key === 'tone', 'getByNodeId(node) 실패');

  const toneToneDocId = graph.getDoc('g', 'tone', 'tone').node_id;
  const docResolved = graph.getByNodeId('g', toneToneDocId);
  assert(docResolved !== null && docResolved.level === 'doc' && docResolved.child_key === 'tone', 'getByNodeId(doc) 실패');

  const missingResolved = graph.getByNodeId('g', 999999);
  assert(missingResolved === null, 'getByNodeId(미존재) null 실패');

  // 15. childrenOf — 루트→노드 전부 / 노드→그 손자 전부(parent_id 일치) / 손자→[]
  const rootChildren = graph.childrenOf('g', 1);
  assert(
    rootChildren.every(n => n.parent_id === 1),
    'childrenOf(1) parent_id 일치 실패'
  );
  assert(
    rootChildren.some(n => n.node_key === 'tone') && rootChildren.length === Object.keys(graph.catalog('g').schems).length,
    'childrenOf(1) 자식 노드 전부 실패'
  );

  const emojiNodeId = graph.getNode('g', 'emoji').node_id;
  const emojiChildren = graph.childrenOf('g', emojiNodeId);
  assert(emojiChildren.length === graph.countDocs('g', 'emoji'), 'childrenOf(노드) 손자 전부 실패');
  assert(emojiChildren.every(d => d.parent_id === emojiNodeId), 'childrenOf(노드) parent_id 일치 실패');

  const leafChildren = graph.childrenOf('g', toneToneDocId);
  assert(Array.isArray(leafChildren) && leafChildren.length === 0, 'childrenOf(손자) 빈 배열 실패');

  // 16. 시퀀스 transaction 안전성 — putDoc N회 연속 → node_id 정확히 N개 증가(결번 없음),
  //     중간 실패 1회 섞여도 성공분만 반영 + 유일성 유지
  const seqBeforeBatch = db.get('g_root', 'seq').seq;
  const batchIds = [];
  for (let i = 0; i < 5; i++) {
    const r = graph.putDoc('g', 'register', `k${i}`, { i });
    batchIds.push(r.node_id);
  }
  assert(batchIds.length === 5 && new Set(batchIds).size === 5, '연속 putDoc node_id 유일성 실패');
  assert(db.get('g_root', 'seq').seq === seqBeforeBatch + 5, '연속 putDoc 시퀀스 증가분 불일치(결번 의심)');

  const seqBeforeFailedBatch = db.get('g_root', 'seq').seq;
  let threwBatch = false;
  try {
    db.transaction(() => {
      graph.putDoc('g', 'register', 'willRollback', { i: 'x' });
      throw new Error('mid-batch failure');
    });
  } catch { threwBatch = true; }
  assert(threwBatch, '중간 실패 전파 실패');
  assert(graph.getDoc('g', 'register', 'willRollback') === null, '중간 실패 시 doc 롤백 실패');
  assert(db.get('g_root', 'seq').seq === seqBeforeFailedBatch, '중간 실패 시 seq 롤백 실패');
  const r6 = graph.putDoc('g', 'register', 'k5', { i: 5 });
  assert(r6.node_id === seqBeforeFailedBatch + 1, '실패 후 재발급 시 유일성 유지 실패');

  // ── [core 통합] ──────────────────────────────────────────────────

  // 17. getDoc 2회 → heatmap에서 g_docs 컬렉션 hit 기록
  graph.getDoc('g', 'emoji', 'mid');
  graph.getDoc('g', 'emoji', 'mid');
  const hm = db.heatmap();
  const gDocsRow = hm.byCollection.find(r => r.collection === 'g_docs');
  assert(gDocsRow !== undefined && gDocsRow.hits > 0, 'heatmap g_docs hit 기록 실패');

  // 18. putDoc 후 listDocs → 갱신 반영 (invalidatePrefix 검증)
  const beforeInvalidate = graph.listDocs('g', 'emoji', { keysOnly: true });
  graph.putDoc('g', 'emoji', 'fresh', { n: 99 });
  const afterInvalidate = graph.listDocs('g', 'emoji', { keysOnly: true });
  assert(afterInvalidate.length === beforeInvalidate.length + 1, 'putDoc 후 listDocs invalidatePrefix 반영 실패');

  // ── [MCP] ──────────────────────────────────────────────────────

  // 19. createMcpServer 후 graph_*_g 9개 툴 등록 확인
  const server = createMcpServer(db, { name: 'graph-smoke', version: '0.0.0' });
  const expectedTools = [
    'graph_catalog_g',
    'graph_node_put_g',
    'graph_node_get_g',
    'graph_node_del_g',
    'graph_doc_put_g',
    'graph_doc_get_g',
    'graph_doc_list_g',
    'graph_doc_del_g',
    'graph_doc_count_g',
  ];
  for (const toolName of expectedTools) {
    assert(server._registeredTools[toolName] !== undefined, `MCP 툴 미등록: ${toolName}`);
  }

  // 20. graph_doc_put_g에 잘못된 JSON data → 'Error: data must be valid JSON'
  const putTool = server._registeredTools['graph_doc_put_g'];
  const badResult = await putTool.handler({ parent_key: 'tone', child_key: 'tone', data: '{not-json' });
  assert(
    badResult.content[0].text === 'Error: data must be valid JSON',
    'graph_doc_put_g 잘못된 JSON 에러 메시지 실패'
  );

  // 21. graph_node_get_g — key와 node_id 동시 지정/양쪽 생략 → 에러 / node_id 단독 → key와 동일 결과
  const nodeGetTool = server._registeredTools['graph_node_get_g'];
  const bothResult = await nodeGetTool.handler({ key: 'tone', node_id: toneNodeId });
  assert(
    bothResult.content[0].text === 'Error: pass exactly one of key or node_id',
    'graph_node_get_g 둘 다 지정 시 에러 실패'
  );
  const neitherResult = await nodeGetTool.handler({});
  assert(
    neitherResult.content[0].text === 'Error: pass exactly one of key or node_id',
    'graph_node_get_g 둘 다 생략 시 에러 실패'
  );
  const byKeyResult = await nodeGetTool.handler({ key: 'tone' });
  const byIdResult = await nodeGetTool.handler({ node_id: toneNodeId });
  assert(
    byKeyResult.content[0].text === byIdResult.content[0].text,
    'graph_node_get_g node_id 단독 지정 결과가 key 지정과 다름'
  );

  db.close();
  fs.unlinkSync(DB_PATH);

  console.log('✓ GraphDriver smoke test passed (v2)');
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
