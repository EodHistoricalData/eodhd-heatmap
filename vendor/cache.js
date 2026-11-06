// CacheManager - Centralized API response caching with tiered TTLs
window.CacheManager = {
  _store: new Map(),

  // TTL tiers in milliseconds
  TTL: {
    REALTIME: 30 * 1000,       // 30s - real-time prices
    SHORT: 2 * 60 * 1000,      // 2min - frequently changing data
    MEDIUM: 5 * 60 * 1000,     // 5min - news, fundamentals
    LONG: 15 * 60 * 1000,      // 15min - historical data
    STATIC: 60 * 60 * 1000,    // 1hr - exchange lists, static config
  },

  // Generate cache key from args
  _key(...args) {
    return args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join('::');
  },

  // Get cached value if still valid
  get(category, ...keyParts) {
    const key = this._key(category, ...keyParts);
    const entry = this._store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expires) {
      this._store.delete(key);
      return null;
    }
    return entry.data;
  },

  // Store value with TTL. A body that is no data -- EODHD's {"message": ...}
  // with 200, an answer marked unreadable -- is not kept: it was served as
  // the quote, the fundamentals, the history or the holidays for 30 s to a
  // day. The clients throw it as unreadable; this is the
  // last guard for any caller that does not.
  set(category, ttl, data, ...keyParts) {
    const RLW = window.RateLimitWait;
    if (RLW && RLW.notData && RLW.notData(data)) return;
    const key = this._key(category, ...keyParts);
    this._store.set(key, {
      data,
      expires: Date.now() + ttl,
      storedAt: Date.now(),
    });
    // Lazy cleanup: if store gets large, prune expired entries
    if (this._store.size > 200) this._prune();
  },

  // Fetch with cache - wraps an async function
  async fetch(category, ttl, fetchFn, ...keyParts) {
    const cached = this.get(category, ...keyParts);
    if (cached !== null) return cached;
    const data = await fetchFn();
    if (data !== null && data !== undefined) {
      this.set(category, ttl, data, ...keyParts);
    }
    return data;
  },

  // Invalidate specific cache entry
  invalidate(category, ...keyParts) {
    const key = this._key(category, ...keyParts);
    this._store.delete(key);
  },

  // Invalidate all entries in a category
  invalidateCategory(category) {
    const prefix = category + '::';
    for (const key of this._store.keys()) {
      if (key.startsWith(prefix)) this._store.delete(key);
    }
  },

  // Clear all cache
  clear() {
    this._store.clear();
  },

  // Remove expired entries
  _prune() {
    const now = Date.now();
    for (const [key, entry] of this._store) {
      if (now > entry.expires) this._store.delete(key);
    }
  },

  // Get cache stats (for debugging)
  stats() {
    let valid = 0, expired = 0;
    const now = Date.now();
    for (const entry of this._store.values()) {
      if (now <= entry.expires) valid++; else expired++;
    }
    return { total: this._store.size, valid, expired };
  },
};
