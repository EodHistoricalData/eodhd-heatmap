// ExchangeStatus — facade over /api/v2/exchange-details for trading-hours
// awareness across the app.
//
// Why a facade and not direct API calls everywhere:
// - The v2 endpoint has rich data (PreMarket / AfterHours / LunchBreak,
//   EarlyClose typed holidays, IANA timezones, manually verified 2026
//   calendar) but every caller would need to re-do the timezone math, the
//   "is this date a holiday" lookup, and the "what session are we in"
//   classification. So we centralise that logic here once.
// - Holidays + trading hours are static for the day. We cache the v2
//   response per exchange in CacheManager (24h TTL inside api.js) and a
//   short in-memory map here for the lifetime of the page.
// - The legacy v1 endpoint kept the live `isOpen` field which v2 dropped.
//   We use v2 for hours/holidays and fall back to v1 only when the runtime
//   `isOpen` is what the caller wants — but most of the time, v2 + a clock
//   is enough.
//
// Public API (window.ExchangeStatus):
//   resolveExchange(symbol)     — 'AAPL.US' → 'US'
//   load(exchange, apiKey)      — preload (returns the v2 payload)
//   isMarketOpenNow(exchange)   — boolean, based on now() + trading hours + holidays
//   getCurrentSession(exchange) — 'pre' | 'regular' | 'lunch' | 'after' | 'closed'
//   isEarlyCloseToday(exchange) — boolean
//   getHolidayToday(exchange)   — { name, type } | null
//   getNextHoliday(exchange)    — { date, name, type } | null
//   getHolidaysBetween(exchange, from, to) — [{ date, name, type, closeAt }], past days too
//   getRegularHours(exchange)   — { open: 'HH:MM', close: 'HH:MM', tz: 'America/New_York' }
//   getCloseTimeToday(exchange) — 'HH:MM' adjusted for EarlyClose, or null if closed

(function () {
  // In-memory cache keyed by exchange code. CacheManager handles persistence
  // across page navigations; this map handles same-page parallel callers
  // that don't want to wait for the localStorage round-trip.
  const _data = new Map();
  const _inflight = new Map();
  // The latest request asked per exchange, and the request whose hours are
  // kept (only hours: a refusal or a failure never outranks hours).
  const _gen = new Map();
  const _kept = new Map();
  // Each key's refusal per exchange ({ status, daily }): a refusal is the
  // key's own and never takes away hours known (keepRefusal).
  const _refusedBy = new Map();
  // The key the latest request was asked with, per exchange: an answer for
  // another key is not this one's.
  const _lastKey = new Map();
  const keyOf = (apiKey) => (apiKey == null ? null : String(apiKey));
  // The in-flight table's key: the exchange and the API key it was asked with.
  const flightOf = (exchange, key) => JSON.stringify([String(exchange), key]);
  // A failure kept for an exchange: when, how many in a row, and why. A
  // later load asks again once the pace allows (retryIn), instead of the
  // failure standing for the page's life.
  const _failedAt = new Map();
  // How many screens read each exchange's hours now (use / inUse).
  const _users = new Map();
  // An exchange's status changed -- hours kept, a refusal, a failure -- told
  // as 'exchange-status:changed' on window ({ exchange }), so a screen that
  // read it before the answer came reads it again at once. The asset page's
  // pill read "STATUS UNKNOWN" until its 30-second tick when the hours came
  // in by another request than its own.
  const tellChanged = (exchange) => {
    try { window.dispatchEvent(new CustomEvent('exchange-status:changed', { detail: { exchange } })); } catch (_) { /* a courtesy */ }
  };
  const tellUse = (exchange) => {
    try { window.dispatchEvent(new CustomEvent('exchange-status:use', { detail: { exchange, inUse: (_users.get(exchange) || 0) > 0 } })); } catch (_) { /* a courtesy */ }
  };

  // The moment the helpers below read: now, or `at` (a quote's time, unix
  // seconds or ms).
  const dateOf = (at) => {
    if (at == null) return new Date();
    const n = Number(at);
    return new Date(Number.isFinite(n) && n < 4e10 ? n * 1000 : n);
  };

  const todayISOInTZ = (tz, at) => {
    try {
      // 'en-CA' yields YYYY-MM-DD reliably. Intl handles DST correctly.
      const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      });
      return fmt.format(dateOf(at));
    } catch (_) {
      return dateOf(at).toISOString().slice(0, 10);
    }
  };

  const nowHHMMInTZ = (tz, at) => {
    try {
      const fmt = new Intl.DateTimeFormat('en-GB', {
        timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
      });
      return fmt.format(dateOf(at)); // 'HH:MM'
    } catch (_) {
      return dateOf(at).toTimeString().slice(0, 5);
    }
  };

  const dayOfWeekInTZ = (tz, at) => {
    // 0=Sun, 1=Mon, ... 6=Sat
    try {
      const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' });
      const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
      return map[fmt.format(dateOf(at))] ?? dateOf(at).getDay();
    } catch (_) {
      return dateOf(at).getDay();
    }
  };

  // The forex week: from Sunday 17:00 to Friday 17:00 New York time, the
  // market's usual convention (Sydney opens it, New York closes it), closed
  // at the weekend.
  const FX_TZ = 'America/New_York';
  const FX_OPENS = '17:00';
  const fxSession = (at) => {
    const dow = dayOfWeekInTZ(FX_TZ, at);
    const t = nowHHMMInTZ(FX_TZ, at);
    if (dow === 6) return 'closed';
    if (dow === 0) return t >= FX_OPENS ? 'regular' : 'closed';
    if (dow === 5) return t < FX_OPENS ? 'regular' : 'closed';
    return 'regular';
  };

  const cmpHHMM = (a, b) => {
    // 'HH:MM' or 'HH:MM:SS' — string compare works because zero-padded.
    if (!a || !b) return 0;
    return a.slice(0, 5).localeCompare(b.slice(0, 5));
  };

  const normaliseHoliday = (entry, dateKey) => {
    if (!entry) return null;
    // v2 EarlyClose entries carry the close time in `EarlyClose: "13:00:00"`.
    // v1 used `From` / `To`. Surface a unified `closeAt` so callers don't
    // have to know which version produced the row.
    const closeAt = entry.EarlyClose || entry.To || entry.From || null;
    return {
      date: entry.Date || dateKey || null,
      name: entry.Holiday || entry.Name || 'Holiday',
      type: entry.Type || 'Closed',
      closeAt,
      from: entry.From || null,
      to: entry.To || null,
    };
  };

  // Any exchange-details answer → the v2 body this module reads.
  //
  // v1 /exchange-details keys ExchangeHolidays by position ({"5": {Holiday:
  // "Thanksgiving Day", Date: "2026-11-26"}}), keeps half-days apart in
  // ExchangeEarlyCloseDays ({EarlyClose: "13:00"}) and has no pre- or
  // after-market hours; v2 keys holidays by date and types half-days
  // EarlyClose. Every lookup below reads v2, so a v1 body found no holiday
  // ever: the calendar's Holidays tab said "No upcoming events found",
  // the heatmap treated Thanksgiving as a trading day and 27.11 after 13:00
  // as open, and getNextHoliday compared "3" with a date and answered with
  // last July's. The apps built from this file fetch v1
  // directly, and the terminal falls back to it for exchanges v2 lacks, so
  // the reshaping lives here, where every caller passes.
  const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
  // US extended hours, which v1 does not carry (v2's own values). Without
  // them 09:22 ET read as "closed", not pre-market.
  const US_EXTENDED = { PreMarketOpen: '04:00:00', PreMarketClose: '09:30:00', AfterHoursOpen: '16:00:00', AfterHoursClose: '20:00:00' };
  const listOf = (src) => (Array.isArray(src) ? src : (src && typeof src === 'object' ? Object.values(src) : []));
  const normalisePayload = (d, exchange) => {
    if (!d || typeof d !== 'object' || d._notFound || d.error) return d;
    const hol = d.ExchangeHolidays;
    const early = d.ExchangeEarlyCloseDays;
    const dateKeyed = hol && typeof hol === 'object' && !Array.isArray(hol)
      && Object.keys(hol).length > 0 && Object.keys(hol).every(k => ISO_DAY.test(k));
    let out = d;
    if ((hol && !dateKeyed) || (early && typeof early === 'object')) {
      const merged = {};
      if (dateKeyed) Object.assign(merged, hol);
      else {
        listOf(hol).forEach((e) => {
          if (!e || !e.Date) return;
          const day = String(e.Date).slice(0, 10);
          if (!ISO_DAY.test(day)) return;
          merged[day] = e.EarlyClose
            ? { Holiday: e.Holiday || e.Name, Type: 'EarlyClose', EarlyClose: String(e.EarlyClose).length === 5 ? e.EarlyClose + ':00' : e.EarlyClose }
            : { Holiday: e.Holiday || e.Name, Type: e.Type || 'Official' };
        });
      }
      listOf(early).forEach((e) => {
        if (!e || !e.Date) return;
        const day = String(e.Date).slice(0, 10);
        if (!ISO_DAY.test(day)) return;
        let close = e.EarlyClose || null;
        if (close && String(close).length === 5) close += ':00';
        merged[day] = { Holiday: e.Holiday || e.Name, Type: 'EarlyClose', EarlyClose: close };
      });
      out = { ...d, ExchangeHolidays: merged };
      delete out.ExchangeEarlyCloseDays;
    }
    if (String(exchange || '').toUpperCase() === 'US') {
      const th = out.TradingHours || {};
      if (th.Open && !th.PreMarketOpen && !out.PreMarketOpen) out = { ...out, TradingHours: { ...US_EXTENDED, ...th } };
    }
    return out;
  };

  const US_INDICES = new Set(['GSPC', 'IXIC', 'DJI', 'NDX', 'RUT', 'VIX', 'NYA', 'OEX', 'MID', 'SML', 'DJT', 'DJU', 'SOX', 'W5000', 'RUI', 'RUA']);

  // How long load() waits for an exchange's details. The terminal's request
  // has no deadline of its own, and whatever waited on a status that hung --
  // the heatmap's quotes, the calendar's holidays, the asset page's hours, a
  // stock's live feed -- waited as long as the browser kept it open. Past it, load() answers as failed (not kept), and
  // the request's own answer, whenever it comes, is kept as before. The
  // open apps' client gives up at the same 25 s.
  const LOAD_DEADLINE_MS = 25000;
  const TIMED_OUT = () => ({ _notFound: true, _failed: true, _timedOut: true });
  const deadline = () => window.EXCHANGE_STATUS_DEADLINE_MS || LOAD_DEADLINE_MS;
  // A failure is kept, a timeout too: a status that hung was not, so nothing
  // knew it had failed -- the heatmap never asked for it again, its Refresh
  // did not either, and its session line and holiday banners never came.
  // An answer already kept is not replaced by a failure. The reason is
  // fixed when it is kept: a wait that starts later does not turn a timeout
  // into "the limit".
  const failureOf = (body) => {
    const R = window.RateLimitWait;
    if (body._unreadable) return R && R.failure ? R.failure({ unreadable: true, status: 200 }) : { unreadable: true, status: 200 };
    if (body._status) return R && R.failure ? R.failure({ status: body._status }) : { status: body._status };
    return { limited: false, status: 0, at: Date.now() };
  };
  // An answer that brings no status, whoever gave it, as the failure kept.
  // The open apps' client answers a 500, a 429, a refusal, its own 25 s
  // timeout and a dropped connection with { error: 'not served' }; the
  // terminal's answers a dropped connection, and an ask its 429 wait
  // refused, with null; either may throw. None was kept: failed() stayed
  // false, retryIn null, the heatmap never asked again and its line never
  // came. Why: the client's own words when it has them,
  // else the wait (RateLimitWait.failure) -- inside it nothing is sent.
  // "No such exchange" is not one: { _notFound: true } with no _failed mark
  // (a 404 from v2 and v1 in the terminal, a 404 in the open apps) is an
  // answer, kept as before and never asked again.
  // The open apps' client now says why with it -- { error, status, limited,
  // unreadable }, or { notServed: { … } } -- and that is read as the
  // terminal's own is: a 500 is "answered with an error (500)", not "did
  // not answer, or the connection dropped".
  const whyOf = (data) => {
    if (!data || typeof data !== 'object') return null;
    const src = data.notServed && typeof data.notServed === 'object' ? data.notServed : data;
    const status = Number(src.status || src._status || src.statusCode) || 0;
    const limited = Boolean(src.limited || src.rateLimited);
    const unreadable = Boolean(src.unreadable || src._unreadable);
    if (!status && !limited && !unreadable) return null;
    return { status, rateLimited: limited, unreadable };
  };
  const noStatus = (data, thrown) => {
    const R = window.RateLimitWait;
    const why = thrown || whyOf(data);
    return { _notFound: true, _failed: true, _fail: R && R.failure ? R.failure(why) : { limited: false, status: 0, at: Date.now() } };
  };
  // A refusal of the key (401), of the day's quota or the plan (402) or of
  // the plan (403) is an answer for this key, not a failure to repeat: kept
  // as one, never asked again while the key is the same. Repeated at 5, 15,
  // 35, 75 s over a working map, the 403 brought the open apps' panel back
  // after each ask. `refused()` says which it was.
  const REFUSALS = { 401: true, 402: true, 403: true };
  const refusalOf = (f) => (f && !f.limited && !f.unreadable && REFUSALS[f.status] ? f.status : 0);
  // A refusal is the key's: kept as that key's answer, and said while no
  // hours are known. It never takes away hours known -- they are the
  // exchange's, whoever asked, and in whatever order the answers come: key
  // B's 403 after key A's hours left every screen without the session
  // (getRegularHours null), and A's hours arriving after B's 403 were
  // dropped as an older request's. `daily`: a 402 the open
  // apps' client read as the day's limit spent.
  const keepRefusal = (exchange, status, apiKey, gen, daily) => {
    const key = apiKey == null ? null : String(apiKey);
    if (!_refusedBy.has(exchange)) _refusedBy.set(exchange, new Map());
    _refusedBy.get(exchange).set(key, { status, daily: Boolean(daily) });
    const had = _data.get(exchange);
    if (had && !had._failed && !had._refused) return;     // hours known: they stay
    _data.set(exchange, { _notFound: true, _refused: status, _daily: Boolean(daily), _key: key });
    _failedAt.delete(exchange);
    tellChanged(exchange);
  };
  // Whether a host's own panel above the screens (the open apps' frame)
  // says a refusal: the key refused (401) or the day spent (402), always
  // where there is a host. The terminal has no such
  // panel, and its screens say every refusal themselves: a 401 or 402 there
  // said nothing at all. A 403 is always the screens' to say
  // (says()).
  const hostSays = (status) => {
    // One rule with every other line (RateLimitWait.hostSaysKey).
    const R = window.RateLimitWait;
    if (R && typeof R.hostSaysKey === 'function') return R.hostSaysKey({ status, limited: false, unreadable: false });
    // The same rule without it: only while the panel is up and says it.
    const E = window.Entitlement;
    if ((status !== 401 && status !== 402) || !E || typeof E.problem !== 'function') return false;
    try {
      const p = E.problem();
      if (p && Number(p.status) === status) return true;
      return status === 402 && typeof E.anyDenied === 'function' && Boolean(E.anyDenied());
    } catch (_) {
      return false;
    }
  };
  const hasStatus = (data) => Boolean(data) && typeof data === 'object' && !Array.isArray(data) && !data.error && !data.notServed;
  const keepFailure = (exchange, body) => {
    const had = _data.get(exchange);
    if (had && !had._failed) return;
    _data.set(exchange, { ...body, _fail: body._fail || failureOf(body) });
    const f = _failedAt.get(exchange);
    _failedAt.set(exchange, { at: Date.now(), n: (f ? f.n : 0) + 1 });
    tellChanged(exchange);
  };
  // The pace of the asking again: as every panel's automatic reload
  // (RateLimitWait.reloadDelay -- 5 s, 10 s, 20 s ... 2 min).
  const reloadDelay = (n) => {
    const R = window.RateLimitWait;
    return R && R.reloadDelay ? R.reloadDelay(n) : Math.min(120000, 5000 * Math.pow(2, Math.max(0, n - 1)));
  };
  const bounded = (entry, exchange) => new Promise((resolve, reject) => {
    const left = deadline() - (Date.now() - entry.at);
    const t = setTimeout(() => {
      // A request of a key no longer asked with keeps nothing.
      if (!entry.timedOut) { entry.timedOut = true; if (entry.key === _lastKey.get(exchange)) keepFailure(exchange, TIMED_OUT()); }
      resolve(TIMED_OUT());
    }, Math.max(0, left));
    entry.p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });

  const ExchangeStatus = {
    normalisePayload,
    todayISOInTZ,

    resolveExchange(symbol) {
      if (!symbol || typeof symbol !== 'string') return 'US';
      const i = symbol.lastIndexOf('.');
      if (i === -1) return 'US';
      const tail = symbol.slice(i + 1).toUpperCase();
      // FOREX / CRYPTO have no exchange holidays; treat as 24/7 markets.
      if (tail === 'FOREX' || tail === 'CC' || tail === 'CRYPTO') return tail;
      return tail || 'US';
    },

    // The exchange whose trading hours describe this symbol, or null when
    // nothing does. EODHD's "INDX" entry is a placeholder (00:00-23:59
    // London, Mon-Fri), so every index read OPEN all day (NASDAQ
    // Composite "OPEN" in the US pre-market). The main US indices follow the
    // US session; for the rest we do not know and say nothing.
    scheduleExchange(symbol) {
      const ex = this.resolveExchange(symbol);
      if (ex !== 'INDX') return ex;
      const code = String(symbol).slice(0, String(symbol).lastIndexOf('.')).toUpperCase();
      return US_INDICES.has(code) ? 'US' : null;
    },

    // Forex keeps a week of its own (fxSession), not crypto's 24/7; it has no
    // exchange details to load either (is24x7 below says that).
    isForex(exchange) {
      return String(exchange || '').toUpperCase() === 'FOREX';
    },

    is24x7(exchange) {
      const e = (exchange || '').toUpperCase();
      return e === 'FOREX' || e === 'CC' || e === 'CRYPTO';
    },

    // opts.fresh: ask again when what is kept is a failure (failed() below).
    // A plain load asks again too, once a kept failure is older than the
    // pace allows (retryIn).
    async load(exchange, apiKey, opts) {
      if (!exchange) return null;
      if (this.is24x7(exchange)) return null;
      const due = this.failed(exchange) && this.retryIn(exchange) === 0;
      // A refusal is this key's: another key (a sign-in) asks again, and
      // asks fresh -- the terminal's client keeps a failed answer for ten
      // minutes under the exchange alone, and handed key A's 403 to key B
      // with no request.
      const key = keyOf(apiKey);
      let had = _data.get(exchange);
      // This key's own refusal, with no hours known: its answer, not asked
      // again -- also after another key's refusal took the shared entry.
      const mine = _refusedBy.has(exchange) ? _refusedBy.get(exchange).get(key) : null;
      if (mine && !(had && !had._failed && !had._refused) && !(had && had._refused && had._key === key)) {
        had = { _notFound: true, _refused: mine.status, _daily: mine.daily, _key: key };
        _data.set(exchange, had);
        _failedAt.delete(exchange);
      }
      const otherKey = Boolean(had && had._refused && had._key !== key);
      if (otherKey) _data.delete(exchange);
      const fresh = !!(opts && opts.fresh) || due || otherKey;
      // A request still out past the deadline is no answer to wait for any
      // more: a fresh retry (the calendar's Try again) asks anew instead of
      // joining it -- it joined, and timed out again at once, until the
      // hung request ended. A plain load still joins it.
      // Only a request of the same key: key B joined key A's, A's 403 came
      // back as B's, and B's hours were never asked. Kept per
      // exchange and key: one per exchange made A, B, A send A twice, B
      // having taken A's place.
      const flight = flightOf(exchange, key);
      const out = _inflight.get(flight) || null;
      // Past its deadline by the clock, or by its own timer having fired: a
      // clock that is set or held still kept a hung request "fresh" for ever.
      const expired = Boolean(out) && (Boolean(out.timedOut) || Date.now() - out.at >= deadline());
      // Asked over a kept failure: an answer of nothing (the client's wait
      // refused the ask, the SDK gave up) keeps the failure, as the limit
      // while the wait runs. It dropped it: the line saying the status is
      // missing went, and nothing asked again.
      const over = fresh && this.failed(exchange) && (!out || expired);
      if (over) _data.delete(exchange);
      if (_data.has(exchange)) return _data.get(exchange);
      // Joined: this key is the one asked with now, so an answer of another
      // key that comes first is not kept over it.
      if (out && !(fresh && expired)) { _lastKey.set(exchange, key); return bounded(out, exchange); }

      // Which request this is: an older one that answers late does not
      // overwrite what a newer one already brought.
      const gen = (_gen.get(exchange) || 0) + 1;
      _gen.set(exchange, gen);
      _lastKey.set(exchange, key);
      // An answer for a key no longer asked with is kept nowhere.
      const stale = () => _lastKey.get(exchange) !== key;
      const p = (async () => {
        const api = window.EODHD_API;
        if (!api || !api.getExchangeHolidaysV2) return null;
        // A failure is kept to be asked again; a refusal of this key or
        // plan is kept as its answer -- over hours an older request brought
        // too: request 1 timed out, request 2 started, request 1 brought
        // hours, request 2's 403 was dropped. Only the newest
        // request settles here (the generation checks below); a failure
        // still never takes away hours kept (keepFailure).
        const settle = (body, daily) => {
          const r = refusalOf(body._fail || failureOf(body));
          if (r) keepRefusal(exchange, r, apiKey, gen, daily);
          else keepFailure(exchange, body);
        };
        const dailyOf = (d) => Boolean(d && typeof d === 'object' && (d._dailyLimit || d.dailyLimit || (d.notServed && d.notServed.dailyLimit)));
        let raw;
        try {
          raw = await api.getExchangeHolidaysV2(apiKey, exchange, fresh ? { fresh: true } : undefined);
        } catch (e) {
          const failed = noStatus(null, e || {});
          if (!stale() && gen >= (_kept.get(exchange) || 0)) settle(failed);
          return failed;
        }
        // v2 wraps the payload in { data: {...}, meta: [], links: [] }.
        // The legacy v1 endpoint returns the payload at the root. Unwrap
        // here so the rest of this module can stay agnostic.
        const data = normalisePayload(raw && raw.data && typeof raw.data === 'object' ? raw.data : raw, exchange);
        const hours = hasStatus(data) && !data._failed;
        // Hours a newer request already brought are not overwritten by an
        // older request's; nothing else outranks hours.
        if (hours && gen < (_kept.get(exchange) || 0)) return data;
        if (!hours && gen < (_gen.get(exchange) || 0) && _data.has(exchange) && !_data.get(exchange)._failed) return data;
        // Hours are the exchange's, whoever asked: hours a request of another
        // key brings are kept too, unless a newer answer is. Only a refusal
        // or a failure is the key's own. The asset page's pill asked with
        // the app's key and the live feed with the account's: the pill's
        // answer was dropped as another key's, and it read "STATUS UNKNOWN"
        // until the feed's answer and its 30-second tick (XETRA, LSE; SW,
        // which the feed does not stream, read CLOSED at once).
        if (stale() && !hours) return data;
        if (!hasStatus(data)) settle(noStatus(data), dailyOf(raw));
        else if (data._failed) settle(data, dailyOf(raw));
        else { _data.set(exchange, data); _kept.set(exchange, gen); _failedAt.delete(exchange); tellChanged(exchange); }
        return data;
      })();
      const entry = { p, at: Date.now(), key };
      _inflight.set(flight, entry);
      // Kept while it is out, however long: a caller that comes later joins
      // it rather than sending a second request beside one that hangs.
      const done = () => { if (_inflight.get(flight) === entry) _inflight.delete(flight); };
      p.then(done, done);
      return bounded(entry, exchange);
    },

    // Milliseconds until a load may ask again for an exchange whose status
    // failed (0: now), or null when nothing failed. Never inside the
    // client's wait (Retry-After): asked on the pace alone (5 s) under
    // Retry-After: 20, the ask was refused before it left.
    retryIn(exchange) {
      const f = _failedAt.get(exchange);
      if (!f || !this.failed(exchange)) return null;
      const R = window.RateLimitWait;
      const now = Date.now();
      const wait = R && R.until ? R.until() : 0;
      return Math.max(0, f.at + reloadDelay(f.n) - now, wait ? wait - now : 0);
    },
    // Why the status failed (RateLimitWait.failure), or null.
    failure(exchange) {
      const d = _data.get(exchange);
      return d && d._failed ? (d._fail || failureOf(d)) : null;
    },
    // The status a refusal of the details was answered with (401, 402,
    // 403), or 0. Loaded, not failed: nothing asks again, and no hours.
    refused(exchange) {
      const d = _data.get(exchange);
      return (d && d._refused) || 0;
    },
    // Whether the screens that read an exchange's status say themselves
    // what is missing, so a host's panel need not: a failure (their line
    // with its Try again) or the plan's 403 ("… not included in this
    // plan"). A refused key (401) or a spent day (402) is the panel's to
    // say: the screens leave the line out for it.
    says(exchange) {
      return this.failed(exchange) || this.refused(exchange) === 403;
    },
    // The sentence a screen says a refusal with, `what` first ("Market
    // hours"), never with a Try again; '' when there is none, or when a
    // host's own panel says it already (hostSays: a 401, a 402) -- or, with
    // opts.panel, "<what> did not load. See the panel above.": a screen
    // whose whole content is what was refused (the calendar's Holidays)
    // says that much rather than nothing. A 402 is the
    // day's limit, never "not included in this plan" (a 403's words).
    refusalText(exchange, what, opts) {
      const d = _data.get(exchange);
      const status = (d && d._refused) || 0;
      if (!status) return '';
      if (status === 403) return what + ' are not included in this plan.';
      if (hostSays(status)) return opts && opts.panel ? what + ' did not load. See the panel above.' : '';
      if (status === 401) return what + ' did not load: EODHD did not accept the API key (401).';
      return what + " did not load: EODHD's daily request limit was reached (402).";
    },

    // Which exchanges a screen on the page reads the hours of now. A
    // failure of an exchange no screen uses at the moment -- the US hours
    // under the heatmap's Crypto or Forex tab -- is said by nobody there,
    // neither a line nor a host's panel; its line comes back with the tab
    // that uses it (the panel came
    // up over Crypto 3-4 s after the S&P 500's hours failed, and the page
    // moved 177 px). use() returns the release; inUse() is true while a
    // screen uses the exchange, false once every screen that used it has
    // let go, and null for one no screen ever said it uses (asked as
    // before). A change is told as 'exchange-status:use' on window.
    use(exchange) {
      if (!exchange) return () => {};
      const ex = String(exchange);
      _users.set(ex, (_users.get(ex) || 0) + 1);
      tellUse(ex);
      let done = false;
      return () => {
        if (done) return;
        done = true;
        _users.set(ex, Math.max(0, (_users.get(ex) || 0) - 1));
        tellUse(ex);
      };
    },
    inUse(exchange) {
      const ex = String(exchange);
      return _users.has(ex) ? _users.get(ex) > 0 : null;
    },

    // The payload load() kept, and a way to hand one back: the calendar keeps
    // these for the day so a reload does not ask for three exchanges again.
    peek(exchange) {
      return _data.has(exchange) ? _data.get(exchange) : null;
    },
    prime(exchange, data) {
      if (!exchange || !data || typeof data !== 'object' || data.error || data._failed) return;
      if (!_data.has(exchange) || this.failed(exchange)) { _data.set(exchange, normalisePayload(data, exchange)); _failedAt.delete(exchange); }
    },

    // True once load() has an answer for this exchange — including the
    // "v2 has no such exchange" answer. wsBridge waits for this before it
    // opens a stock socket: "not loaded yet" used to read as "open", so the
    // first card at night opened /ws/us for nothing.
    isLoaded(exchange) {
      return _data.has(exchange);
    },

    // True when the exchange's details did not come back at all (5xx,
    // network, rate limit): loaded, so nothing waits on it, but no answer.
    failed(exchange) {
      const d = _data.get(exchange);
      return !!(d && d._failed);
    },
    // Of those, an answer that came back and could not be read (a page
    // with 200, {"message"}): the calendar says "could not read".
    unreadable(exchange) {
      const d = _data.get(exchange);
      return !!(d && d._unreadable);
    },

    _get(exchange) {
      const d = _data.get(exchange);
      // Negative-cache sentinel returned when v2/exchange-details 404'd.
      // Treat as no data rather than letting downstream blow up on missing
      // ExchangeHolidays / TradingHours fields.
      if (!d || d._notFound) return null;
      return d;
    },

    getRegularHours(exchange) {
      const d = this._get(exchange);
      if (!d) return null;
      const tz = d.Timezone || d.TradingHours?.Timezone || 'UTC';
      const th = d.TradingHours || {};
      const open = th.Open || d.Open;
      const close = th.Close || d.Close;
      if (!open || !close) return null;
      return {
        open,
        close,
        tz,
        // v2 nests pre- and after-hours inside TradingHours; v1 had them at
        // the root (or didn't have them at all). Surface both shapes so the
        // session classifier doesn't care which version produced the row.
        preOpen: th.PreMarketOpen || d.PreMarketOpen || null,
        preClose: th.PreMarketClose || d.PreMarketClose || null,
        afterOpen: th.AfterHoursOpen || d.AfterHoursOpen || null,
        afterClose: th.AfterHoursClose || d.AfterHoursClose || null,
        lunchStart: th.LunchBreakStart || d.LunchBreakStart || null,
        lunchEnd: th.LunchBreakEnd || d.LunchBreakEnd || null,
        workingDays: th.WorkingDays || null,
      };
    },

    // `at`: the day of that moment (a quote's time) instead of today.
    getHolidayToday(exchange, at) {
      const d = this._get(exchange);
      if (!d) return null;
      const hours = this.getRegularHours(exchange);
      const tz = hours ? hours.tz : (d.Timezone || 'UTC');
      const today = todayISOInTZ(tz, at);
      const hol = d.ExchangeHolidays || d.Holidays || {};
      // v2 — date-keyed object. v1 — array with Date field.
      if (Array.isArray(hol)) {
        const found = hol.find(h => (h.Date || '').slice(0, 10) === today);
        return found ? normaliseHoliday(found) : null;
      }
      if (hol[today]) return normaliseHoliday(hol[today], today);
      return null;
    },

    getNextHoliday(exchange) {
      const d = this._get(exchange);
      if (!d) return null;
      const hours = this.getRegularHours(exchange);
      const tz = hours ? hours.tz : (d.Timezone || 'UTC');
      const today = todayISOInTZ(tz);
      const hol = d.ExchangeHolidays || d.Holidays || {};
      let entries;
      if (Array.isArray(hol)) {
        entries = hol.map(h => [h.Date || '', h]);
      } else {
        entries = Object.entries(hol);
      }
      const upcoming = entries
        .filter(([date]) => ISO_DAY.test(String(date).slice(0, 10)) && date >= today)
        .sort((a, b) => a[0].localeCompare(b[0]));
      if (upcoming.length === 0) return null;
      return normaliseHoliday(upcoming[0][1], upcoming[0][0]);
    },

    getUpcomingHolidays(exchange, days = 60) {
      const d = this._get(exchange);
      if (!d) return [];
      const hours = this.getRegularHours(exchange);
      const tz = hours ? hours.tz : (d.Timezone || 'UTC');
      const today = todayISOInTZ(tz);
      const cutoff = new Date(Date.now() + days * 24 * 60 * 60 * 1000)
        .toISOString().slice(0, 10);
      const hol = d.ExchangeHolidays || d.Holidays || {};
      let entries;
      if (Array.isArray(hol)) {
        entries = hol.map(h => [h.Date || '', h]);
      } else {
        entries = Object.entries(hol);
      }
      return entries
        .filter(([date]) => ISO_DAY.test(String(date).slice(0, 10)) && date >= today && date <= cutoff)
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([date, entry]) => normaliseHoliday(entry, date));
    },

    // The holidays dated `from`..`to` (YYYY-MM-DD, both kept), past ones
    // included: the calendar's grid of a month gone by showed none, since
    // getUpcomingHolidays starts at today.
    getHolidaysBetween(exchange, from, to) {
      const d = this._get(exchange);
      if (!d || !from || !to) return [];
      const hol = d.ExchangeHolidays || d.Holidays || {};
      const entries = Array.isArray(hol) ? hol.map(h => [h.Date || '', h]) : Object.entries(hol);
      return entries
        .map(([date, entry]) => [String(date).slice(0, 10), entry])
        .filter(([date]) => ISO_DAY.test(date) && date >= from && date <= to)
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([date, entry]) => normaliseHoliday(entry, date));
    },

    isEarlyCloseToday(exchange) {
      const h = this.getHolidayToday(exchange);
      return !!(h && h.type && /early|half/i.test(h.type));
    },

    getCloseTimeToday(exchange) {
      const h = this.getHolidayToday(exchange);
      if (h && /early|half/i.test(h.type || '')) {
        return (h.closeAt || '').slice(0, 5) || null;
      }
      const hours = this.getRegularHours(exchange);
      return hours ? hours.close.slice(0, 5) : null;
    },

    // `at` (unix seconds or ms): the session at that moment -- a quote's
    // own time -- instead of now.
    getCurrentSession(exchange, at) {
      // Forex has a week of its own (fxSession): open Sunday evening to
      // Friday evening, closed at the weekend. Crypto never closes.
      if (this.isForex(exchange)) return fxSession(at);
      if (this.is24x7(exchange)) return 'regular';
      const hours = this.getRegularHours(exchange);
      if (!hours) return 'unknown';
      const dow = dayOfWeekInTZ(hours.tz, at);
      if (dow === 0 || dow === 6) return 'closed';
      const hol = this.getHolidayToday(exchange, at);
      const earlyClose = hol && /early|half/i.test(hol.type || '');
      if (hol && !earlyClose) return 'closed';

      const t = nowHHMMInTZ(hours.tz, at);
      const regularClose = earlyClose ? (hol.closeAt || hours.close) : hours.close;

      if (hours.preOpen && hours.preClose
          && cmpHHMM(t, hours.preOpen) >= 0 && cmpHHMM(t, hours.preClose) < 0) return 'pre';
      if (cmpHHMM(t, hours.open) >= 0 && cmpHHMM(t, regularClose) < 0) {
        if (hours.lunchStart && hours.lunchEnd
            && cmpHHMM(t, hours.lunchStart) >= 0 && cmpHHMM(t, hours.lunchEnd) < 0) return 'lunch';
        return 'regular';
      }
      if (hours.afterOpen && hours.afterClose
          && cmpHHMM(t, hours.afterOpen) >= 0 && cmpHHMM(t, hours.afterClose) < 0) return 'after';
      return 'closed';
    },

    isMarketOpenNow(exchange) {
      const s = this.getCurrentSession(exchange);
      return s === 'regular' || s === 'lunch' || s === 'pre' || s === 'after';
    },

    // Is this quote the PREVIOUS session's, not today's? Before the US open
    // the card said "Down today" over yesterday's −0.81% ("Last quote · Oct 1,
    // 10:29 PM"). True when the quote's date in the
    // exchange's own timezone is before today there and today's session has
    // not started (or the exchange is closed all day). `ts` is seconds or ms.
    isPrevSessionQuote(ts, tz, session, now) {
      const n = Number(ts);
      if (!Number.isFinite(n) || n <= 0) return false;
      if (session === 'regular' || session === 'lunch' || session === 'after') return false;
      const zone = tz || 'UTC';
      const day = (d) => {
        try {
          return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
        } catch (_) { return d.toISOString().slice(0, 10); }
      };
      return day(new Date(n < 4e10 ? n * 1000 : n)) < day(now || new Date());
    },

    isRegularHoursNow(exchange) {
      const s = this.getCurrentSession(exchange);
      return s === 'regular' || s === 'lunch';
    },

    // Which side of today's regular session it is now: 'pre' before the
    // open, 'after' from the close, null in the session, on a day off, or
    // with no hours known. A closed exchange with no extended sessions of
    // its own (LSE) still has a before and an after: a trade the feed
    // reports at 17:29 London is an after-hours print, not a live one.
    // `at` as in getCurrentSession: the side of that moment's session.
    sideOfSession(exchange, at) {
      const s = this.getCurrentSession(exchange, at);
      if (s === 'pre' || s === 'after') return s;
      if (s !== 'closed' || this.is24x7(exchange) || this.isForex(exchange)) return null;
      const hours = this.getRegularHours(exchange);
      if (!hours) return null;
      const dow = dayOfWeekInTZ(hours.tz, at);
      if (dow === 0 || dow === 6) return null;
      const hol = this.getHolidayToday(exchange, at);
      const early = !!(hol && /early|half/i.test(hol.type || ''));
      if (hol && !early) return null;
      const t = nowHHMMInTZ(hours.tz, at);
      if (cmpHHMM(t, hours.open) < 0) return 'pre';
      if (cmpHHMM(t, early ? (hol.closeAt || hours.close) : hours.close) >= 0) return 'after';
      return null;
    },

    // One clock for every screen that shows a session: it fires on the wall
    // clock's half-minutes, so readers that look on it turn together at the
    // open and the close. The asset page read its session once and the pill
    // on a 30-second timer of its own: after the London close the pill said
    // CLOSED while the page went on with "regular". Returns the unsubscribe.
    onClock(cb) {
      if (typeof cb !== 'function') return () => {};
      _clockSubs.add(cb);
      armClock();
      return () => {
        _clockSubs.delete(cb);
        if (!_clockSubs.size && _clockTimer) { clearTimeout(_clockTimer); _clockTimer = null; }
      };
    },
  };

  // Sessions turn on whole minutes; a tick just past each half-minute sees
  // the new one.
  const CLOCK_MS = 30000;
  const _clockSubs = new Set();
  let _clockTimer = null;
  function armClock() {
    if (_clockTimer || !_clockSubs.size) return;
    _clockTimer = setTimeout(() => {
      _clockTimer = null;
      Array.from(_clockSubs).forEach((f) => { try { f(); } catch (_) { /* one reader does not stop the rest */ } });
      armClock();
    }, CLOCK_MS - (Date.now() % CLOCK_MS) + 50);
  }

  window.ExchangeStatus = ExchangeStatus;
})();
