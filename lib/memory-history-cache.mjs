// Bounded, volatile history-page cache for the stateless entry relay.
//
// This exists only as an explicit performance opt-in. It never touches disk,
// never stores credentials, and disappears with the process. The relay only
// inserts immutable history pages (requests carrying `beforeSeq`), never the
// mutable opening page: a cached opening page could omit events appended after
// it was captured, while a page older than a fixed seq cannot change.
//
// Bounds are enforced on both entry count and total payload bytes, with LRU
// eviction. A single page larger than the byte budget is not cached at all.

export class MemoryHistoryCache {
  constructor({
    ttlMs = 60_000,
    maxEntries = 16,
    maxBytes = 32 * 1024 * 1024,
    now = Date.now,
  } = {}) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new RangeError('cache ttlMs must be positive')
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new RangeError('cache maxEntries must be a positive integer')
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError('cache maxBytes must be a positive integer')
    if (typeof now !== 'function') throw new TypeError('cache now must be a function')
    this.ttlMs = ttlMs
    this.maxEntries = maxEntries
    this.maxBytes = maxBytes
    this.now = now
    this.entries = new Map()
    this.bytes = 0
    this.hits = 0
    this.misses = 0
    this.evictions = 0
  }

  /** Remove expired entries; used by stats and before eviction decisions. */
  purgeExpired() {
    const now = this.now()
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key)
        this.bytes -= entry.bytes
      }
    }
  }

  /** Return a cached string, or undefined on a miss. A hit refreshes LRU order. */
  get(key) {
    const entry = this.entries.get(key)
    if (entry === undefined) {
      this.misses += 1
      return undefined
    }
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key)
      this.bytes -= entry.bytes
      this.misses += 1
      return undefined
    }
    this.entries.delete(key)
    this.entries.set(key, entry)
    this.hits += 1
    return entry.value
  }

  /** Store one page; returns false when the page alone exceeds the byte budget. */
  set(key, value) {
    if (typeof value !== 'string') throw new TypeError('cache value must be a string')
    const bytes = Buffer.byteLength(value, 'utf8')
    if (bytes > this.maxBytes) return false
    const existing = this.entries.get(key)
    if (existing !== undefined) {
      this.entries.delete(key)
      this.bytes -= existing.bytes
    }
    this.entries.set(key, { value, bytes, expiresAt: this.now() + this.ttlMs })
    this.bytes += bytes
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldestKey = this.entries.keys().next().value
      const oldest = this.entries.get(oldestKey)
      this.entries.delete(oldestKey)
      this.bytes -= oldest.bytes
      this.evictions += 1
    }
    return true
  }

  clear() {
    this.entries.clear()
    this.bytes = 0
  }

  stats() {
    this.purgeExpired()
    return {
      enabled: true,
      entries: this.entries.size,
      bytes: this.bytes,
      ttlMs: this.ttlMs,
      maxEntries: this.maxEntries,
      maxBytes: this.maxBytes,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
    }
  }
}