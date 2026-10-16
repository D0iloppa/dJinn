'use strict';

const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DJinn, GraphDriver, SnapshotDriver } = require('../src/index');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'djinn-snap-'));
const SNAP = path.join(tmp, 'snap');

function open(name) {
  const db = new DJinn(path.join(tmp, name));
  return { db, graph: GraphDriver.attach(db), snap: SnapshotDriver.attach(db) };
}

const files = (dir) =>
  fs.readdirSync(dir, { recursive: true }).filter((f) => fs.statSync(path.join(dir, f)).isFile()).sort();

// ── 원본 DB ──────────────────────────────────────────────────────
const a = open('a.db');
a.graph.define('wiki', { nodes: [{ key: 'page', description: '페이지' }] });
a.graph.putDoc('wiki', 'page', 'pg_1', { title: '온보딩', body_md: '# 온보딩\n\n본문' });
a.graph.putDoc('wiki', 'page', 'pg_2', { title: 'Setup', body_md: '## 설치' });
a.db.define('tickets', { indexes: ['status'] });
a.db.put('tickets', 'T-1', { title: '대소문자 id', status: 'open' });   // 대문자 → 해시 접미사
a.db.put('tickets', 't-1', { title: '소문자 id', status: 'done' });     // 대소문자만 다른 id
a.db.put('tickets', 'a/b::c@d', { title: '특수문자 id', status: 'open' });
a.db.define('_secret', {});
a.db.put('_secret', 'k', { apiKey: 'xxx' });

const textFields = { wiki_docs: ['data.body_md'] };

// 1. export — '_' 컬렉션 제외, 본문은 .md로 분리
let s = a.snap.exportTo(SNAP, { textFields });
assert.ok(s.written > 0);
const manifest = JSON.parse(fs.readFileSync(path.join(SNAP, 'manifest.json'), 'utf8'));
assert.strictEqual(manifest.format, 'djinn-snapshot/1');
assert.ok(!manifest.collections._secret, "'_' 컬렉션은 기본 제외");
assert.deepStrictEqual(manifest.collections.tickets.indexes, ['status']);
const ticketFiles = files(path.join(SNAP, 'tickets'));
assert.strictEqual(ticketFiles.length, 3, '대소문자만 다른 id도 별도 파일');
assert.ok(ticketFiles.every((f) => !/[/\\]/.test(f)), '특수문자 id도 하위 폴더를 만들지 않음');
const mdFiles = files(path.join(SNAP, 'wiki_docs')).filter((f) => f.endsWith('.md'));
assert.strictEqual(mdFiles.length, 2);
assert.strictEqual(fs.readFileSync(path.join(SNAP, 'wiki_docs', mdFiles.find((f) => f.includes('pg_1'))), 'utf8'), '# 온보딩\n\n본문');

// 2. 재export — 변경 없으면 아무것도 안 씀
s = a.snap.exportTo(SNAP, { textFields });
assert.strictEqual(s.written, 0, '변경 없으면 0');
assert.strictEqual(s.deleted, 0);

// 3. 한 row만 수정 → 그 row 파일만 다시 씀 (modified_at 포함 json + md)
a.graph.putDoc('wiki', 'page', 'pg_1', { title: '온보딩', body_md: '# 온보딩\n\n수정' });
s = a.snap.exportTo(SNAP, { textFields });
assert.strictEqual(s.written, 2, `수정 row의 json+md만 (실제 ${s.written})`);

// 4. 삭제 → 파일도 삭제
a.db.del('tickets', 'a/b::c@d');
s = a.snap.exportTo(SNAP, { textFields });
assert.strictEqual(s.deleted, 1);
assert.strictEqual(files(path.join(SNAP, 'tickets')).length, 2);

// 5. 빈 DB로 import → 원본과 동일
const b = open('b.db');
s = b.snap.importFrom(SNAP);
assert.strictEqual(s.deleted, 0);
assert.strictEqual(b.db.get('tickets', 'T-1').title, '대소문자 id');
assert.strictEqual(b.db.find('tickets', { status: 'done' })[0].id, 't-1', '인덱스 포함 define');
b.graph.define('wiki', { nodes: [{ key: 'page', description: '페이지' }] });
assert.strictEqual(b.graph.getDoc('wiki', 'page', 'pg_1').data.body_md, '# 온보딩\n\n수정');
assert.strictEqual(b.graph.getDoc('wiki', 'page', 'pg_1').node_id, a.graph.getDoc('wiki', 'page', 'pg_1').node_id, 'node_id 보존');
assert.strictEqual(b.db.count('wiki_docs'), a.db.count('wiki_docs'));

// 6. import → export 왕복 시 바이트 동일
const SNAP2 = path.join(tmp, 'snap2');
b.snap.exportTo(SNAP2, { textFields });
for (const f of files(SNAP)) {
  assert.strictEqual(fs.readFileSync(path.join(SNAP2, f), 'utf8'), fs.readFileSync(path.join(SNAP, f), 'utf8'), `왕복 불일치: ${f}`);
}

// 7. prune — 스냅샷에 없는 row는 import 시 삭제, 캐시도 무효화
b.db.put('tickets', 'extra', { title: '스냅샷에 없음' });
assert.ok(b.db.get('tickets', 'extra'));
s = b.snap.importFrom(SNAP);
assert.strictEqual(s.deleted, 1);
assert.strictEqual(b.db.get('tickets', 'extra'), null, '캐시까지 무효화');

// 8. 샤딩 — 임계 초과 시 해시 폴더로 이동, 이전 평면 파일은 정리
for (let i = 0; i < 30; i++) a.db.put('tickets', `n-${i}`, { title: `t${i}`, status: 'open' });
a.snap.exportTo(SNAP, { textFields, shardThreshold: 10 });
const sharded = files(path.join(SNAP, 'tickets'));
assert.strictEqual(sharded.length, 32);
assert.ok(sharded.every((f) => /^[0-9a-f]{2}[/\\]/.test(f)), '전부 해시 폴더 안');
const c = open('c.db');
c.snap.importFrom(SNAP);
assert.strictEqual(c.db.count('tickets'), 32);

// 9. 대상에서 빠진 컬렉션 폴더 정리
a.snap.exportTo(SNAP, { collections: ['tickets'] });
assert.ok(!fs.existsSync(path.join(SNAP, 'wiki_docs')));

for (const x of [a, b, c]) x.db.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('snapshot-smoke: all passed');
