'use strict';

// LRU Cache — doubly linked list + Map으로 O(1) get/put
class LRUCache {
  constructor(maxSize = 128) {
    this.maxSize = maxSize;
    this.map = new Map();   // key → node
    // sentinel head/tail (값 없는 경계 노드)
    this.head = { key: null, value: null, prev: null, next: null };
    this.tail = { key: null, value: null, prev: null, next: null };
    this.head.next = this.tail;
    this.tail.prev = this.head;
  }

  get(key) {
    const node = this.map.get(key);
    if (!node) return undefined;
    this._moveToFront(node);
    return node.value;
  }

  set(key, value) {
    if (this.map.has(key)) {
      const node = this.map.get(key);
      node.value = value;
      this._moveToFront(node);
      return;
    }
    const node = { key, value, prev: null, next: null };
    this._addToFront(node);
    this.map.set(key, node);
    if (this.map.size > this.maxSize) this._evict();
  }

  invalidate(key) {
    const node = this.map.get(key);
    if (!node) return;
    this._remove(node);
    this.map.delete(key);
  }

  // prefix로 시작하는 키 전체 무효화 (컬렉션 단위 invalidation)
  invalidatePrefix(prefix) {
    for (const key of this.map.keys()) {
      if (key.startsWith(prefix)) this.invalidate(key);
    }
  }

  clear() {
    this.map.clear();
    this.head.next = this.tail;
    this.tail.prev = this.head;
  }

  get size() { return this.map.size; }

  _addToFront(node) {
    node.prev = this.head;
    node.next = this.head.next;
    this.head.next.prev = node;
    this.head.next = node;
  }

  _remove(node) {
    node.prev.next = node.next;
    node.next.prev = node.prev;
  }

  _moveToFront(node) {
    this._remove(node);
    this._addToFront(node);
  }

  _evict() {
    const lru = this.tail.prev;
    if (lru === this.head) return;
    this._remove(lru);
    this.map.delete(lru.key);
  }
}

module.exports = { LRUCache };
