// Squarified Treemap Algorithm (Bruls, Huizing, van Wijk)
window.SquarifiedTreemap = function(items, rect) {
  if (!items || items.length === 0) return [];
  if (items.length === 1) {
    return [Object.assign({}, items[0], { x: rect.x, y: rect.y, w: rect.w, h: rect.h })];
  }

  // Normalize weights so they sum to the area of the rect
  var totalWeight = items.reduce(function(s, it) { return s + (it.weight || 1); }, 0);
  if (totalWeight <= 0) totalWeight = 1;
  var area = rect.w * rect.h;
  var normalized = items.map(function(it) {
    return Object.assign({}, it, { normWeight: ((it.weight || 1) / totalWeight) * area });
  });

  // Sort descending by weight
  normalized.sort(function(a, b) { return b.normWeight - a.normWeight; });

  var results = [];
  _squarify(normalized, [], rect, results);
  return results;
};

function _worstRatio(row, sideLen) {
  if (row.length === 0 || sideLen <= 0) return Infinity;
  var sumArea = 0;
  for (var i = 0; i < row.length; i++) sumArea += row[i].normWeight;
  var worst = 0;
  for (var j = 0; j < row.length; j++) {
    var a = row[j].normWeight;
    if (a <= 0) continue;
    var r1 = (sideLen * sideLen * a) / (sumArea * sumArea);
    var r2 = (sumArea * sumArea) / (sideLen * sideLen * a);
    var ratio = Math.max(r1, r2);
    if (ratio > worst) worst = ratio;
  }
  return worst;
}

function _layoutRow(row, rect, vertical) {
  var sumArea = 0;
  for (var i = 0; i < row.length; i++) sumArea += row[i].normWeight;
  var results = [];
  if (vertical) {
    var rowWidth = (sumArea / rect.h);
    if (rowWidth <= 0 || !isFinite(rowWidth)) rowWidth = rect.w;
    var y = rect.y;
    for (var j = 0; j < row.length; j++) {
      var h = row[j].normWeight / rowWidth;
      if (!isFinite(h)) h = 0;
      results.push(Object.assign({}, row[j], { x: rect.x, y: y, w: rowWidth, h: h }));
      y += h;
    }
    return { laid: results, remaining: { x: rect.x + rowWidth, y: rect.y, w: rect.w - rowWidth, h: rect.h } };
  } else {
    var rowHeight = (sumArea / rect.w);
    if (rowHeight <= 0 || !isFinite(rowHeight)) rowHeight = rect.h;
    var x = rect.x;
    for (var k = 0; k < row.length; k++) {
      var w = row[k].normWeight / rowHeight;
      if (!isFinite(w)) w = 0;
      results.push(Object.assign({}, row[k], { x: x, y: rect.y, w: w, h: rowHeight }));
      x += w;
    }
    return { laid: results, remaining: { x: rect.x, y: rect.y + rowHeight, w: rect.w, h: rect.h - rowHeight } };
  }
}

function _squarify(items, currentRow, rect, results) {
  if (items.length === 0) {
    if (currentRow.length > 0) {
      var vertical = rect.h < rect.w;
      var sideLen = vertical ? rect.h : rect.w;
      var out = _layoutRow(currentRow, rect, vertical);
      for (var i = 0; i < out.laid.length; i++) results.push(out.laid[i]);
    }
    return;
  }

  if (rect.w <= 0 || rect.h <= 0) {
    // No room left, place remaining items at zero size
    for (var z = 0; z < items.length; z++) {
      results.push(Object.assign({}, items[z], { x: rect.x, y: rect.y, w: 0, h: 0 }));
    }
    return;
  }

  var vertical = rect.h < rect.w;
  var sideLen = vertical ? rect.h : rect.w;

  if (currentRow.length === 0) {
    _squarify(items.slice(1), [items[0]], rect, results);
    return;
  }

  var newRow = currentRow.concat([items[0]]);
  if (_worstRatio(newRow, sideLen) <= _worstRatio(currentRow, sideLen)) {
    // Adding this item improves (or maintains) aspect ratio
    _squarify(items.slice(1), newRow, rect, results);
  } else {
    // Lay out currentRow and recurse with remaining rect
    var out = _layoutRow(currentRow, rect, vertical);
    for (var j = 0; j < out.laid.length; j++) results.push(out.laid[j]);
    _squarify(items, [], out.remaining, results);
  }
}

// The rows an index map is drawn from (every member, not the screener's top
// 500) are built by window.HeatmapMembers in screenerRules.js.

// Heatmap View Component - Concept 3 Glassmorphism

// A change as the tile shows it: rounded to the digits on screen, and a value
// that rounds to zero IS zero -- no "−0.0%" in red beside "+0.0%" in green and
// "+0.0%" in grey for the same unchanged price.
// Rounded as written, half away from zero: toFixed rounds the binary value,
// and 3.65 is stored as 3.6499..., so the same tile read "+3.6%" from the
// screener's 3.65 and "+3.7%" from the real-time 3.6544.
window.HeatmapChange = {
  round(v, digits) {
    const d = digits == null ? 1 : digits;
    const n = +v;
    // On the decimal text, exponent included ("1e-7" + "e1" was NaN).
    const shift = (x, k) => { const s = String(x).split('e'); return Number(s[0] + 'e' + ((Number(s[1]) || 0) + k)); };
    const r = shift(Math.round(shift(Math.abs(n), d)), -d);
    return n < 0 ? -r : r;
  },
  shown(v, digits) {
    if (v == null || v === '' || !Number.isFinite(+v)) return null;
    const r = window.HeatmapChange.round(v, digits);
    return r === 0 ? 0 : r;
  },
  // The day's change of a screener row, from the most precise figures it
  // has: refund_1d_p comes rounded to two decimals, and rounding that again
  // to the one on a tile is a double rounding. The change in money over the
  // previous close (adjusted_close - refund_1d) is the same figure unrounded
  // -- used when it agrees with refund_1d_p, else refund_1d_p as sent.
  ofRow(row) {
    if (!row) return null;
    const p = row.refund_1d_p;
    const pct = p == null || p === '' ? NaN : +p;
    const chg = +row.refund_1d;
    const close = +row.adjusted_close;
    if (Number.isFinite(pct) && Number.isFinite(chg) && Number.isFinite(close) && close - chg > 0) {
      const exact = (chg / (close - chg)) * 100;
      if (Math.abs(exact - pct) <= 0.006) return exact;
    }
    return Number.isFinite(pct) ? pct : null;
  },
  format(v, digits) {
    const d = digits == null ? 1 : digits;
    const r = window.HeatmapChange.shown(v, d);
    if (r == null) return '—';
    return (r > 0 ? '+' : '') + r.toFixed(d) + '%';
  },
};

// Whether the screener rows already ARE the quotes. Outside the trading day a
// real-time quote repeats the last session's close and change, which the
// screener has already sent -- yet the map asked for every visible tile again,
// one API call each: ~30 of the ~46 a first open cost.
// Skipped only when nothing can be newer: no session running, every visible
// row priced, and its date the session that last closed. A doubt (a holiday
// the weekday walk does not know, EOD data not in yet after the close) falls
// on the side of asking.
window.HeatmapQuoteNeed = {
  // Last session the exchange closed, as YYYY-MM-DD in its zone.
  lastClosedSession(todayYmd, tradingToday, afterCloseToday) {
    if (tradingToday && afterCloseToday) return todayYmd;
    const d = new Date(todayYmd + 'T12:00:00Z');
    do { d.setUTCDate(d.getUTCDate() - 1); } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
    return d.toISOString().slice(0, 10);
  },
  screenerIsCurrent(rows, session, lastClosed) {
    if (session !== 'pre' && session !== 'closed') return false;
    if (!Array.isArray(rows) || !rows.length || !lastClosed) return false;
    return rows.every((r) => r && Number.isFinite(+r.adjusted_close) && +r.adjusted_close > 0
      && typeof r.last_day_data_date === 'string' && r.last_day_data_date >= lastClosed);
  },
  // Whether a quote stamped `tsSec` (unix seconds or ms) is a PRE-MARKET print
  // of an exchange with these hours ({tz, open: 'HH:MM[:SS]'}): a weekday,
  // before the open. Regular mode shows the last regular session, and twice
  // before the open the map showed NVDA +1.1 (the pre-market move) under
  // "last session Mon, Oct 5" instead of +2.1. After the close
  // a quote still carries the session's close (its stamp is later), so only
  // the morning side is dropped. Unknown time or hours: false.
  isPreMarketPrint(tsSec, hours) {
    const ts = Number(tsSec);
    if (!Number.isFinite(ts) || ts <= 0 || !hours || !hours.tz || !hours.open) return false;
    try {
      const d = new Date(ts < 4e10 ? ts * 1000 : ts);
      const hhmm = new Intl.DateTimeFormat('en-GB', { timeZone: hours.tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
      const wd = new Intl.DateTimeFormat('en-US', { timeZone: hours.tz, weekday: 'short' }).format(d);
      if (wd === 'Sat' || wd === 'Sun') return false;
      return hhmm < String(hours.open).slice(0, 5);
    } catch (_) { return false; }
  },
};

// Whether an extended-hours print (epoch s or ms) happened today in New York.
// Width of a tile ticker in em, bold caps, per character (W and M are wide,
// I, 1, '.' and '-' narrow). Used to drop a label rather than cut it.
window.HeatmapLabelEm = function (label) {
  var em = 0;
  String(label || '').split('').forEach(function (c) {
    em += /[WM]/.test(c) ? 0.98 : /[I1.\-]/.test(c) ? 0.38 : /[A-Z0-9]/.test(c) ? 0.74 : 0.6;
  });
  return em;
};

window.HeatmapPremarket = {
  isToday(t, now) {
    if (!Number.isFinite(t) || t <= 0) return false;
    const ms = t < 4e10 ? t * 1000 : t;
    const day = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    return day(ms) === day(now == null ? Date.now() : now);
  },
};

// The 429 wait (window.RateLimitWait) is rateLimitWait.js, loaded before this file.

// The heatmap's saved settings, read and checked. A saved index the map does
// not have ("foo") drew a header with no name and no index pressed;
// a view or a limit of the wrong kind went the same way. Each
// is checked here and an unknown one is dropped, so the default stands.
// Storage itself may be blocked (SecurityError: Firefox with storage off,
// Chromium's site-data block) or full (QuotaExceededError): every access is
// guarded, a read finds nothing and a write says it failed.
window.HeatmapPrefs = {
  KEY: 'eodhd_heatmap_prefs',
  get(key) { try { return window.localStorage.getItem(key); } catch (_) { return null; } },
  set(key, value) { try { window.localStorage.setItem(key, value); return true; } catch (_) { return false; } },
  clean(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const ids = window.HeatmapLinkState.HEATMAP_INDEX_IDS;
    const index = typeof raw.selectedIndex === 'string' ? raw.selectedIndex.trim().toLowerCase() : '';
    const out = {};
    if (ids.indexOf(index) !== -1) out.selectedIndex = index;
    if (['treemap', 'sectors', 'grid'].indexOf(raw.viewMode) !== -1) out.viewMode = raw.viewMode;
    const limitOk = (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1000;
    out.limits = {};
    // Old format: a single displayLimit -> per-index limits.
    if (!raw.limits && raw.displayLimit !== undefined && out.selectedIndex && limitOk(raw.displayLimit)) out.limits[out.selectedIndex] = raw.displayLimit;
    if (raw.limits && typeof raw.limits === 'object' && !Array.isArray(raw.limits)) {
      ids.forEach((id) => { if (Object.prototype.hasOwnProperty.call(raw.limits, id) && limitOk(raw.limits[id])) out.limits[id] = raw.limits[id]; });
    }
    return out;
  },
  read() {
    let raw = null;
    try { raw = JSON.parse(window.HeatmapPrefs.get(window.HeatmapPrefs.KEY) || 'null'); } catch (_) { raw = null; }
    return window.HeatmapPrefs.clean(raw);
  },
  write(prefs) {
    let text;
    try { text = JSON.stringify(prefs); } catch (_) { return false; }
    return window.HeatmapPrefs.set(window.HeatmapPrefs.KEY, text);
  },
};

// A heatmap link's values, in any case: "?index=Crypto" (NASDAQ100, DOW30,
// FOREX) silently opened the S&P 500 and the address was rewritten to
// index=sp500, while Indices and News already read links case-blind.
// Spaces, dashes and "&" are dropped too ("S&P500",
// "nasdaq-100"). An index named but not on the map is the default map; one
// not named is null; a session not named stays undefined (the caller's
// "index changed, session back to regular" depends on it). Own ids only:
// "__proto__" opened a nameless map.
window.HeatmapLinkState = function (st) {
  st = st || {};
  var word = function (v) { return typeof v === 'string' ? v.toLowerCase().replace(/[^a-z0-9]/g, '') : ''; };
  var pick = function (v, allowed) { var w = word(v); return allowed.indexOf(w) !== -1 ? w : null; };
  var session = st.session === undefined ? undefined : pick(st.session, ['premarket', 'regular']);
  return {
    index: st.index ? (pick(st.index, window.HeatmapLinkState.HEATMAP_INDEX_IDS) || 'sp500') : null,
    view: pick(st.view, ['treemap', 'sectors', 'grid']),
    session: session,
    // "all" named is kept: it clears Gainers / Losers on a followed link.
    filter: pick(st.filter, ['gainers', 'losers', 'all']),
  };
};
// INDEX_COMPONENTS' keys (it is declared inside the view; a test keeps the
// two the same).
window.HeatmapLinkState.HEATMAP_INDEX_IDS = ['sp500', 'nasdaq100', 'dow30', 'crypto', 'forex'];

window.HeatmapView = ({ heatmapData: rawHeatmapData, loading, onLoadData, onSelectAsset, apiKey, onBack, onUpgradeClick, theme, activeTab, onTabChange, onSettingsClick, initialViewMode, rtOverlay: parentRtOverlay, rtTime, onRtOverlayUpdate, premarketOverlay: parentPremarketOverlay, premarketTime, premarketMeta: parentPremarketMeta, onPremarketUpdate, embedded }) => {
  const HEATMAP_PREFS_KEY = 'eodhd_heatmap_prefs';
  const DEFAULT_LIMIT = 30;
  // The settings as saved (window.HeatmapPrefs.read: checked, storage or no
  // storage).
  const savedPrefs = React.useMemo(() => window.HeatmapPrefs.read(), []);

  const getIndexLimit = (idx) => {
    const saved = savedPrefs.limits?.[idx];
    return (saved !== undefined && saved !== null) ? saved : DEFAULT_LIMIT;
  };

  // The link's state is the first state, not an update after the first
  // render: that render wrote the saved index back into the address
  // ("#/heatmap?index=crypto"), and the hashchange of the typed link, which
  // arrives after it, read that back -- a link followed from another screen
  // opened the last index looked at.
  const urlBoot = React.useMemo(() => window.HeatmapLinkState(window.ViewState ? window.ViewState.read('heatmap') : {}), []);
  const urlIndex = urlBoot.index;
  const initIndex = urlIndex || savedPrefs.selectedIndex || 'sp500';
  const [selectedIndex, setSelectedIndex] = React.useState(initIndex);
  // Gainers / Losers is a look at the map, not a setting: it is no longer
  // restored from the saved preferences (which also sync to every device). A
  // filter picked once and forgotten thinned every index and every later
  // visit -- Crypto "2/20", Forex "5/10", Dow "12/30" -- under a subtitle
  // calling the hidden tiles "without a quote". A link
  // can still carry it (&filter=gainers).
  const [filter, setFilter] = React.useState(urlBoot.filter || 'all');
  const [displayLimit, setDisplayLimit] = React.useState(getIndexLimit(initIndex));
  const [forexCryptoData, setForexCryptoData] = React.useState([]);
  const [loadingForexCrypto, setLoadingForexCrypto] = React.useState(false);
  // The batch quotes as they came back (full objects, previousClose
  // included), keyed by full symbol: LiveQuotes seeds them into DataHub so
  // a streamed tick is measured against the session's previous close.
  const rawQuotesRef = React.useRef({});
  const [rawVersion, setRawVersion] = React.useState(0);
  const [fcTime, setFcTime] = React.useState(0);
  const [viewMode, setViewMode] = React.useState(['treemap', 'sectors', 'grid'].indexOf(urlBoot.view) !== -1 ? urlBoot.view : (initialViewMode || savedPrefs.viewMode || 'treemap'));
  const [sessionMode, setSessionMode] = React.useState(urlBoot.session === 'premarket' ? 'premarket' : 'regular'); // 'regular' | 'premarket'

  // Which map, drawn which way, belongs in the URL. Saved preferences already
  // survive a reload for the person who set them; a link is what lets someone
  // send the screen to somebody else. The URL wins over the saved preference on
  // arrival, because it was chosen by whoever opened the link.
  const bootedFromUrl = React.useRef(false);
  // An index the link names but the map does not have ("?index=foo") opens
  // the default map, not whatever this viewer looked at last: the link's
  // sender cannot know that. The URL is then rewritten to it.
  const applyUrlState = (raw) => {
    // Own keys only: "?index=__proto__" (or constructor, toString) found
    // Object.prototype, passed, and opened a nameless map of the screener's
    // top 500 with OTC names in it. Read case-blind
    // (window.HeatmapLinkState, above).
    const st = window.HeatmapLinkState(raw);
    if (st.index) setSelectedIndex(Object.prototype.hasOwnProperty.call(INDEX_COMPONENTS, st.index) ? st.index : 'sp500');
    if (st.view) setViewMode(st.view);
    if (st.session === 'premarket') setSessionMode('premarket');
    else if (st.session === 'regular' || (st.session === undefined && st.index)) setSessionMode('regular');
    if (st.filter) setFilter(st.filter);
    else if (st.index) setFilter('all');
  };
  React.useEffect(() => {
    if (bootedFromUrl.current) return;
    bootedFromUrl.current = true;
    applyUrlState(window.ViewState ? window.ViewState.read('heatmap') : {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A link followed while the heatmap is already open changes only the hash:
  // nothing re-mounts, so the view listens for it.
  React.useEffect(() => {
    const onHash = () => {
      const VS = window.ViewState;
      if (!VS || typeof VS.splitHash !== 'function') return;
      const parts = VS.splitHash(window.location.hash || '');
      if (parts.tab && parts.tab !== 'heatmap') return;
      applyUrlState(window.ViewState.read('heatmap'));
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    if (!bootedFromUrl.current || !window.ViewState) return;
    window.ViewState.merge({
      index: selectedIndex || '',
      view: viewMode === 'treemap' ? '' : viewMode,        // treemap is the default
      session: sessionMode === 'regular' ? '' : sessionMode,
      filter: filter === 'all' ? '' : filter,
    });
  }, [selectedIndex, viewMode, sessionMode, filter]);

  const premarketMeta = parentPremarketMeta || { lastEthTime: null, tradedCount: 0 };
  const limitsRef = React.useRef(savedPrefs.limits || {});

  // Clear the flag so normal tab clicks use default
  React.useEffect(() => { window._heatmapViewMode = null; }, []);

  // Persist heatmap preferences (per-index limits). Read, merged, written:
  // the whole object went back from memory, so with two tabs open the last
  // to write undid the other's -- Top 100 set on the S&P 500 in one, NASDAQ
  // picked in the other, and the S&P was back to 30. A tab now
  // writes the limit it changed and keeps every other as stored. Storage
  // blocked or full: the settings last for the visit, and a line says so
  // once -- the write threw and the view stopped drawing.
  const [prefsUnsaved, setPrefsUnsaved] = React.useState(false);
  const prefsUnsavedRef = React.useRef(false);
  const persistedRef = React.useRef({ index: selectedIndex, limit: displayLimit });
  React.useEffect(() => {
    // Just switched: this render still holds the previous index's limit; the
    // index's own is set below (and noted in persistedRef there).
    const last = persistedRef.current;
    const switched = last.index !== selectedIndex;
    const limitChanged = !switched && last.limit !== displayLimit;
    persistedRef.current = { index: selectedIndex, limit: switched ? last.limit : displayLimit };
    const stored = window.HeatmapPrefs.read();
    // While writes fail, what this visit chose wins over the store's older
    // values (Top 100 set with storage full came back as 30).
    const limits = prefsUnsavedRef.current
      ? { ...(stored.limits || {}), ...limitsRef.current }
      : { ...limitsRef.current, ...(stored.limits || {}) };
    if (limitChanged || (!switched && limits[selectedIndex] === undefined)) limits[selectedIndex] = displayLimit;
    limitsRef.current = limits;
    const prefs = { selectedIndex, viewMode, limits };
    const wrote = window.HeatmapPrefs.write(prefs);
    prefsUnsavedRef.current = !wrote;
    if (!wrote) setPrefsUnsaved(true);
    try { window.DataSync?.pushSection('preferences', { heatmap_prefs: prefs }); } catch (_) { /* the view keeps working */ }
  }, [selectedIndex, displayLimit, viewMode]);

  const C3 = window.C3;
  const isDark = theme === 'dark';
  // Free in the Mini App is free on the web: Telegram identifies the
  // person by initData and the server serves the same free heatmap (Top 30 by
  // default). Only a Telegram build opened OUTSIDE Telegram, with no key, has
  // nobody to serve and keeps the preview.
  const inTelegram = false; // standalone: there is no Telegram client here
  const isDemo = window.APP_PLATFORM === 'WEB' ? false : (window.EODHD_API.isDemo(apiKey) && !inTelegram);

  const Icon = ({ name, size = 24, color = 'currentColor' }) => {
    return React.createElement('svg', { 'aria-hidden': true, focusable: 'false',
      width: size,
      height: size,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: color,
      strokeWidth: "2",
      strokeLinecap: "round",
      strokeLinejoin: "round"
    }, React.createElement('path', { d: window.IconPaths[name] || "" }));
  };

  // Index configurations.
  //
  // The three stock indices name their `source`: the EODHD index whose
  // fundamentals carry the live constituent list (fundamentals/GSPC.INDX ->
  // Components, 503 rows). Membership is read from there and cached for a day.
  // The tabs used to be nothing of the kind: "S&P 500" was the top 500 US names
  // by market cap and "NASDAQ 100" the top 100 of the same list, NYSE names
  // included, under a header reading "NASDAQ 100 - 30/100 stocks"
  // The Dow was a hard-coded list three changes out of date,
  // with one delisted ticker; the list below is only the fallback for
  // when the fundamentals call fails, and matches DJI.INDX as of 2026-09-04.
  const INDEX_COMPONENTS = {
    sp500: {
      name: 'S&P 500',
      description: 'S&P 500 constituents, every member priced',
      source: 'GSPC.INDX',
      totalCount: 500,
      useAllData: true,
      limitOptions: [{ value: 0, label: 'All' }, { value: 100, label: 'Top 100' }, { value: 50, label: 'Top 50' }, { value: 30, label: 'Top 30' }]
    },
    nasdaq100: {
      name: 'NASDAQ 100',
      description: 'Nasdaq-100 constituents, every member priced',
      source: 'NDX.INDX',
      totalCount: 100,
      useAllData: true,
      limitOptions: [{ value: 0, label: 'All' }, { value: 50, label: 'Top 50' }, { value: 30, label: 'Top 30' }]
    },
    dow30: {
      name: 'Dow 30',
      description: 'Dow Jones Industrial Average constituents',
      source: 'DJI.INDX',
      totalCount: 30,
      symbols: ['AAPL','AMGN','AMZN','AXP','BA','CAT','CRM','CSCO','CVX','DIS','GOOGL','GS','HD','HON','IBM','JNJ','JPM','KO','MCD','MMM','MRK','MSFT','NKE','NVDA','PG','SHW','TRV','UNH','V','WMT'],
      limitOptions: null // No limit options for Dow 30
    },
    crypto: {
      name: 'Crypto',
      description: 'Top cryptocurrencies',
      totalCount: 20,
      type: 'crypto',
      // EODHD's code for Polygon is POL28321 (MATIC-USD and POL-USD both
      // answer "NA"); the label keeps the name people know.
      symbols: ['BTC','ETH','BNB','XRP','SOL','ADA','DOGE','AVAX','DOT','POL28321','LTC','LINK','UNI7083','ATOM','XLM','ALGO','VET','FIL','AAVE','EOS'],
      labels: { POL28321: 'POL', UNI7083: 'UNI' },
      limitOptions: null // No limit options for crypto
    },
    forex: {
      name: 'Forex',
      description: 'Major currency pairs',
      totalCount: 10,
      type: 'forex',
      symbols: ['EURUSD','GBPUSD','USDJPY','USDCHF','AUDUSD','USDCAD','NZDUSD','EURGBP','EURJPY','GBPJPY'],
      limitOptions: null // No limit options for forex
    }
  };

  // Sector colors
  const SECTOR_COLORS = {
    'Technology': '#3b82f6',
    'Healthcare': '#ec4899',
    'Financial Services': '#10b981',
    'Consumer Cyclical': '#f59e0b',
    'Communication Services': '#8b5cf6',
    'Industrials': '#6b7280',
    'Consumer Defensive': '#06b6d4',
    'Energy': '#ef4444',
    'Basic Materials': '#84cc16',
    'Real Estate': '#f97316',
    'Utilities': '#14b8a6',
  };

  // Live constituent lists for the stock indices, keyed by tab, from the
  // index's fundamentals. Cached in localStorage for a day: the list changes a
  // few times a year and the call is metered at ten units.
  const [indexMembers, setIndexMembers] = React.useState({});
  // Per member: name, sector and index weight, plus the index market cap --
  // what a member without a screener row is drawn from (HeatmapMembers).
  const [indexMemberInfo, setIndexMemberInfo] = React.useState({});
  // Whether the member list for an index has been asked for and answered (or
  // failed). The quote fetches wait for it: they went out once on the
  // screener's top 30 and again when the list landed and changed the set by
  // a name or two -- two batch real-time requests (and two us-quote-delayed
  // in Pre-Market) per load, differing in MRK and ORCL.
  const [membersSettled, setMembersSettled] = React.useState({});
  const settleMembers = (key) => setMembersSettled(prev => (prev[key] ? prev : { ...prev, [key]: true }));
  // "Try again" asks for the members again too, when the first asking got
  // none: the effect below ran once per index, so a refused list stayed
  // refused and only the prices were re-asked. Nothing is asked twice -- an
  // index that has its members returns at the effect's first line, and the
  // quotes wait for the list as they do on a first load (membersPending).
  const [membersRetry, setMembersRetry] = React.useState(0);
  // One retry at a time: four quick presses sent four screener requests.
  // And when the retry works the button is gone -- focus goes to the view's
  // heading instead of <body>.
  const [retrying, setRetrying] = React.useState(false);
  const retryRef = React.useRef({ started: false, timer: null, from: null });
  const headingRef = React.useRef(null);
  const finishRetry = () => {
    const r = retryRef.current;
    if (r.timer) { clearTimeout(r.timer); r.timer = null; }
    setRetrying(false);
    setTimeout(() => {
      // The loader replaces the button while it tries. Still refused: the
      // button is back, and takes focus back. It worked: the heading does.
      const lost = document.activeElement === document.body || !document.contains(document.activeElement);
      const back = document.querySelector('[data-heatmap-retry]');
      if (lost && r.from) { const target = back || headingRef.current; if (target) target.focus(); }
      r.from = null;
    }, 0);
  };
  const tryAgain = (e, run) => {
    if (retrying || rlWait.hold()) return;
    const r = retryRef.current;
    r.started = false; r.from = e && e.currentTarget;
    setRetrying(true);
    run();
    // A retry that started nothing (an answer from memory) ends at once.
    r.timer = setTimeout(() => { if (!r.started) finishRetry(); else r.timer = setTimeout(finishRetry, 30000); }, 800);
  };
  // A 429 asks for a minute (RateLimitWait): Try again and Refresh wait it
  // out, with the seconds on the button, and a press inside it
  // says why nothing was sent, as every screen does.
  const rlWait = window.RateLimitWait.useWait();
  const waitLeft = rlWait.left;
  // Not a live region: it counts every second.
  const waitNoteEl = rlWait.note ? <p data-wait-note="true" style={{ margin: '10px 0 0', fontSize: 13, color: isDark ? C3.textDark : C3.textLightTheme }}>{rlWait.note}</p> : null;
  // Why the prices did not load, kept from when they failed
  // (RateLimitWait.failure): the quotes' batch (priceFail) or the screener's
  // rows (EODHD_API.screenerFailure). "Couldn't load prices for this market
  // right now." stood for a 500, a dropped connection and a page that could
  // not be read alike. The limit is named, not "couldn't
  // load" alone; with nothing known, as before.
  const [priceFail, setPriceFail] = React.useState(null);
  const knownFail = priceFail || (window.EODHD_API && window.EODHD_API.screenerFailure ? window.RateLimitWait.failure(window.EODHD_API.screenerFailure) : null);
  const notLoadedText = (knownFail && knownFail.limited) || (!knownFail && waitLeft)
    ? "Couldn't load prices for this market: EODHD's per-minute request limit was reached."
    : knownFail && (knownFail.unreadable || knownFail.status || knownFail.at)
      ? "Couldn't load prices for this market: " + window.RateLimitWait.failReason(knownFail)
      : "Couldn't load prices for this market right now.";
  const retryLabel = waitLeft ? `Try again in ${waitLeft} s` : 'Try again';
  const retryLook = waitLeft ? { background: 'transparent', border: '1px solid ' + (isDark ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.25)'), color: isDark ? C3.textMutedDark : C3.textMutedLight, cursor: 'not-allowed' } : {};
  const retryMembers = () => {
    if (!INDEX_COMPONENTS[selectedIndex]?.source || indexMembers[selectedIndex]) return;
    setMembersSettled(prev => { if (!prev[selectedIndex]) return prev; const next = { ...prev }; delete next[selectedIndex]; return next; });
    setMembersRetry(n => n + 1);
  };
  const membersScopeRef = React.useRef(null);
  const membersSeqRef = React.useRef(0);
  const membersDrawnRef = React.useRef({});
  // The real-time and pre-market loads: Try again re-runs the effect and its
  // cleanup dropped the first request's answer when it came late, the retry
  // failing. An answer counts while the same index,
  // key, session and tiles are on screen; an older one never goes over a
  // newer one's, and a failed load never takes away what arrived.
  const rtGuardRef = React.useRef({ scope: null, seq: 0, servedScope: null, servedSeq: 0, servedAt: 0 });
  const membersPending = !!(INDEX_COMPONENTS[selectedIndex]?.source && !isDemo && apiKey
    && !indexMembers[selectedIndex] && !membersSettled[selectedIndex]);
  React.useEffect(() => {
    const cfg = INDEX_COMPONENTS[selectedIndex];
    if (!cfg?.source || indexMembers[selectedIndex] || isDemo || !apiKey) return;
    // Try again runs this effect anew, and the cleanup used to drop the first
    // asking's answer when it came late, the retry failing. An answer counts while the same index and key are on screen.
    const scope = selectedIndex + '|' + (apiKey || '');
    membersScopeRef.current = scope;
    const onScreen = () => membersScopeRef.current === scope;
    // A newer asking's list already drawn is not replaced by an older one.
    const seq = ++membersSeqRef.current;
    const newerDrawn = () => membersDrawnRef.current[scope] > seq;
    // v2: v1 kept only the codes, and a member needs its name, sector and weight.
    const CACHE_KEY = 'eodhd_heatmap_index_members_v2';
    const today = new Date().toISOString().slice(0, 10);
    let cache = {};
    try { cache = JSON.parse(window.HeatmapPrefs.get(CACHE_KEY) || '{}') || {}; } catch (e) { cache = {}; }
    const hit = cache[cfg.source];
    if (hit && hit.date === today && Array.isArray(hit.codes) && hit.codes.length) {
      setIndexMembers(prev => ({ ...prev, [selectedIndex]: hit.codes }));
      setIndexMemberInfo(prev => ({ ...prev, [selectedIndex]: hit.info || null }));
      settleMembers(selectedIndex);
      return;
    }
    const key = selectedIndex;
    (async () => {
      try {
        const data = await window.EODHD_API.getFundamentals(apiKey, cfg.source);
        const comps = Object.values((data && data.Components) || {}).filter(c => c && c.Code);
        const codes = comps.map(c => c.Code);
        if (!onScreen() || newerDrawn()) return;
        if (codes.length === 0) { settleMembers(key); return; }
        membersDrawnRef.current[scope] = seq;
        const info = { indexMcap: Number(data.General && data.General.MarketCap) || 0, byCode: {} };
        comps.forEach(c => { info.byCode[c.Code] = { name: c.Name, sector: c.Sector, weight: Number(c.Weight) || 0 }; });
        setIndexMembers(prev => ({ ...prev, [key]: codes }));
        setIndexMemberInfo(prev => ({ ...prev, [key]: info }));
        settleMembers(key);
        try {
          cache[cfg.source] = { date: today, codes, info };
          window.HeatmapPrefs.set(CACHE_KEY, JSON.stringify(cache));
        } catch (e) { /* cache is a convenience */ }
      } catch (e) {
        // No list: the tab falls back to the static Dow list or the top-N
        // ordering, and the header count says how many tiles that is.
        if (onScreen()) settleMembers(key);
      }
    })();
    return () => { if (membersScopeRef.current === scope) membersScopeRef.current = null; };
  }, [selectedIndex, apiKey, membersRetry]);

  // null at first: the saved limit is checked against the index's options on
  // arrival too, not only on a switch -- a saved 999 was used as it was.
  const prevIndexRef = React.useRef(null);
  React.useEffect(() => {
    const cfg = INDEX_COMPONENTS[selectedIndex];
    if ((cfg?.type === 'forex' || cfg?.type === 'crypto') && !isDemo) {
      loadForexCryptoData(cfg);
    }
    // On index change: restore saved limit for that index (or default 30).
    // As stored now, when there is a store: another tab may have set it.
    if (prevIndexRef.current !== selectedIndex) {
      const first = prevIndexRef.current === null;
      const stored = window.HeatmapPrefs.read().limits || {};
      const mine = limitsRef.current[selectedIndex];
      const savedLimit = first ? displayLimit
        : (prefsUnsavedRef.current && mine !== undefined) ? mine
          : (stored[selectedIndex] !== undefined ? stored[selectedIndex] : mine);
      let newLimit = (savedLimit !== undefined && savedLimit !== null) ? savedLimit : DEFAULT_LIMIT;
      // Validate limit is valid for this index's options
      const opts = cfg?.limitOptions;
      if (opts && !opts.some(o => o.value === newLimit)) {
        newLimit = DEFAULT_LIMIT;
        if (!opts.some(o => o.value === newLimit)) newLimit = 0;
      }
      setDisplayLimit(newLimit);
      if (!first) persistedRef.current = { index: selectedIndex, limit: newLimit };
      prevIndexRef.current = selectedIndex;
    }
  }, [selectedIndex, apiKey]);

  const loadForexCryptoData = async (cfg) => {
    setLoadingForexCrypto(true);
    setForexCryptoData([]);
    try {
      // Was: serial getRealTimeData per symbol (~10 awaits, 3-5s).
      // Now: one getBatchRealTime call (EODHD batch endpoint via ?s= multi-
      // symbol). Same payload, ~10× faster for forex/crypto refresh.
      const fullSymbols = cfg.symbols.map(s =>
        cfg.type === 'crypto' ? `${s}-USD.CC` : `${s}.FOREX`);
      const batch = await window.EODHD_API.getBatchRealTime(apiKey, fullSymbols);
      setPriceFail(batch && batch._failed && !Object.keys(batch).length ? window.RateLimitWait.failure(batch._failed) : null);
      const results = cfg.symbols.map(sym => {
        const fullSymbol = cfg.type === 'crypto' ? `${sym}-USD.CC` : `${sym}.FOREX`;
        const d = (batch && (batch[fullSymbol] || batch[sym])) || null;
        if (d) rawQuotesRef.current[fullSymbol] = d;
        const close = d ? parseFloat(d.close) : NaN;
        const change = d ? parseFloat(d.change_p) : NaN;
        return {
          code: sym,
          name: (cfg.labels && cfg.labels[sym]) || sym,
          label: (cfg.labels && cfg.labels[sym]) || sym,
          close: Number.isFinite(close) ? close : null,
          // No quote is no change, not a flat day (drawn "—", not "+0.0%").
          change_p: Number.isFinite(change) ? change : null,
          unpriced: !Number.isFinite(close),
        };
      });
      setForexCryptoData(results);
      setFcTime(Date.now());
      setRawVersion(v => v + 1);
      if (!results.some(r => !r.unpriced)) console.warn('[heatmap] no quotes came back for', cfg.name);
    } catch (e) { console.error('[heatmap] quote batch failed:', e); }
    setLoadingForexCrypto(false);
  };

  const screenerRows = React.useMemo(() => {
    if (!rawHeatmapData) return [];
    if (Array.isArray(rawHeatmapData)) return rawHeatmapData;
    if (rawHeatmapData.data && Array.isArray(rawHeatmapData.data)) return rawHeatmapData.data;
    return [];
  }, [rawHeatmapData]);

  // The base rows: the index's members when its list is known (every member,
  // screener row or not -- see HeatmapMembers), the screener rows otherwise.
  const screenerData = React.useMemo(() => {
    const cfg = INDEX_COMPONENTS[selectedIndex];
    if (cfg?.source && indexMembers[selectedIndex]) {
      const rows = window.HeatmapMembers.rowsFor(indexMembers[selectedIndex], indexMemberInfo[selectedIndex], screenerRows);
      if (rows) return rows;
    }
    return screenerRows;
  }, [screenerRows, selectedIndex, indexMembers, indexMemberInfo]);

  // Real-time overlay: lifted to parent (app.js) so it persists across tab switches
  const rtOverlay = parentRtOverlay || {};
  const premarketOverlay = parentPremarketOverlay || {};
  const effectiveOverlay = sessionMode === 'premarket' ? premarketOverlay : rtOverlay;
  const [rtLoading, setRtLoading] = React.useState(false);
  const rtLoadingStartRef = React.useRef(0);

  const [rtTrigger, setRtTrigger] = React.useState(0);
  // Set once the exchange's hours are in (or did not come), so the subtitle
  // (prevSessionInfo) re-reads the session even when the banner stays empty,
  // and the real-time overlay is decided on them (below).
  const [exLoaded, setExLoaded] = React.useState(null);

  // Compute the symbols actually visible on the current heatmap. Used both
  // by the live-overlay fetch (so Dow30 doesn't fetch 500 quotes when 30
  // are visible) and by refreshRealTime (so Crypto/Forex don't trigger a
  // pointless US-stocks refetch).
  const computeVisibleSymbols = React.useCallback(() => {
    const cfg = INDEX_COMPONENTS[selectedIndex];
    if (!cfg) return [];
    if (cfg.type === 'forex') return cfg.symbols.map(s => s + '.FOREX');
    if (cfg.type === 'crypto') return cfg.symbols.map(s => s + '-USD.CC');
    // Stocks. With the index's member list known, only members that the
    // screener priced are visible; the static Dow list stands in until then.
    // Cap to displayLimit so we don't fetch quotes the user can't see.
    const members = indexMembers[selectedIndex] || cfg.symbols;
    if (members && members.length > 0 && !screenerData.length) {
      return members.map(s => s + '.US');
    }
    let sorted = [...screenerData].sort((a, b) =>
      (b.market_capitalization || 0) - (a.market_capitalization || 0));
    if (members && members.length > 0) {
      const set = new Set(members);
      sorted = sorted.filter(item => set.has(item.code));
    }
    let cap = displayLimit && displayLimit > 0 ? displayLimit : sorted.length;
    if (selectedIndex === 'nasdaq100' && !indexMembers[selectedIndex]) cap = Math.min(cap || 100, 100);
    return sorted.slice(0, cap).map(item => (item.code || '') + '.US').filter(s => s.length > 3);
  }, [selectedIndex, screenerData, displayLimit, indexMembers]);

  const retryBusy = !!(loading || rtLoading || loadingForexCrypto || membersPending);
  React.useEffect(() => {
    if (!retrying) return;
    if (retryBusy) { retryRef.current.started = true; return; }
    if (retryRef.current.started) finishRetry();
  }, [retrying, retryBusy]);
  const refreshRealTime = () => {
    const cfg = INDEX_COMPONENTS[selectedIndex];
    // Forex / Crypto own their state via loadForexCryptoData. Bumping
    // rtTrigger here used to refetch 500 US stocks while the visible
    // forex/crypto data sat untouched — exactly the user-reported "click
    // refresh on Crypto, nothing happens but US burns quota" bug.
    if (cfg?.type === 'forex' || cfg?.type === 'crypto') {
      if (window.CacheManager) {
        cfg.symbols.forEach(sym => {
          const fullSymbol = cfg.type === 'crypto' ? `${sym}-USD.CC` : `${sym}.FOREX`;
          window.CacheManager._store.delete(`realtime::${fullSymbol}`);
        });
      }
      loadForexCryptoData(cfg);
      return;
    }
    // Stocks: invalidate only the visible-index symbols, then nudge the
    // rt effect to refetch. Other indices' caches stay warm so a tab
    // switch back to S&P doesn't pay another 5s round trip.
    if (window.CacheManager) {
      const visible = computeVisibleSymbols();
      visible.forEach(sym => {
        window.CacheManager._store.delete(`realtime::${sym}`);
        window.CacheManager._store.delete(`extquote::${sym}`);
      });
    }
    setRtTrigger(prev => prev + 1);
  };

  // Minimum 400ms visible spin so refresh click always gives feedback
  const setRtLoadingGated = (loading) => {
    if (loading) {
      rtLoadingStartRef.current = Date.now();
      setRtLoading(true);
    } else {
      const elapsed = Date.now() - rtLoadingStartRef.current;
      const wait = Math.max(0, 400 - elapsed);
      if (wait > 0) setTimeout(() => setRtLoading(false), wait);
      else setRtLoading(false);
    }
  };

  // Mode switch. Both fetch effects below already run on a sessionMode change;
  // bumping rtTrigger here as well ran the Pre-Market one twice per click --
  // two us-quote-delayed requests per switch. The bump is kept only where the
  // regular effect would not run without it (it waits for rtTrigger > 0).
  React.useEffect(() => {
    if (sessionMode !== 'regular' || rtTrigger > 0) return;
    const age = rtTime ? Date.now() - rtTime : Infinity;
    const hasData = Object.keys(effectiveOverlay).length > 0;
    if (!hasData || age > 120000) {
      setRtTrigger(prev => prev + 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionMode]);

  // First visit today: force fresh screener data + immediate RT update
  React.useEffect(() => {
    const LAST_VISIT_KEY = 'eodhd_heatmap_last_visit';
    const today = new Date().toDateString();
    // Without storage every visit is the first of the day.
    const lastVisit = window.HeatmapPrefs.get(LAST_VISIT_KEY);
    const isFirstToday = lastVisit !== today;
    if (isFirstToday) {
      window.HeatmapPrefs.set(LAST_VISIT_KEY, today);
      // Clear screener cache so fresh data is fetched
      if (window.CacheManager) {
        window.CacheManager._store.forEach((_, key) => {
          if (key.startsWith('screener::')) window.CacheManager._store.delete(key);
        });
      }
      // Force fresh base data load
      if (onLoadData) onLoadData();
    }
    // Always trigger RT refresh on mount if stale or missing
    const age = rtTime ? Date.now() - rtTime : Infinity;
    const hasData = Object.keys(rtOverlay).length > 0;
    if (!hasData || age > 60000) {
      setRtTrigger(prev => prev + 1);
    }
  }, []); // only on mount

  // The visible screener rows, when they already hold the last session's
  // close and change and no session is running (window.HeatmapQuoteNeed);
  // null when real-time quotes could say something newer.
  const screenerCoversQuotes = React.useCallback(() => {
    const cfg = INDEX_COMPONENTS[selectedIndex];
    if (!cfg || cfg.type === 'forex' || cfg.type === 'crypto') return null;
    const ES = window.ExchangeStatus;
    const ex = cfg.exchange || 'US';
    if (!ES || !(ES.isLoaded && ES.isLoaded(ex))) return null;
    const hours = ES.getRegularHours(ex);
    if (!hours || !hours.tz || !hours.close) return null;
    const session = ES.getCurrentSession(ex);
    let todayYmd, hhmm;
    try {
      todayYmd = new Intl.DateTimeFormat('en-CA', { timeZone: hours.tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      hhmm = new Intl.DateTimeFormat('en-GB', { timeZone: hours.tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
    } catch (_) { return null; }
    const dow = new Date(todayYmd + 'T12:00:00Z').getUTCDay();
    const hol = ES.getHolidayToday ? ES.getHolidayToday(ex) : null;
    const tradingToday = dow !== 0 && dow !== 6 && !(hol && !/early|half/i.test(hol.type || ''));
    const closeAt = (ES.getCloseTimeToday && ES.getCloseTimeToday(ex)) || hours.close.slice(0, 5);
    const lastClosed = window.HeatmapQuoteNeed.lastClosedSession(todayYmd, tradingToday, hhmm >= closeAt);
    const visible = new Set(computeVisibleSymbols().map(s => s.split('.')[0]));
    const rows = screenerData.filter(r => r && visible.has(r.code));
    if (rows.length < visible.size) return null;          // a tile the screener did not price
    return window.HeatmapQuoteNeed.screenerIsCurrent(rows, session, lastClosed) ? rows : null;
  }, [selectedIndex, screenerData, computeVisibleSymbols]);

  // RT overlay fetch — also triggers when screenerData first arrives.
  // Forex / crypto have their own loader (loadForexCryptoData), so this
  // effect handles US stock indices only.
  React.useEffect(() => {
    if (sessionMode !== 'regular') return;
    const cfg = INDEX_COMPONENTS[selectedIndex];
    if (cfg?.type === 'forex' || cfg?.type === 'crypto') return;
    if (!screenerData.length || !apiKey || rtTrigger === 0) return;
    // Decided once the exchange's status is in (exLoaded, below), answered
    // or failed: before it, screenerCoversQuotes could not tell and the
    // real-time quotes went over the screener's rows, after it they did not
    // -- which source a tile showed depended on which came first.
    const ESd = window.ExchangeStatus;
    if (ESd && ESd.load && exLoaded !== ((cfg && cfg.exchange) || 'US')) return;
    if (screenerCoversQuotes()) {                          // nothing newer to ask for
      // ...and an overlay left from an earlier session would sit on top of
      // the rows that are now current: drop it.
      if (Object.keys(rtOverlay).length && onRtOverlayUpdate) onRtOverlayUpdate({});
      return;
    }
    // And for the screener rows: drawn from the member list alone the order
    // is index weight, and the screener caps re-order it -- a second batch.
    if (membersPending || loading) return;
    const g = rtGuardRef.current;
    const seq = ++g.seq;
    const startedAt = Date.now();
    let scope = null;
    const onScreen = () => g.scope === scope;
    (async () => {
      setRtLoadingGated(true);
      try {
        // Was: always fetch the first 500 symbols regardless of which
        // index was active — Dow30 paid for 470 wasted quotes, NASDAQ-100
        // paid for 400. Now: fetch only what's visible.
        // One request per set, whatever order the set was built in: sorted and
        // deduplicated, so two loads of the same tiles are the same batch and
        // an in-flight one is joined, not repeated.
        const symbols = [...new Set(computeVisibleSymbols())].sort();
        scope = ['rt', selectedIndex, apiKey, symbols.join(',')].join('|');
        g.scope = scope;

        // Was: sequential for-loop of 10 × 50-symbol batches (≈ 5s).
        // Now: parallel Promise.all — EODHD batch endpoint handles
        // concurrent calls fine, the bottleneck is round-trip latency,
        // and 10× fewer round trips means an order of magnitude faster.
        const BATCH = 50;
        const chunks = [];
        for (let i = 0; i < symbols.length; i += BATCH) chunks.push(symbols.slice(i, i + BATCH));
        let batchFailed = null;
        const batchResults = await Promise.all(
          chunks.map(c => window.EODHD_API.getBatchRealTime(apiKey, c).then((b) => {
            if (b && b._failed && !Object.keys(b).length) batchFailed = batchFailed || b._failed;
            return b;
          }, (e) => { batchFailed = batchFailed || e || {}; return {}; }))
        );
        if (!onScreen()) return;
        const overlay = {};
        const ESx = window.ExchangeStatus;
        const exCode = (cfg && cfg.exchange) || 'US';
        // On a cold open the hours may not be in yet, and without them nothing
        // can be judged pre-market: wait for them first.
        if (ESx && ESx.load && ESx.isLoaded && !ESx.isLoaded(exCode)) {
          try { await ESx.load(exCode, apiKey); } catch (_) {}
          if (!onScreen()) return;
        }
        const regHours = ESx && ESx.getRegularHours ? ESx.getRegularHours(exCode) : null;
        batchResults.forEach(batch => {
          Object.entries(batch || {}).forEach(([key, q]) => {
            if (!q) return;
            // Regular mode shows the regular session: an extended-hours print
            // is not this view's number.
            if (window.HeatmapQuoteNeed.isPreMarketPrint(q.timestamp, regHours)) return;
            const code = key.includes('.') ? key.split('.')[0] : key;
            rawQuotesRef.current[key.includes('.') ? key : key + '.US'] = q;
            overlay[code] = {
              change_p: parseFloat(q.change_p || q.change_percent || 0),
              close: q.close || 0,
            };
          });
        });
        const gotAny = Object.keys(overlay).length > 0;
        // Why nothing came back, for the line under the map; a price that
        // did come back clears it.
        setPriceFail(gotAny || !batchFailed ? null : window.RateLimitWait.failure(batchFailed));
        // A newer answer is on screen already: this one is older.
        if (g.servedScope === scope && g.servedSeq > seq) { if (seq === g.seq) setRtLoadingGated(false); return; }
        // Nothing came back, and prices that arrived while this ran stay.
        if (!gotAny && g.servedScope === scope && g.servedAt >= startedAt) { if (seq === g.seq) setRtLoadingGated(false); return; }
        if (gotAny) { g.servedScope = scope; g.servedSeq = seq; g.servedAt = Date.now(); }
        if (onRtOverlayUpdate) onRtOverlayUpdate(overlay);
        setRawVersion(v => v + 1);
      } catch (e) {}
      // An older load answering late leaves the newer one's loading alone.
      if (onScreen() && seq === g.seq) setRtLoadingGated(false);
    })();
    return () => { if (g.scope === scope) g.scope = null; };
  }, [rtTrigger, screenerData.length, apiKey, sessionMode, selectedIndex, displayLimit, computeVisibleSymbols, membersPending, loading, screenerCoversQuotes, exLoaded]);

  // Live prices on top of the snapshot:
  // the heatmap never streamed, even on a paid key. The largest tiles (stocks:
  // by market cap, computeVisibleSymbols' order) or every pair/coin stream
  // through wsBridge, up to LiveQuotes' budget; the rest keep the snapshot.
  // Regular session only — the pre-market view is a delayed feed of its own.
  const overlayRef = React.useRef(rtOverlay);
  overlayRef.current = rtOverlay;
  const watchedRef = React.useRef([]);
  const [feed, setFeed] = React.useState('unknown');
  React.useEffect(() => {
    const LQ = window.LiveQuotes;
    watchedRef.current = [];
    if (!LQ || !apiKey || sessionMode !== 'regular' || rawVersion === 0) return;
    const cfg = INDEX_COMPONENTS[selectedIndex];
    if (!cfg) return;
    const isFC = cfg.type === 'forex' || cfg.type === 'crypto';
    // Before the open the trades feed carries pre-market prints; Regular mode
    // is the last regular session. After the close the feed is
    // quiet anyway.
    if (!isFC) {
      const ESw = window.ExchangeStatus;
      const sess = ESw && ESw.getCurrentSession ? ESw.getCurrentSession(cfg.exchange || 'US') : null;
      if (sess === 'pre') return;
    }
    const full = (sym) => (cfg.type === 'crypto' ? `${sym}-USD.CC` : `${sym}.FOREX`);
    const symbols = isFC ? cfg.symbols.map(full) : computeVisibleSymbols();
    if (!symbols.length) return;
    watchedRef.current = symbols.slice(0, LQ.DEFAULT_MAX);
    const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
    return LQ.watch(symbols.map(symbol => ({ symbol, quote: rawQuotesRef.current[symbol] })), (batch) => {
      if (isFC) {
        setForexCryptoData(prev => prev.map(r => {
          const t = batch[full(r.code)];
          if (!t || num(t.close) == null) return r;
          return { ...r, close: num(t.close), change_p: num(t.change_p) != null ? num(t.change_p) : r.change_p, unpriced: false };
        }));
        return;
      }
      if (!onRtOverlayUpdate) return;
      const next = { ...overlayRef.current };
      Object.keys(batch).forEach(sym => {
        const t = batch[sym];
        const code = sym.split('.')[0];
        if (num(t.close) == null) return;
        next[code] = { change_p: num(t.change_p) != null ? num(t.change_p) : (next[code] ? next[code].change_p : null), close: num(t.close) };
      });
      onRtOverlayUpdate(next);
    }, { max: LQ.DEFAULT_MAX });
    // computeVisibleSymbols is read when the snapshot changes (rawVersion),
    // not on every tick that re-creates it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIndex, sessionMode, apiKey, rawVersion]);
  // What the prices are, by the feed actually behind them: "Live"
  // only while symbols stream; "Delayed" when the key has no real-time
  // feed; otherwise the snapshot's time.
  React.useEffect(() => {
    const read = () => setFeed(window.LiveQuotes ? window.LiveQuotes.feedState(watchedRef.current) : 'unknown');
    const first = setTimeout(read, 4000);   // give wsBridge its auth probe first
    const id = setInterval(read, 5000);
    return () => { clearTimeout(first); clearInterval(id); };
  }, [selectedIndex, rawVersion, sessionMode]);

  // Pre-Market overlay fetch — uses EODHD Live API v2 (/api/us-quote-delayed, ~15min delayed)
  // Only for US stock indices (Forex/Crypto are 24/7). %change computed vs previousClose.
  React.useEffect(() => {
    if (sessionMode !== 'premarket') return;
    const cfg = INDEX_COMPONENTS[selectedIndex];
    if (!cfg || cfg.type === 'forex' || cfg.type === 'crypto') return;
    if (!screenerData.length || !apiKey) return;
    // And for the screener rows: drawn from the member list alone the order
    // is index weight, and the screener caps re-order it -- a second batch.
    if (membersPending || loading) return;
    const g = rtGuardRef.current;
    const seq = ++g.seq;
    const startedAt = Date.now();
    let scope = null;
    const onScreen = () => g.scope === scope;
    (async () => {
      setRtLoadingGated(true);
      try {
        // One request per set, whatever order the set was built in: sorted and
        // deduplicated, so two loads of the same tiles are the same batch and
        // an in-flight one is joined, not repeated.
        const symbols = [...new Set(computeVisibleSymbols())].sort();
        scope = ['pm', selectedIndex, apiKey, symbols.join(',')].join('|');
        g.scope = scope;
        const batch = (await window.EODHD_API.getExtendedQuotes(apiKey, symbols)) || {};
        if (!onScreen()) return;
        const overlay = {};
        let maxEthTime = 0;
        let traded = 0;
        // Seed every symbol as "no pre-market trade" (change null, drawn
        // neutral "—"), never with the regular session's move.
        symbols.forEach(s => {
          const code = s.includes('.') ? s.split('.')[0] : s;
          overlay[code] = { change_p: null, close: 0 };
        });
        // us-quote-delayed answers { data: { "AAPL.US": {ethPrice, ethVolume,
        // ethTime, previousClosePrice, ...} } } -- previousClosePrice, not
        // previousClose (every tile read 0).
        Object.entries(batch).forEach(([key, q]) => {
          if (!q) return;
          const code = key.includes('.') ? key.split('.')[0] : key;
          const ethPrice = parseFloat(q.ethPrice);
          const prevClose = parseFloat(q.previousClosePrice ?? q.previousClose);
          if (!isFinite(ethPrice) || !isFinite(prevClose) || prevClose <= 0) return;
          const ethVol = parseFloat(q.ethVolume) || 0;
          if (ethVol <= 0) return; // no premarket trade -- stays "—"
          // A pre-market trade is today's: the last extended-hours print can
          // be yesterday's close, and JNJ / MA read yesterday's move under
          // "Pre-Market".
          const ethTime = parseInt(q.ethTime, 10);
          if (!window.HeatmapPremarket.isToday(ethTime)) return;
          const change_p = ((ethPrice - prevClose) / prevClose) * 100;
          overlay[code] = { change_p, close: ethPrice };
          if (isFinite(ethTime) && ethTime > maxEthTime) maxEthTime = ethTime;
          traded++;
        });
        const gotAny = Object.keys(batch).length > 0;
        if (g.servedScope === scope && g.servedSeq > seq) { if (seq === g.seq) setRtLoadingGated(false); return; }
        if (!gotAny && g.servedScope === scope && g.servedAt >= startedAt) { if (seq === g.seq) setRtLoadingGated(false); return; }
        if (gotAny) { g.servedScope = scope; g.servedSeq = seq; g.servedAt = Date.now(); }
        if (onPremarketUpdate) {
          // No quote at all back: the feed failed or was refused. Say so
          // rather than let the tiles read as "nothing traded".
          onPremarketUpdate(overlay, { lastEthTime: maxEthTime || null, tradedCount: traded, failed: Object.keys(batch).length === 0 });
        }
      } catch (e) {}
      if (onScreen() && seq === g.seq) setRtLoadingGated(false);
    })();
    return () => { if (g.scope === scope) g.scope = null; };
  }, [sessionMode, rtTrigger, screenerData.length, apiKey, selectedIndex, indexMembers, membersPending, loading]);

  // Merge screener metadata with real-time change_p (uses effective overlay per sessionMode)
  const heatmapData = React.useMemo(() => {
    if (!screenerData.length) return [];
    // Pre-Market shows pre-market changes only. Without an overlay it used to
    // fall through to the regular session's numbers under a "Pre-Market"
    // label.
    if (sessionMode === 'premarket') {
      return screenerData.map(item => {
        const rt = effectiveOverlay[item.code];
        return { ...item, change_p: rt ? rt.change_p : null, close: (rt && rt.close) || item.close, _premarket: true };
      });
    }
    if (!Object.keys(effectiveOverlay).length) return screenerData;
    return screenerData.map(item => {
      const rt = effectiveOverlay[item.code];
      if (!rt) return item;
      return { ...item, change_p: rt.change_p, close: rt.close || item.close, _fromIndex: false };
    });
  }, [screenerData, effectiveOverlay, sessionMode]); // effectiveOverlay, not rtOverlay: the memo reads the former

  // The day's change, or null when nothing priced the row. A missing quote
  // was `?? 0`, so a refused price feed drew a full map of "+0.0%" tiles and
  // green "+0.00%" top movers.
  const getChangePercent = (item) => {
    if (!item._premarket && item.change_p == null) return window.HeatmapChange.ofRow(item);
    const val = item.change_p;
    if (val == null || val === '') return null;
    const n = typeof val === 'number' ? val : parseFloat(val);
    return Number.isFinite(n) ? n : null;
  };
  const fmtChange = (v, digits) => window.HeatmapChange.format(v, digits);
  // Text colour for a change: the light theme gets the darker inks (#21CE99
  // on white is 2.03:1); no change / no quote is muted, not green.
  const changeInk = (raw) => { const v = window.HeatmapChange.shown(raw, 2); return (v == null || v === 0)
    ? (isDark ? C3.textMutedDark : C3.textMutedLight)
    : v > 0 ? (isDark ? C3.success : (C3.successLight || '#047857'))
      // #f23645 on the dark card read 4.46:1; lifted until it reads.
      : (isDark ? (window.A11yColor ? window.A11yColor.text(C3.error, true) : C3.error) : (C3.errorLight || '#c81e2c')); };

  // What the map would show with no Gainers/Losers filter; the filter is
  // applied on top (below), so the subtitle can tell "hidden by the filter"
  // from "no quote".
  const unfilteredData = React.useMemo(() => {
    const cfg = INDEX_COMPONENTS[selectedIndex];
    if (cfg?.type === 'forex' || cfg?.type === 'crypto') {
      const data = [...forexCryptoData];
      return data.sort((a, b) => Math.abs(getChangePercent(b)) - Math.abs(getChangePercent(a)));
    }
    if (!heatmapData.length) return [];
    let data = [...heatmapData];

    // Members of the index, when the list is known; the static Dow list until
    // then. Without a list the S&P and Nasdaq tabs fall back to top-N below.
    const members = indexMembers[selectedIndex] || cfg?.symbols;
    if (members && members.length > 0) {
      const set = new Set(members);
      data = data.filter(item => set.has(item.code));
    }

    // Sort by market cap
    data.sort((a, b) => (b.market_capitalization || 0) - (a.market_capitalization || 0));

    // Only without a member list: the top-N stand-in for an index we could
    // not read the constituents of.
    if (selectedIndex === 'nasdaq100' && !indexMembers[selectedIndex]) {
      data = data.slice(0, 100);
    }

    // Apply display limit if set
    if (displayLimit > 0) {
      data = data.slice(0, displayLimit);
    } else if (cfg?.totalCount && cfg.useAllData && !indexMembers[selectedIndex]) {
      data = data.slice(0, cfg.totalCount);
    }

    return data;
  }, [heatmapData, forexCryptoData, selectedIndex, displayLimit, indexMembers]);

  // Gainers / Losers among the tiles the map shows (the top-N included).
  const filteredData = React.useMemo(() => {
    if (filter === 'gainers') return unfilteredData.filter(d => getChangePercent(d) > 0);
    if (filter === 'losers') return unfilteredData.filter(d => getChangePercent(d) < 0);
    return unfilteredData;
  }, [unfilteredData, filter]);

  // Group data by sector
  const sectorData = React.useMemo(() => {
    const sectors = {};
    filteredData.forEach(item => {
      const sector = item.sector || 'Other';
      if (!sectors[sector]) {
        sectors[sector] = { name: sector, stocks: [], totalChange: 0, priced: 0 };
      }
      sectors[sector].stocks.push(item);
      const c = getChangePercent(item);
      if (c != null) { sectors[sector].totalChange += c; sectors[sector].priced += 1; }
    });

    // Average change per sector, over the priced members only (null if none)
    Object.values(sectors).forEach(sector => {
      sector.avgChange = sector.priced > 0 ? sector.totalChange / sector.priced : null;
    });

    // Sort sectors by average change, unpriced sectors last
    return Object.values(sectors).sort((a, b) => (b.avgChange ?? -Infinity) - (a.avgChange ?? -Infinity));
  }, [filteredData]);

  // 2-level treemap data: sectors -> stocks
  const treemapLayout = React.useMemo(() => {
    if (filteredData.length === 0) return { sectors: [], tiles: [] };

    const isDesktop = window.innerWidth > 768;
    const containerH = isDesktop ? 500 : 400;
    // Approximate container width - will be updated via ref, but use a reasonable default
    const containerW = Math.min(window.innerWidth - 40, 800);

    // Group by sector, compute total market cap per sector
    const sectorMap = {};
    filteredData.forEach(item => {
      const sector = item.sector || 'Other';
      if (!sectorMap[sector]) {
        sectorMap[sector] = { name: sector, stocks: [], totalMcap: 0 };
      }
      const mcap = item.market_capitalization || 1;
      sectorMap[sector].stocks.push(item);
      sectorMap[sector].totalMcap += mcap;
    });

    // Build sector items for top-level treemap
    const sectorItems = Object.values(sectorMap).map(s => ({
      symbol: s.name,
      weight: s.totalMcap,
      _sectorData: s
    }));

    // Run squarified treemap for sectors
    const sectorRects = window.SquarifiedTreemap(sectorItems, { x: 0, y: 0, w: containerW, h: containerH });

    // For each sector rect, run squarified treemap for its stocks
    var allTiles = [];
    var sectorLabels = [];

    sectorRects.forEach(sr => {
      var sd = sr._sectorData;
      if (!sd || sr.w < 1 || sr.h < 1) return;

      sectorLabels.push({
        name: sd.name,
        x: sr.x,
        y: sr.y,
        w: sr.w,
        h: sr.h
      });

      // Build stock items
      var stockItems = sd.stocks.map(item => ({
        symbol: item.code,
        weight: item.market_capitalization || 1,
        changeP: getChangePercent(item),
        sector: sd.name,
        name: item.name || item.code,
        label: item.name && item.name !== item.code && item.name.length <= 8 ? item.name : item.code,
        code: item.code
      }));

      // Sub-layout inside sector rect (with a small inset for sector label)
      var labelInset = sr.h > 20 ? 14 : 0;
      var subRect = { x: sr.x, y: sr.y + labelInset, w: sr.w, h: sr.h - labelInset };
      if (subRect.w < 1 || subRect.h < 1) return;

      var stockTiles = window.SquarifiedTreemap(stockItems, subRect);
      stockTiles.forEach(t => {
        allTiles.push(t);
      });
    });

    return { sectors: sectorLabels, tiles: allTiles, containerW: containerW, containerH: containerH };
  }, [filteredData]);

  // Muted palette (Finviz-inspired) — easier on Retina than saturated Tailwind 500/600 tones
  // Tile colours carry white text, so each one has to clear 4.5:1 against
  // white -- the labels are 7-13px, which is not large text by WCAG. Measured
  // 2026-09-17: the brightest green was 3.37:1, the rest of the scale already
  // passed (4.51-7.58). Only that one moved, and only far enough to pass
  // (4.61:1), so the scale still reads as a scale.
  // The greens were #128651 / #14884d above +1%, the same colour to the eye
  // (AMAT +5.2% and AVGO +1.6% alike). Three steps now, each
  // still >= 4.6:1 with white: muted #35684f, #177a44, bright #128651.
  const getChangeColor = (raw) => {
    // Coloured as shown: a tile reading 0.0% is the neutral grey.
    const change = window.HeatmapChange.shown(raw, 1);
    if (change == null) return '#475569';
    if (change >= 3) return '#128651';
    if (change >= 1) return '#177a44';
    if (change > 0) return '#35684f';
    if (change === 0) return '#475569';
    if (change > -1) return '#a44148';
    if (change > -3) return '#b93e3e';
    return '#cb4242';
  };

  const getFullSymbol = (code) => {
    const cfg = INDEX_COMPONENTS[selectedIndex];
    if (cfg?.type === 'forex') return `${code}.FOREX`;
    if (cfg?.type === 'crypto') return `${code}-USD.CC`;
    return `${code}.US`;
  };

  const cfg = INDEX_COMPONENTS[selectedIndex];
  const isForexOrCrypto = cfg?.type === 'forex' || cfg?.type === 'crypto';
  // Forex and crypto have no session switch (they trade around the clock):
  // a Pre-Market chosen on S&P 500 stayed on, the line read "Pre-Market •
  // delayed ~15m" over the pairs and session=premarket stayed in the link.
  // Those tabs are the regular session.
  React.useEffect(() => {
    if (isForexOrCrypto && sessionMode !== 'regular') setSessionMode('regular');
  }, [isForexOrCrypto, sessionMode]);

  // Pull v2 exchange-details for the active index's exchange so we can show
  // an "Early-close" / "Closed for holiday" banner above the heatmap. Most
  // indices map to US; if you add international indices later, key the
  // mapping off cfg.exchange.
  const heatmapExchange = isForexOrCrypto ? null : (cfg?.exchange || 'US');
  const [exBanner, setExBanner] = React.useState(null);
  React.useEffect(() => {
    if (!heatmapExchange || !apiKey) { setExBanner(null); return; }
    const ES = window.ExchangeStatus;
    if (!ES) return;
    let cancelled = false;
    (async () => {
      // A load that failed settles it too: the overlay waits for no more.
      try { await ES.load(heatmapExchange, apiKey); } catch (_) { /* failed() says */ }
      if (cancelled) return;
      setExLoaded(heatmapExchange);
      const session = ES.getCurrentSession(heatmapExchange);
      const hol = ES.getHolidayToday(heatmapExchange);
      const isEarly = ES.isEarlyCloseToday(heatmapExchange);
      // The exchange's own clock, named: "closes 13:00" read as local time
      // anywhere but New York (the calendar's same banner).
      const exTz = (ES.getRegularHours(heatmapExchange) || {}).tz;
      const exCity = exTz ? ' ' + String(exTz).split('/').pop().replace(/_/g, ' ') + ' time' : '';
      const closeAt = ES.getCloseTimeToday(heatmapExchange);
      const closeTime = closeAt ? closeAt + exCity : '';
      if (isEarly && session !== 'closed') {
        setExBanner({ tone: 'early', text: `${heatmapExchange} half-day · closes ${closeTime || ''} (${hol?.name || 'Early close'})` });
      } else if (isEarly && session === 'closed') {
        // After a half-day's early close: shut for the day, not on holiday.
        setExBanner({ tone: 'closed', text: `${heatmapExchange} half-day · closed at ${closeTime || ''} (${hol?.name || 'Early close'})` });
      } else if (session === 'closed' && hol) {
        setExBanner({ tone: 'closed', text: `${heatmapExchange} closed today — ${hol.name}` });
      } else {
        setExBanner(null);
      }
    })();
    return () => { cancelled = true; };
  }, [heatmapExchange, apiKey]);
  const showLimitDropdown = cfg?.limitOptions && cfg.limitOptions.length > 0;
  const currentCount = filteredData.length;
  // The tiles the map has before the Gainers/Losers filter.
  const baseCount = unfilteredData.length;
  // The index's real size when its list is known -- "S&P 500 - 431/503" says
  // exactly how many members the screener's top 500 happened to include.
  const totalCount = (indexMembers[selectedIndex] && indexMembers[selectedIndex].length) || cfg?.totalCount || baseCount;
  // Members drawn from the index list that no quote has priced yet.
  // (Regular session only: in Pre-Market an untraded stock has no change by
  // design, and the subtitle says how many traded.)
  // Counted before the Gainers/Losers filter: a tile the filter hides is not
  // a tile without a quote. A pair or coin missing from the list altogether
  // (the batch failed) has no quote either.
  const unpricedRows = (sessionMode === 'premarket' && !isForexOrCrypto) ? 0 : unfilteredData.filter(r => r && getChangePercent(r) == null).length;
  const unpricedCount = unpricedRows + (isForexOrCrypto && !loadingForexCrypto ? Math.max(0, totalCount - baseCount) : 0);
  // Nothing priced at all. For a signed-out visitor every quote is refused,
  // and the subtitle used to read "0/500 stocks - 500 not in the screener
  // universe" over "No data available".
  const pricedCount = baseCount - unpricedRows;
  const noPrices = sessionMode !== 'premarket' && !loading && !loadingForexCrypto && totalCount > 0 && pricedCount === 0;

  // Select dropdown style
  const selectStyle = {
    padding: '6px 12px', borderRadius: '8px', fontSize: '12px',
    background: isDark ? 'rgba(30,30,50,0.95)' : 'rgba(255,255,255,0.95)',
    border: '1px solid ' + (isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.2)'),
    color: isDark ? '#ffffff' : '#1e1b4b', cursor: 'pointer',
    WebkitAppearance: 'none', MozAppearance: 'none', appearance: 'none',
    paddingRight: '24px',
    backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='${isDark ? '%23ffffff' : '%231e1b4b'}' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")`,
    backgroundRepeat: 'no-repeat',
    backgroundPosition: 'right 8px center',
  };

  const optionStyle = { background: isDark ? '#1a1a2e' : '#ffffff', color: isDark ? '#ffffff' : '#1e1b4b' };

  // Treemap container ref for dynamic width
  // The width was read after each render and never otherwise, so resizing
  // the window kept the old layout: opened at 1440 and narrowed to 800, the
  // map stayed 1098px wide with three sectors past the edge; opened at 390
  // and widened, a 308px map sat in a corner. The container
  // is observed now, and the viewport for the height step at 768px.
  const [treemapEl, setTreemapEl] = React.useState(null);
  const treemapRef = setTreemapEl;
  const [tileHint, setTileHint] = React.useState(null);
  // Whether the press now ending on a tile was a finger (or a pen).
  const touchRef = React.useRef(false);
  // What a tile is, for its title, the keyboard's hint and a first tap: the
  // ticker, the company (a cut sector label said nothing either), the sector
  // and the change.
  const tileHintText = (tile) => {
    const ticker = tile.label || tile.code || tile.symbol;
    return [ticker, tile.name && tile.name !== ticker ? tile.name : null, tile.sector, tile.changeP == null ? 'no quote' : fmtChange(tile.changeP, 2)].filter(Boolean).join(' · ');
  };
  // The same hint for the cells of the Sectors and Grid views: what the cell
  // is, its sector and its change, for the mouse (title) and for the keyboard
  // (a chip beside the focused cell, placed inside the box that holds them).
  const [cellHint, setCellHint] = React.useState(null);
  const cellsBoxRef = React.useRef(null);
  const cellHintText = (item, change, sector) => [item.label || item.code, sector || item.sector, change == null ? 'no quote' : fmtChange(change, 2)].filter(Boolean).join(' · ');
  const cellHintProps = (item, change, sector) => {
    const text = cellHintText(item, change, sector);
    return {
      title: text,
      onFocus: (e) => {
        let kb = true; try { kb = e.currentTarget.matches(':focus-visible'); } catch (_) {}
        const box = cellsBoxRef.current;
        if (!kb || !box) return;
        const c = e.currentTarget.getBoundingClientRect(); const b = box.getBoundingClientRect();
        const width = Math.min(280, text.length * 7 + 18, b.width);
        let left = Math.max(0, Math.min(b.width - width, c.left - b.left + c.width / 2 - width / 2));
        // Above the cell; in the first row, below it.
        let top = c.top - b.top >= 30 ? c.top - b.top - 28 : c.bottom - b.top + 2;
        let h = 26;
        // Sectors: the line above a row of cells is the sector's name, and the
        // hint lay on it. Beside the cell instead -- right of it, or left of
        // it where the right has no room -- on the cells' own line.
        if (sector) {
          const x = c.left - b.left;
          // Beside the cell only on a wide screen: on a phone the cells beside
          // it are its neighbours, and the hint lay on them.
          const wide = b.width >= 600;
          if (wide && x + c.width + 4 + width <= b.width) { left = x + c.width + 4; top = c.top - b.top + (c.height - 26) / 2; }
          else if (wide && x - 4 - width >= 0) { left = x - 4 - width; top = c.top - b.top + (c.height - 26) / 2; }
          else {
            // No room beside it (a phone): stay inside the sector's own
            // cells -- over the row above, else the row below, else on the
            // cell's own line -- since the lines outside them are names.
            const rows = e.currentTarget.parentElement.getBoundingClientRect();
            if (c.top - rows.top >= 28) top = c.top - b.top - 28;
            else if (rows.bottom - c.bottom >= 28) top = c.bottom - b.top + 2;
            // A sector of one row: under the row, in the gap before the next
            // sector, a little shorter so it ends before that sector's name.
            // On the cell's own line it hid the cell and its neighbours.
            else { top = rows.bottom - b.top + 1; h = 22; }
          }
        }
        setCellHint({ text, left, top, width, h });
      },
      onBlur: () => setCellHint(null),
    };
  };
  React.useEffect(() => { setCellHint(null); setTileHint(null); }, [viewMode]);
  const [treemapWidth, setTreemapWidth] = React.useState(0);
  const [viewportW, setViewportW] = React.useState(() => window.innerWidth);

  React.useEffect(() => {
    if (!treemapEl) return;
    const read = () => {
      const w = treemapEl.offsetWidth;
      if (w > 0) setTreemapWidth(prev => (prev === w ? prev : w));
    };
    read();
    if (typeof ResizeObserver === 'function') {
      // One layout per frame, not one per observation while dragging.
      let raf = 0;
      const ro = new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(read); });
      ro.observe(treemapEl);
      return () => { cancelAnimationFrame(raf); ro.disconnect(); };
    }
    window.addEventListener('resize', read);
    return () => window.removeEventListener('resize', read);
  }, [treemapEl]);

  React.useEffect(() => {
    const onResize = () => setViewportW(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Recalculate treemap layout using actual container width
  const finalTreemapLayout = React.useMemo(() => {
    if (filteredData.length === 0) return { sectors: [], tiles: [] };

    const isDesktop = viewportW > 768;
    const containerH = isDesktop ? 500 : 400;
    const containerW = treemapWidth > 0 ? treemapWidth : Math.min(viewportW - 40, 800);

    // Group by sector, compute total market cap per sector
    const sectorMap = {};
    filteredData.forEach(item => {
      const sector = item.sector || 'Other';
      if (!sectorMap[sector]) {
        sectorMap[sector] = { name: sector, stocks: [], totalMcap: 0 };
      }
      const mcap = item.market_capitalization || 1;
      sectorMap[sector].stocks.push(item);
      sectorMap[sector].totalMcap += mcap;
    });

    // Build sector items for top-level treemap
    const sectorItems = Object.values(sectorMap).map(s => ({
      symbol: s.name,
      weight: s.totalMcap,
      _sectorData: s
    }));

    // Run squarified treemap for sectors
    const sectorRects = window.SquarifiedTreemap(sectorItems, { x: 0, y: 0, w: containerW, h: containerH });

    // For each sector rect, run squarified treemap for its stocks
    var allTiles = [];
    var sectorLabels = [];

    sectorRects.forEach(sr => {
      var sd = sr._sectorData;
      if (!sd || sr.w < 1 || sr.h < 1) return;

      sectorLabels.push({
        name: sd.name,
        x: sr.x,
        y: sr.y,
        w: sr.w,
        h: sr.h
      });

      // Build stock items
      var stockItems = sd.stocks.map(item => ({
        symbol: item.code,
        weight: item.market_capitalization || 1,
        changeP: getChangePercent(item),
        sector: sd.name,
        name: item.name || item.code,
        label: item.name && item.name !== item.code && item.name.length <= 8 ? item.name : item.code,
        code: item.code
      }));

      // Sub-layout inside sector rect (with a small inset for sector label)
      var labelInset = sr.h > 20 ? 14 : 0;
      var subRect = { x: sr.x, y: sr.y + labelInset, w: sr.w, h: sr.h - labelInset };
      if (subRect.w < 1 || subRect.h < 1) return;

      var stockTiles = window.SquarifiedTreemap(stockItems, subRect);
      stockTiles.forEach(t => {
        allTiles.push(t);
      });
    });

    return { sectors: sectorLabels, tiles: allTiles, containerW: containerW, containerH: containerH };
  }, [filteredData, treemapWidth, viewportW]);

  // Effective view mode: for forex/crypto, fall back to grid if treemap selected
  const effectiveViewMode = (isForexOrCrypto && viewMode === 'treemap') ? 'grid' : viewMode;

  const Wrapper = embedded ? React.Fragment : window.AppLayout;
  // "Market closed · last session Fri, Oct 2" when every quote on the map is
  // from an earlier day than today in the exchange's own zone and today's
  // session has not begun (ExchangeStatus.isPrevSessionQuote, as the asset
  // card already does). Null for forex/crypto, Pre-Market, or no quotes.
  const prevSessionInfo = () => {
    if (isForexOrCrypto || sessionMode !== 'regular' || !heatmapExchange) return null;
    const ES = window.ExchangeStatus;
    if (!ES || !ES.isPrevSessionQuote || !(ES.isLoaded && ES.isLoaded(heatmapExchange))) return null;
    const hours = ES.getRegularHours(heatmapExchange);
    const tz = (hours && hours.tz) || 'America/New_York';
    const session = ES.getCurrentSession(heatmapExchange);
    // The quotes on this map only: a coin or pair seen earlier trades at
    // weekends too, and its fresh timestamp hid Friday's stock quotes.
    let ts = 0;
    computeVisibleSymbols().forEach((sym) => {
      const q = (rawQuotesRef.current || {})[sym];
      const t = Number(q && q.timestamp);
      if (Number.isFinite(t) && t > ts) ts = t;
    });
    // No real-time quotes were asked for (screenerCoversQuotes): the date is
    // the screener's -- the session those rows close. 20:00 UTC is that day's
    // afternoon in New York, summer or winter.
    if (!ts) {
      const rows = screenerCoversQuotes();
      const dates = rows ? rows.map(r => r.last_day_data_date).sort() : [];
      if (dates.length) ts = Date.parse(dates[dates.length - 1] + 'T20:00:00Z') / 1000;
    }
    if (!ts || !ES.isPrevSessionQuote(ts, tz, session)) return null;
    let day = '';
    try {
      day = new Date(ts < 4e10 ? ts * 1000 : ts).toLocaleDateString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' });
    } catch (_) { day = ''; }
    const state = session === 'pre' ? 'Pre-market now' : 'Market closed';
    return state + (day ? ' • last session ' + day : '');
  };

  const wrapperProps = embedded ? {} : { activeTab, onTabChange, onSettingsClick, theme };

  return (
    <Wrapper {...wrapperProps}>
      {/* Keyframes travel with the view (hosts without the global CSS). */}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }
/* Treemap tiles touch each other, so the ring drawn outside a focused tile was
   covered by its neighbours down to a 1 px line. It is
   drawn inside the tile instead, white over dark, so it reads on any colour. */
.heatmap-cell:focus-visible { outline: 3px solid #ffffff !important; outline-offset: -3px !important; box-shadow: inset 0 0 0 5px #0f172a !important; }
.heatmap-tile:focus-visible { z-index: 3 !important; }`}</style>
      {/* Header */}
      <div style={{ padding: '16px 20px', display: 'flex', alignItems: 'center', gap: '12px' }}>
        <div style={{ flex: 1 }}>
          <h1 ref={headingRef} tabIndex={-1} style={{ fontSize: '20px', fontWeight: '700', margin: 0 }}>Market Heatmap</h1>
          <p style={{ fontSize: '12px', color: isDark ? C3.textMutedDark : C3.textMutedLight, margin: 0 }}>
            {cfg?.name} • {filter === 'all' ? (noPrices ? pricedCount : baseCount) + '/' + totalCount : currentCount + ' of ' + baseCount} {cfg?.type === 'crypto' ? 'coins' : cfg?.type === 'forex' ? 'pairs' : 'stocks'}
            {filter !== 'all' && (' • ' + (filter === 'gainers' ? 'gainers' : 'losers') + ' only')}
            {noPrices
              // Nothing more where the host's panel already says why (the
              // not-served line below speaks for it): two explanations in two
              // wordings read as two problems.
              // Still, the line says that no quote came back: "Crypto • 20/20
              // coins • 2026-10-26" over twenty "—" tiles read as a priced
              // map of the S&P screener's day.
              ? ((window.Entitlement && window.Entitlement.explained && window.Entitlement.explained()) ? ' • no quotes came back' : " • Couldn't load prices")
              : (unpricedCount > 0 && ' • ' + unpricedCount + ' without a quote yet')}
            {sessionMode === 'premarket' && !isForexOrCrypto
              ? (rtLoading
                  ? ' • Pre-Market • loading...'
                  : premarketMeta.failed
                  ? ' • Pre-Market • no pre-market quotes available'
                  : ` • Pre-Market • delayed ~15m${premarketMeta.lastEthTime ? ' • last ' + new Date(premarketMeta.lastEthTime < 4e10 ? premarketMeta.lastEthTime * 1000 : premarketMeta.lastEthTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}${premarketMeta.tradedCount ? ' • ' + premarketMeta.tradedCount + ' traded' : ''}`)
              : (() => {
                  // Labelled by the feed actually behind the prices, never a
                  // blanket "Real-time": a free key
                  // gets delayed quotes, and a paid one streams only while
                  // the market is open.
                  if (rtLoading || loadingForexCrypto) return ' • Updating...';
                  // Before the open, at weekends and on holidays the quotes are
                  // the last session's: "Updated 09:22 AM" over Friday's +1.0%
                  // read as today's move.
                  const prev = prevSessionInfo();
                  if (prev) return ' • ' + prev;
                  if (feed === 'live') return ' • Live';
                  if (feed === 'delayed') return ' • Delayed';
                  const fc = cfg?.type === 'crypto' || cfg?.type === 'forex';
                  const t = fc ? (forexCryptoData.some(r => !r.unpriced) ? fcTime : 0) : (Object.keys(rtOverlay).length > 0 ? rtTime : 0);
                  if (t) return ' • Updated ' + new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                  // The screener's date only over the screener's prices: never
                  // over coins or pairs, nor a map with nothing priced.
                  if (fc || noPrices) return '';
                  return heatmapData?.[0]?.last_day_data_date ? ` • ${heatmapData[0].last_day_data_date}` : '';
                })()}
          </p>
        </div>
        <button onClick={() => { if (rlWait.hold()) return; refreshRealTime(); window.Haptics?.light?.(); }} disabled={rtLoading} aria-disabled={waitLeft ? 'true' : undefined}
          aria-label={waitLeft ? `Refresh prices (in ${waitLeft} s)` : 'Refresh prices'} title={waitLeft ? `Too many requests: refresh in ${waitLeft} s` : undefined} style={{
          width: '40px', height: '40px', borderRadius: '12px',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: rtLoading
            ? (isDark ? 'rgba(249,115,22,0.18)' : 'rgba(249,115,22,0.12)')
            : (isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.05)'),
          border: rtLoading ? `1px solid ${C3.glowOrange}` : 'none', cursor: rtLoading ? 'wait' : 'pointer',
          color: rtLoading ? C3.glowOrange : (isDark ? C3.textDark : C3.textLightTheme),
          transition: 'background 0.2s, border 0.2s, color 0.2s',
        }}>
          <Icon name="refresh" size={20} style={{ animation: rtLoading ? 'spin 0.6s linear infinite' : 'none' }} />
        </button>
      </div>
      {/* Refresh pressed inside the wait over a drawn map: the note here (the
          empty-map panels carry their own under Try again). */}
      {filteredData.length > 0 && !noPrices && waitNoteEl}

      {/* Trading-hours banner — surfaces EarlyClose half-days and full-day
          closures from /v2/exchange-details, so a flat heatmap doesn't look
          like stale data. */}
      {exBanner && (
        <div style={{
          margin: '0 20px 12px', padding: '8px 12px', borderRadius: 8,
          background: exBanner.tone === 'early'
            ? (isDark ? 'rgba(245,158,11,0.12)' : 'rgba(245,158,11,0.10)')
            : (isDark ? 'rgba(148,163,184,0.12)' : 'rgba(100,116,139,0.10)'),
          border: `1px solid ${exBanner.tone === 'early' ? 'rgba(245,158,11,0.35)' : (isDark ? 'rgba(148,163,184,0.25)' : 'rgba(100,116,139,0.20)')}`,
          color: exBanner.tone === 'early' ? '#f59e0b' : (isDark ? '#cbd5e1' : '#475569'),
          fontSize: 12, fontWeight: 600,
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <span aria-hidden="true" style={{ width: 9, height: 9, borderRadius: '50%', flexShrink: 0, background: exBanner.tone === 'early' ? '#f59e0b' : '#ef4444' }} />
          <span>{exBanner.text}</span>
        </div>
      )}

      {/* Index Tabs */}
      {/* Web: underlined text tabs (the terminal's stylesheet .mi-tabbar, design stage 2).
          The session, Gainers/Losers and Treemap/Sectors/Grid rows below are
          toggles of a value. Mini App: pills. */}
      {window.APP_PLATFORM === 'WEB' ? (
        <div style={{ padding: '0 20px 16px' }}>
          <div className="mi-tabbar" role="group" aria-label="Index">
            {Object.entries(INDEX_COMPONENTS).map(([key, idx]) => (
              <button key={key} type="button" className="mi-tab" aria-pressed={selectedIndex === key} onClick={() => setSelectedIndex(key)}>
                {idx.name}
              </button>
            ))}
          </div>
        </div>
      ) : (
      <div style={{ display: 'flex', gap: '8px', padding: '0 20px 16px', overflowX: 'auto' }}>
        {Object.entries(INDEX_COMPONENTS).map(([key, idx]) => (
          <button key={key} aria-pressed={selectedIndex === key} onClick={() => setSelectedIndex(key)} style={{
            padding: '8px 14px', borderRadius: '100px', fontSize: '13px', fontWeight: '600',
            whiteSpace: 'nowrap', cursor: 'pointer', border: 'none',
            background: selectedIndex === key ? C3.logoGradient : (isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)'),
            color: selectedIndex === key ? 'white' : (isDark ? C3.textDark : C3.textLightTheme),
          }}>
            {idx.name}
          </button>
        ))}
      </div>
      )}

      {prefsUnsaved && (
        <p role="status" style={{ margin: '0 20px 12px', fontSize: 12, color: isDark ? C3.textMutedDark : C3.textMutedLight }}>
          This browser did not let the heatmap save your settings (its storage is full or switched off); they last until you leave.
        </p>
      )}

      {/* Filters Row */}
      <div style={{ display: 'flex', gap: '8px', padding: '0 20px 16px', flexWrap: 'wrap', alignItems: 'center' }}>
        {/* Session mode toggle — only for US stock indices (Forex/Crypto trade 24/7) */}
        {!isForexOrCrypto && (
          <div style={{ display: 'flex', gap: '4px', background: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)', borderRadius: '8px', padding: '2px' }}>
            <button aria-pressed={sessionMode === 'regular'} onClick={() => { setSessionMode('regular'); window.Haptics?.light?.(); }} style={{
              padding: '6px 10px', borderRadius: '6px', fontSize: '12px', fontWeight: '600',
              cursor: 'pointer', border: 'none',
              background: 'transparent',
              color: isDark ? C3.textMutedDark : C3.textMutedLight,
              ...window.ToggleStyle.value(sessionMode === 'regular', isDark),
            }}>Regular</button>
            <button aria-pressed={sessionMode === 'premarket'} onClick={() => { setSessionMode('premarket'); window.Haptics?.light?.(); }} style={{
              padding: '6px 10px', borderRadius: '6px', fontSize: '12px', fontWeight: '600',
              cursor: 'pointer', border: 'none', display: 'flex', alignItems: 'center', gap: '4px',
              background: 'transparent',
              color: isDark ? C3.textMutedDark : C3.textMutedLight,
              ...window.ToggleStyle.value(sessionMode === 'premarket', isDark),
            }}>
              <span style={{ fontSize: '9px' }}>●</span>Pre-Market
            </button>
          </div>
        )}
        {/* Gainers/Losers filter */}
        {['all', 'gainers', 'losers'].map(f => (
          <button key={f} aria-pressed={filter === f} onClick={() => setFilter(f)} style={{
            padding: '6px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: '600',
            cursor: 'pointer', border: 'none',
            // Picked in the accent, Gainers and Losers too: a filter is chrome,
            // not a change in price (they were solid green and red).
            background: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)',
            color: isDark ? C3.textMutedDark : C3.textMutedLight,
            ...window.ToggleStyle.value(filter === f, isDark),
          }}>
            {f === 'all' ? 'All' : f === 'gainers' ? 'Gainers' : 'Losers'}
          </button>
        ))}

        {/* Display limit dropdown - only for indices that support it */}
        {showLimitDropdown && React.createElement(window.PortalDropdown, {
          value: displayLimit,
          options: cfg.limitOptions.map(opt => ({ value: opt.value, label: opt.label })),
          onChange: (v) => setDisplayLimit(parseInt(v)),
          isDark, style: { ...selectStyle }, minWidth: 0,
          // The trigger is as narrow as "All"; a list that narrow printed its
          // options as "A…", "T…", "T…" (seen while giving the list its keyboard).
          popupMinWidth: 120,
          ariaLabel: 'Display limit',
        })}

        {/* View mode toggle - 3 modes for stock indices, 2 for forex/crypto */}
        {!isForexOrCrypto ? (
          <div style={{ display: 'flex', gap: '4px', marginLeft: 'auto', background: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)', borderRadius: '8px', padding: '2px' }}>
            <button aria-pressed={viewMode === 'treemap'} onClick={() => setViewMode('treemap')} style={{
              padding: '6px 10px', borderRadius: '6px', fontSize: '12px', fontWeight: '600',
              cursor: 'pointer', border: 'none',
              display: 'flex', alignItems: 'center', gap: '4px',
              background: 'transparent',
              color: isDark ? C3.textMutedDark : C3.textMutedLight,
              ...window.ToggleStyle.value(viewMode === 'treemap', isDark),
            }}>
              <Icon name="map" size={14} />
              Treemap
            </button>
            <button aria-pressed={viewMode === 'sectors'} onClick={() => setViewMode('sectors')} style={{
              padding: '6px 10px', borderRadius: '6px', fontSize: '12px', fontWeight: '600',
              cursor: 'pointer', border: 'none',
              display: 'flex', alignItems: 'center', gap: '4px',
              background: 'transparent',
              color: isDark ? C3.textMutedDark : C3.textMutedLight,
              ...window.ToggleStyle.value(viewMode === 'sectors', isDark),
            }}>
              <Icon name="briefcase" size={14} />
              Sectors
            </button>
            <button aria-pressed={viewMode === 'grid'} onClick={() => setViewMode('grid')} style={{
              padding: '6px 10px', borderRadius: '6px', fontSize: '12px', fontWeight: '600',
              cursor: 'pointer', border: 'none',
              display: 'flex', alignItems: 'center', gap: '4px',
              background: 'transparent',
              color: isDark ? C3.textMutedDark : C3.textMutedLight,
              ...window.ToggleStyle.value(viewMode === 'grid', isDark),
            }}>
              <Icon name="barChart" size={14} />
              Grid
            </button>
            {/* Social removed — not functional */}
          </div>
        ) : null}
      </div>

      {/* Content */}
      <div style={{ padding: '0 20px' }}>
        {isDemo ? (
          <div>
            {window.PaywallGate ? (
              <window.PaywallGate
                allowed={false}
                type="subscription"
                message="Visualize market movements with the interactive heatmap"
                actionLabel="Upgrade for Heatmap"
                onAction={onUpgradeClick}
                isDark={isDark}
              >
                {/* Fake heatmap preview grid */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8, padding: 8 }}>
                  {[
                    { t: 'AAPL', c: '#22c55e', v: '+1.2%' },
                    { t: 'MSFT', c: '#16a34a', v: '+0.8%' },
                    { t: 'NVDA', c: '#ef4444', v: '-0.5%' },
                    { t: 'GOOG', c: '#22c55e', v: '+0.3%' },
                    { t: 'AMZN', c: '#dc2626', v: '-1.1%' },
                    { t: 'META', c: '#16a34a', v: '+2.1%' },
                    { t: 'TSLA', c: '#ef4444', v: '-2.3%' },
                    { t: 'JPM', c: '#22c55e', v: '+0.4%' },
                    { t: 'NFLX', c: '#16a34a', v: '+1.7%' },
                  ].map((s, i) => (
                    <div key={i} style={{
                      background: s.c === '#22c55e' || s.c === '#16a34a' ? 'rgba(34,197,94,0.35)' : 'rgba(239,68,68,0.35)',
                      borderRadius: 10, aspectRatio: '1',
                      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                    }}>
                      <div style={{ fontSize: 15, fontWeight: 700, color: isDark ? '#fff' : '#1e1b4b' }}>{s.t}</div>
                      <div style={{ fontSize: 13, fontWeight: 700, color: s.c, marginTop: 4 }}>{s.v}</div>
                    </div>
                  ))}
                </div>
              </window.PaywallGate>
            ) : (
              <div style={{ textAlign: 'center', padding: '48px 20px' }}>
                <h2 style={{ fontSize: '20px', fontWeight: '700', marginBottom: '8px' }}>Market Heatmap</h2>
                <p style={{ color: isDark ? C3.textMutedDark : C3.textMutedLight, marginBottom: '24px' }}>Upgrade for full access</p>
                <button onClick={onUpgradeClick} style={{
                  padding: '14px 28px', background: C3.logoGradient, border: 'none',
                  borderRadius: '14px', color: 'white', fontSize: '15px', fontWeight: '600', cursor: 'pointer',
                }}>Upgrade for Full Access</button>
              </div>
            )}
          </div>
        ) : (loading || loadingForexCrypto) ? (
          <div style={{ textAlign: 'center', padding: '48px 0' }}>
            <div style={{
              width: '32px', height: '32px',
              border: '3px solid ' + (isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)'), borderTopColor: C3.glowOrange,
              borderRadius: '50%', animation: 'spin 0.8s linear infinite', margin: '0 auto 12px',
            }} />
            <p style={{ color: isDark ? C3.textMutedDark : C3.textMutedLight }}>Loading {cfg?.name}...</p>
          </div>
        ) : (filteredData.length === 0 && filter !== 'all' && pricedCount > 0) ? (
          <div style={{ textAlign: 'center', padding: '48px 0' }}>
            <p style={{ color: isDark ? C3.textMutedDark : C3.textMutedLight, marginBottom: '16px' }}>
              No {filter === 'gainers' ? 'gainers' : 'losers'} in {cfg?.name} right now.
            </p>
            <button onClick={() => setFilter('all')} style={{
              padding: '12px 24px', background: C3.logoGradient, border: 'none',
              borderRadius: '12px', color: 'white', fontSize: '14px', fontWeight: '600', cursor: 'pointer',
            }}>
              Show all
            </button>
          </div>
        ) : filteredData.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '48px 0' }}>
            <p style={{ color: isDark ? C3.textMutedDark : C3.textMutedLight, marginBottom: '16px' }}>
              {window.Entitlement && window.Entitlement.explained && window.Entitlement.explained()
                ? 'Nothing below is missing data — the request was not served. See the panel above.'
                : notLoadedText}
            </p>
            <button data-heatmap-retry="true" aria-disabled={retrying || !!waitLeft || undefined} onClick={(e) => tryAgain(e, () => { if (isForexOrCrypto) { loadForexCryptoData(cfg); return; } retryMembers(); if (onLoadData) onLoadData(); })} style={{
              padding: '12px 24px', background: C3.logoGradient, border: 'none',
              borderRadius: '12px', color: 'white', fontSize: '14px', fontWeight: '600', cursor: 'pointer',
              ...retryLook,
            }}>
              {retryLabel}
            </button>
            {waitNoteEl}
          </div>
        ) : (
          <div>
            {/* Every quote came back "NA": the tiles are there but none has a
                change, and the treemap stood empty without a word under a
                small "Couldn't load prices". */}
            {noPrices && (
              <div style={{ textAlign: 'center', padding: '16px 0 20px' }}>
                {/* The words are the live region; the button counts the wait
                    every second and stays outside it. */}
                <p role="status" style={{ color: isDark ? C3.textMutedDark : C3.textMutedLight, margin: '0 0 12px' }}>
                  {window.Entitlement && window.Entitlement.explained && window.Entitlement.explained()
                    ? 'Nothing below is missing data — the request was not served. See the panel above.'
                    : notLoadedText}
                </p>
                <button data-heatmap-retry="true" aria-disabled={retrying || !!waitLeft || undefined} onClick={(e) => tryAgain(e, () => { if (isForexOrCrypto) { loadForexCryptoData(cfg); return; } retryMembers(); refreshRealTime(); })} style={{
                  padding: '10px 20px', background: C3.logoGradient, border: 'none',
                  borderRadius: '12px', color: 'white', fontSize: '14px', fontWeight: '600', cursor: 'pointer',
                  ...retryLook,
                }}>
                  {retryLabel}
                </button>
                {waitNoteEl}
              </div>
            )}
            {/* Treemap View */}
            {effectiveViewMode === 'treemap' && !isForexOrCrypto ? (
              <div
                ref={treemapRef}
                style={{
                  position: 'relative',
                  width: '100%',
                  height: (window.innerWidth > 768 ? 500 : 400) + 'px',
                  marginBottom: '20px',
                  borderRadius: '8px',
                  overflow: 'hidden',
                }}
              >
                {/* Sector labels */}
                {finalTreemapLayout.sectors.map((sl, idx) => {
                  if (sl.w < 30 || sl.h < 18) return null;
                  return React.createElement('div', {
                    key: 'sl-' + idx,
                    style: {
                      position: 'absolute',
                      left: sl.x + 1,
                      top: sl.y + 1,
                      width: sl.w - 2,
                      height: 13,
                      fontSize: '9px',
                      fontWeight: '700',
                      color: isDark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.75)',
                      lineHeight: '13px',
                      paddingLeft: '3px',
                      overflow: 'hidden',
                      whiteSpace: 'nowrap',
                      textOverflow: 'ellipsis',
                      zIndex: 2,
                      // Hoverable, with its own title: a sector cut to "INDUS…" said
                      // nothing even at 1440. The tiles start below this
                      // strip (labelInset), so it takes no clicks from them.
                      pointerEvents: 'auto',
                      cursor: 'default',
                      textTransform: 'uppercase',
                      letterSpacing: '0.3px',
                    },
                    title: sl.name,
                  }, sl.name);
                })}

                {/* Stock tiles */}
                {finalTreemapLayout.tiles.map((tile, idx) => {
                  var tileW = Math.max(0, tile.w - 1);
                  var tileH = Math.max(0, tile.h - 1);
                  // Labels are sized to what fits the tile and dropped when
                  // that would be under 10 px. They used to shrink to 7 px on
                  // a phone, which nobody can read;
                  // the tile still names itself (aria-label) and opens on tap.
                  // Two lines (ticker + change) if both fit, else the ticker
                  // alone, else nothing. ~0.62 em per character, bold caps.
                  // 11 on phones: styles.css lifts any inline 10 px text to
                  // 11 there, and a label sized for 10 then overflowed ("X…").
                  var MIN_LABEL_PX = window.innerWidth < 600 ? 11 : 10;
                  var tileLabel = String(tile.label || tile.code || tile.symbol || '');
                  // 0.72 em: bold caps like M and W are wider than 0.62, and AMGN /
                  // MMM came out as "A…" / "M…". No ticker beats a cut one.
                  // Per character, not an average: "PANW" ran 3 px past its tile at
                  // 390 -- W and M are near a full em in bold caps.
                  var fitTicker = Math.floor((tileW - 6) / Math.max(2.2, window.HeatmapLabelEm(tileLabel)));
                  var fitChange = Math.floor((tileW - 4) / (6 * 0.58));
                  var twoLinePx = Math.min(13, fitTicker, fitChange, Math.floor(tileH / 2.5));
                  var oneLinePx = Math.min(13, fitTicker, Math.floor(tileH / 1.3));
                  var showText = twoLinePx >= MIN_LABEL_PX;
                  var showTickerOnly = !showText && oneLinePx >= MIN_LABEL_PX;
                  var tickerSize = showText ? twoLinePx : oneLinePx;
                  var changeSize = Math.max(MIN_LABEL_PX, tickerSize - 1);

                  return React.createElement('div', {
                    key: 'tt-' + idx,
                    className: 'heatmap-cell heatmap-tile',
                    role: 'button',
                    tabIndex: 0,
                    // The same hint from the keyboard: `title` shows only under
                    // a mouse.
                    onFocus: function (e) { var kb = true; try { kb = e.currentTarget.matches(':focus-visible'); } catch (_) {} if (kb) setTileHint(idx); },
                    onBlur: function () { setTileHint(null); },
                    onPointerDown: function (e) { touchRef.current = e.pointerType === 'touch' || e.pointerType === 'pen'; },
                    'aria-label': (tile.label || tile.code || tile.symbol) + ' ' + (tile.changeP == null ? 'no quote' : (tile.changeP >= 0 ? 'up ' : 'down ') + Math.abs(tile.changeP).toFixed(2) + ' percent'),
                    // On hover: what a small tile or a cut sector label cannot show.
                    title: tileHintText(tile),
                    onKeyDown: function (e) {
                      if (e.key !== 'Enter' && e.key !== ' ') return;
                      e.preventDefault();
                      onSelectAsset({ symbol: getFullSymbol(tile.code || tile.symbol), name: tile.name || tile.code || tile.symbol });
                    },
                    onClick: function() {
                      // A touch on a tile too small for its ticker and change
                      // names it first (the hint below); the second opens it.
                      // A tap went straight to the asset, and a phone showed
                      // 6 of 30 S&P tiles and 15 of 30 NASDAQ with no label at
                      // all. A mouse has the title, and keeps the
                      // single click.
                      if (touchRef.current && !showText && tileHint !== idx) { setTileHint(idx); return; }
                      if (window.MIAnalytics) window.MIAnalytics.track('dl_mi_heatmap_interact', { symbol: tile.code || tile.symbol });
                      onSelectAsset({ symbol: getFullSymbol(tile.code || tile.symbol), name: tile.name || tile.code || tile.symbol });
                    },
                    style: {
                      position: 'absolute',
                      left: tile.x + 0.5,
                      top: tile.y + 0.5,
                      width: tileW,
                      height: tileH,
                      background: getChangeColor(tile.changeP),
                      borderRadius: '2px',
                      cursor: 'pointer',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      overflow: 'hidden',
                      zIndex: 1,
                    }
                  },
                    (showText || showTickerOnly) ? React.createElement('span', {
                      style: {
                        color: 'white',
                        fontWeight: '700',
                        fontSize: tickerSize + 'px',
                        lineHeight: '1.1',
                        textAlign: 'center',
                        overflow: 'hidden',
                        whiteSpace: 'nowrap',
                        textOverflow: 'clip',
                        maxWidth: (tileW - 4) + 'px',
                      }
                    }, tile.label || tile.code || tile.symbol) : null,
                    showText ? React.createElement('span', {
                      style: {
                        color: 'white',
                        fontSize: changeSize + 'px',
                        lineHeight: '1.1',
                        marginTop: '1px',
                      }
                    }, fmtChange(tile.changeP, 1)) : null
                  );
                })}
                {(() => {
                  const tile = tileHint != null ? finalTreemapLayout.tiles[tileHint] : null;
                  if (!tile) return null;
                  const text = tileHintText(tile);
                  const mapW = finalTreemapLayout.tiles.reduce((m, t) => Math.max(m, t.x + t.w), 0);
                  const mapH = finalTreemapLayout.tiles.reduce((m, t) => Math.max(m, t.y + t.h), 0);
                  // Up to 280 px, never wider than the map. The text wraps: one
                  // line with an ellipsis cut the change and the sector off the
                  // end of a long name at 390 px ("ASML · ASML Holding N.V. New
                  // York Regis...").
                  const boxW = Math.max(60, Math.min(280, text.length * 7 + 18, mapW - 4));
                  const left = Math.max(2, Math.min(mapW - boxW - 2, tile.x + tile.w / 2 - boxW / 2));
                  // Above the tile, else below it, else inside its top edge: a
                  // tile as tall as the map (the largest company at 1440 px) has
                  // room neither above nor below, and the map clips what leaves it.
                  // The height is a guess until drawn, then measured.
                  const where = (h) => (tile.y >= h + 2 ? tile.y - h - 2
                    : tile.y + tile.h + h + 2 <= mapH ? tile.y + tile.h + 2
                    : Math.max(0, Math.min(mapH - h, tile.y + 6)));
                  const guessH = 8 + 16 * Math.max(1, Math.ceil((text.length * 7) / (boxW - 16)));
                  return React.createElement('div', {
                    className: 'heatmap-tile-hint',
                    'aria-hidden': true,   // the tile's own name and title already say this
                    ref: (el) => { if (el && el.offsetHeight) el.style.top = where(el.offsetHeight) + 'px'; },
                    style: {
                      position: 'absolute', left, top: where(guessH),
                      width: boxW, boxSizing: 'border-box', lineHeight: '16px', padding: '4px 8px',
                      // Follows the theme: the light theme repaints inline white text dark.
                      background: isDark ? '#0f172a' : '#ffffff', color: isDark ? '#ffffff' : '#0f172a',
                      border: '1px solid ' + (isDark ? 'rgba(255,255,255,0.45)' : '#0f172a'),
                      borderRadius: 6, fontSize: 12, fontWeight: 600, textAlign: 'center',
                      whiteSpace: 'normal', overflowWrap: 'anywhere',
                      zIndex: 4, pointerEvents: 'none',
                    },
                  }, text);
                })()}
              </div>
            ) : effectiveViewMode === 'sectors' && !isForexOrCrypto ? (
              /* Sector View */
              <div ref={cellsBoxRef} style={{ marginBottom: '20px', position: 'relative' }}>
                {cellHint && (
                  <div className="heatmap-tile-hint" aria-hidden="true" style={{
                    position: 'absolute', left: cellHint.left, top: cellHint.top, width: cellHint.width, boxSizing: 'border-box',
                    height: cellHint.h || 26, lineHeight: (cellHint.h || 26) + 'px', padding: '0 8px',
                    background: isDark ? '#0f172a' : '#ffffff', color: isDark ? '#ffffff' : '#0f172a',
                    border: '1px solid ' + (isDark ? 'rgba(255,255,255,0.45)' : '#0f172a'),
                    borderRadius: 6, fontSize: 12, fontWeight: 600, textAlign: 'center',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', zIndex: 4, pointerEvents: 'none',
                  }}>{cellHint.text}</div>
                )}
                {sectorData.map((sector) => (
                  <div key={sector.name} style={{ marginBottom: '16px' }}>
                    {/* Sector Header */}
                    <div style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      marginBottom: '8px', padding: '8px 12px', borderRadius: '8px',
                      background: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)',
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <div style={{
                          width: '8px', height: '8px', borderRadius: '50%',
                          background: SECTOR_COLORS[sector.name] || '#6b7280',
                        }} />
                        <span style={{ fontWeight: '600', fontSize: '13px' }}>{sector.name}</span>
                        <span style={{ fontSize: '11px', color: isDark ? C3.textMutedDark : C3.textMutedLight }}>
                          ({sector.stocks.length})
                        </span>
                      </div>
                      <span style={{
                        fontWeight: '600', fontSize: '12px',
                        color: changeInk(sector.avgChange),
                      }}>
                        {fmtChange(sector.avgChange, 2)}
                      </span>
                    </div>

                    {/* Sector Stocks */}
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                      {sector.stocks.map((item, i) => {
                        const change = getChangePercent(item);
                        const mcap = item.market_capitalization || 0;
                        let size = 40;
                        if (mcap > 1e12) size = 56;
                        else if (mcap > 500e9) size = 50;
                        else if (mcap > 100e9) size = 44;

                        return (
                          <button
                            key={item.code || i}
                            className="heatmap-cell"
                            {...cellHintProps(item, change, sector.name)}
                            onClick={() => onSelectAsset({ symbol: getFullSymbol(item.code), name: item.name || item.code })}
                            style={{
                              width: size, height: size, borderRadius: '6px',
                              background: getChangeColor(change),
                              display: 'flex', flexDirection: 'column',
                              alignItems: 'center', justifyContent: 'center',
                              border: 'none', cursor: 'pointer',
                            }}
                          >
                            {/* 10 px floor: these were 8 and 7 px. */}
                            <span style={{ color: 'white', fontWeight: '700', fontSize: size > 44 ? '11px' : '10px' }}>
                              {item.label || item.code}
                            </span>
                            <span style={{ color: 'white', fontSize: '10px' }}>
                              {fmtChange(change, 1)}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              /* Grid View */
              <div ref={cellsBoxRef} style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginBottom: '20px', position: 'relative' }}>
                {cellHint && (
                  <div className="heatmap-tile-hint" aria-hidden="true" style={{
                    position: 'absolute', left: cellHint.left, top: cellHint.top, width: cellHint.width, boxSizing: 'border-box',
                    height: cellHint.h || 26, lineHeight: (cellHint.h || 26) + 'px', padding: '0 8px',
                    background: isDark ? '#0f172a' : '#ffffff', color: isDark ? '#ffffff' : '#0f172a',
                    border: '1px solid ' + (isDark ? 'rgba(255,255,255,0.45)' : '#0f172a'),
                    borderRadius: 6, fontSize: 12, fontWeight: 600, textAlign: 'center',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', zIndex: 4, pointerEvents: 'none',
                  }}>{cellHint.text}</div>
                )}
                {filteredData.map((item, i) => {
                  const change = getChangePercent(item);
                  const mcap = item.market_capitalization || 0;
                  let size = 44;
                  if (isForexOrCrypto) {
                    size = 56;
                  } else {
                    if (mcap > 1e12) size = 64;
                    else if (mcap > 500e9) size = 56;
                    else if (mcap > 100e9) size = 50;
                  }

                  return (
                    <button
                      key={item.code || i}
                      className="heatmap-cell"
                      {...cellHintProps(item, change)}
                      onClick={() => onSelectAsset({ symbol: getFullSymbol(item.code), name: item.name || item.code })}
                      style={{
                        width: size, height: size, borderRadius: '8px',
                        background: getChangeColor(change),
                        display: 'flex', flexDirection: 'column',
                        alignItems: 'center', justifyContent: 'center',
                        border: 'none', cursor: 'pointer',
                      }}
                    >
                      {/* 10 px floor: these were 9 and 8 px. */}
                      <span style={{ color: 'white', fontWeight: '700', fontSize: size > 50 ? '11px' : '10px' }}>
                        {item.label || item.code}
                      </span>
                      <span style={{ color: 'white', fontSize: '10px' }}>
                        {fmtChange(change, 1)}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            {/* Top Movers: priced rows only; none priced, no section */}
            {/* H2 under the view's H1: it was an H3 with no H2 between. */}
            {filteredData.some(d => getChangePercent(d) != null) && (<>
            <h2 style={{ fontSize: '14px', fontWeight: '700', margin: '0 0 12px', color: isDark ? C3.textMutedDark : C3.textMutedLight }}>
              TOP MOVERS
            </h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '8px', marginBottom: '20px' }}>
              {filteredData.filter(d => getChangePercent(d) != null).sort((a, b) => Math.abs(getChangePercent(b)) - Math.abs(getChangePercent(a))).slice(0, 8).map((item) => {
                const change = getChangePercent(item);
                return (
                  <button
                    key={item.code}
                    onClick={() => onSelectAsset({ symbol: getFullSymbol(item.code), name: item.name || item.code })}
                    style={{
                      ...(isDark ? C3.glassDark : C3.glassLight),
                      borderRadius: '12px', padding: '12px',
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      cursor: 'pointer',
                    }}
                  >
                    <span style={{ fontWeight: '600', fontSize: '14px', color: isDark ? C3.textDark : C3.textLightTheme }}>{item.label || item.code}</span>
                    <span style={{ fontWeight: '700', fontSize: '14px', color: changeInk(change) }}>
                      {fmtChange(change, 2)}
                    </span>
                  </button>
                );
              })}
            </div>
            </>)}
          </div>
        )}
      </div>
    </Wrapper>
  );
};
