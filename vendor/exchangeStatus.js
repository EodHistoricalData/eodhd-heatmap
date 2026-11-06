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

  const todayISOInTZ = (tz) => {
    try {
      // 'en-CA' yields YYYY-MM-DD reliably. Intl handles DST correctly.
      const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      });
      return fmt.format(new Date());
    } catch (_) {
      return new Date().toISOString().slice(0, 10);
    }
  };

  const nowHHMMInTZ = (tz) => {
    try {
      const fmt = new Intl.DateTimeFormat('en-GB', {
        timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
      });
      return fmt.format(new Date()); // 'HH:MM'
    } catch (_) {
      const d = new Date();
      return d.toTimeString().slice(0, 5);
    }
  };

  const dayOfWeekInTZ = (tz) => {
    // 0=Sun, 1=Mon, ... 6=Sat
    try {
      const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' });
      const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
      return map[fmt.format(new Date())] ?? new Date().getDay();
    } catch (_) {
      return new Date().getDay();
    }
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

    is24x7(exchange) {
      const e = (exchange || '').toUpperCase();
      return e === 'FOREX' || e === 'CC' || e === 'CRYPTO';
    },

    // opts.fresh: ask again when what is kept is a failure (failed() below).
    async load(exchange, apiKey, opts) {
      if (!exchange) return null;
      if (this.is24x7(exchange)) return null;
      const fresh = !!(opts && opts.fresh);
      if (fresh && this.failed(exchange) && !_inflight.has(exchange)) _data.delete(exchange);
      if (_data.has(exchange)) return _data.get(exchange);
      if (_inflight.has(exchange)) return _inflight.get(exchange);

      const p = (async () => {
        const api = window.EODHD_API;
        if (!api || !api.getExchangeHolidaysV2) return null;
        const raw = await api.getExchangeHolidaysV2(apiKey, exchange, fresh ? { fresh: true } : undefined);
        // v2 wraps the payload in { data: {...}, meta: [], links: [] }.
        // The legacy v1 endpoint returns the payload at the root. Unwrap
        // here so the rest of this module can stay agnostic.
        const data = normalisePayload(raw && raw.data && typeof raw.data === 'object' ? raw.data : raw, exchange);
        if (data && !data.error) _data.set(exchange, data);
        return data;
      })();
      _inflight.set(exchange, p);
      try { return await p; } finally { _inflight.delete(exchange); }
    },

    // The payload load() kept, and a way to hand one back: the calendar keeps
    // these for the day so a reload does not ask for three exchanges again.
    peek(exchange) {
      return _data.has(exchange) ? _data.get(exchange) : null;
    },
    prime(exchange, data) {
      if (exchange && data && typeof data === 'object' && !data.error && !_data.has(exchange)) _data.set(exchange, normalisePayload(data, exchange));
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

    getHolidayToday(exchange) {
      const d = this._get(exchange);
      if (!d) return null;
      const hours = this.getRegularHours(exchange);
      const tz = hours ? hours.tz : (d.Timezone || 'UTC');
      const today = todayISOInTZ(tz);
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

    getCurrentSession(exchange) {
      if (this.is24x7(exchange)) return 'regular';
      const hours = this.getRegularHours(exchange);
      if (!hours) return 'unknown';
      const dow = dayOfWeekInTZ(hours.tz);
      if (dow === 0 || dow === 6) return 'closed';
      const hol = this.getHolidayToday(exchange);
      const earlyClose = hol && /early|half/i.test(hol.type || '');
      if (hol && !earlyClose) return 'closed';

      const t = nowHHMMInTZ(hours.tz);
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
  };

  window.ExchangeStatus = ExchangeStatus;
})();
