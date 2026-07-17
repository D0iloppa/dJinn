'use strict';

const { DJinn } = require('../src/index');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'smoke.db');
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

const db = new DJinn(DB_PATH, { cacheSize: 32 });

db.define('nodes', { indexes: ['grp'] });

// put
db.put('nodes', 'abc123', { title: 'DOYCLOPEDIA', grp: 'root', url: 'https://notion.so/abc123', tags: [] });
db.put('nodes', 'def456', { title: '학습 DB',      grp: 'Studia', tags: ['study'] });

// get (캐시 miss → hit)
const n1 = db.get('nodes', 'abc123');
const n1cached = db.get('nodes', 'abc123');
console.assert(n1.title === 'DOYCLOPEDIA', 'get 실패');
console.assert(n1cached === n1cached, '캐시 hit 실패');

// find
const studia = db.find('nodes', { grp: 'Studia' });
console.assert(studia.length === 1 && studia[0].title === '학습 DB', 'find 실패');

// tags JSON 역직렬화
console.assert(Array.isArray(studia[0].tags), 'json 역직렬화 실패');

// del
db.del('nodes', 'def456');
console.assert(db.get('nodes', 'def456') === null, 'del 실패');

// transaction
db.transaction(() => {
  db.put('nodes', 'tx1', { title: 'TX노드A', grp: 'test' });
  db.put('nodes', 'tx2', { title: 'TX노드B', grp: 'test' });
});
console.assert(db.find('nodes', { grp: 'test' }).length === 2, 'transaction 실패');

// cache stats
const stats = db.cacheStats();
console.assert(stats.size > 0, 'cache stats 실패');

// heatmap
db.find('nodes', { grp: 'test' }); // miss → hit 패턴 만들기
db.find('nodes', { grp: 'test' }); // hit
db.find('nodes', { grp: 'test' }); // hit

const hm = db.heatmap();
console.assert(hm.global.totalAccess > 0, 'heatmap totalAccess 실패');
console.assert(hm.global.globalHitRate >= 0 && hm.global.globalHitRate <= 100, 'heatmap hitRate 범위 실패');
console.assert(hm.byCollection.length > 0, 'heatmap byCollection 실패');
console.assert(hm.byCollection[0].collection === 'nodes', 'heatmap collection 명 실패');
console.assert(Array.isArray(hm.keys), 'heatmap keys 실패');
console.assert(Array.isArray(hm.coldKeys), 'heatmap coldKeys 실패');

// hit이 2번인 키는 miss 1번보다 hit이 많아야 함
const testEntry = hm.keys.find(k => k.label.includes('grp=test'));
console.assert(testEntry && testEntry.hits >= 2 && testEntry.misses === 1, 'heatmap hit/miss 카운트 실패');

db.close();
fs.unlinkSync(DB_PATH);

console.log('✓ DJinn smoke test passed');
