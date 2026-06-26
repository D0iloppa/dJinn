'use strict';

const { createHash } = require('crypto');

// FNV-1a 32bit — 캐시 키 생성용 (빠른 비암호화 해시)
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// 쿼리 파라미터 객체 → 결정론적 캐시 키
function queryKey(collection, params = {}) {
  // params 키를 정렬해 직렬화 순서를 고정 (array replacer는 모든 depth에 적용되므로 사용 금지)
  const sortedParams = Object.fromEntries(
    Object.entries(params).sort(([a], [b]) => a.localeCompare(b))
  );
  const canonical = JSON.stringify({ collection, params: sortedParams });
  return `${collection}:${fnv1a(canonical)}`;
}

// 콘텐츠 해시 (무결성 체크용)
function contentHash(obj) {
  return createHash('sha256')
    .update(JSON.stringify(obj))
    .digest('hex')
    .slice(0, 16);
}

module.exports = { fnv1a, queryKey, contentHash };
