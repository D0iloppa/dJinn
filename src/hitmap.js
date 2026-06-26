'use strict';

// 전체 인덱스에 대한 히트맵 — 캐시 참조 + 시각화 두 가지 역할만 수행
// key 구조: "<collection>:<fnv1a_hash>" (queryKey 결과와 동일)
class HitMap {
  constructor() {
    this._hits   = new Map(); // key → hit count (캐시에서 꺼냄)
    this._misses = new Map(); // key → miss count (DB 조회 발생)
    this._labels = new Map(); // key → human-readable label (디버깅용)
  }

  recordHit(key, label) {
    this._hits.set(key, (this._hits.get(key) || 0) + 1);
    if (label && !this._labels.has(key)) this._labels.set(key, label);
  }

  recordMiss(key, label) {
    this._misses.set(key, (this._misses.get(key) || 0) + 1);
    if (label && !this._labels.has(key)) this._labels.set(key, label);
  }

  // 전체 스냅샷 — 접근 빈도 내림차순 정렬
  snapshot() {
    const allKeys = new Set([...this._hits.keys(), ...this._misses.keys()]);
    return [...allKeys].map(key => {
      const hits   = this._hits.get(key)   || 0;
      const misses = this._misses.get(key) || 0;
      const total  = hits + misses;
      return {
        key,
        label:   this._labels.get(key) || key,
        hits,
        misses,
        total,
        hitRate: total === 0 ? 0 : Math.round((hits / total) * 10000) / 100, // % (소수점 2자리)
      };
    }).sort((a, b) => b.total - a.total);
  }

  // 컬렉션 단위 집계 — 히트맵 시각화에서 row로 사용
  byCollection() {
    const buckets = new Map();
    for (const entry of this.snapshot()) {
      const col = entry.key.split(':')[0];
      if (!buckets.has(col)) buckets.set(col, { collection: col, hits: 0, misses: 0, total: 0, keys: 0 });
      const b = buckets.get(col);
      b.hits   += entry.hits;
      b.misses += entry.misses;
      b.total  += entry.total;
      b.keys   += 1;
    }
    return [...buckets.values()]
      .map(b => ({ ...b, hitRate: b.total === 0 ? 0 : Math.round((b.hits / b.total) * 10000) / 100 }))
      .sort((a, b) => b.total - a.total);
  }

  // 캐시 교체 힌트 — 히트율 낮은 키 순 (LRU evict 후보 참조용)
  coldKeys(topN = 10) {
    return this.snapshot()
      .filter(e => e.total > 0)
      .sort((a, b) => a.hitRate - b.hitRate || b.total - a.total)
      .slice(0, topN)
      .map(e => e.key);
  }

  reset() {
    this._hits.clear();
    this._misses.clear();
    this._labels.clear();
  }

  get totalHits()   { return [...this._hits.values()].reduce((s, v) => s + v, 0); }
  get totalMisses() { return [...this._misses.values()].reduce((s, v) => s + v, 0); }
  get totalAccess() { return this.totalHits + this.totalMisses; }
  get globalHitRate() {
    const t = this.totalAccess;
    return t === 0 ? 0 : Math.round((this.totalHits / t) * 10000) / 100;
  }
}

module.exports = { HitMap };
