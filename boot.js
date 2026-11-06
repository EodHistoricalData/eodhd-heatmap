/**
 * Generated. The app's identity -- used for link tags, the key screen and the
 * footer -- and the check that React loaded before anything reads it.
 */
window.APP_META = {
  "app": "heatmap",
  "repo": "eodhd-heatmap",
  "title": "EODHD Market Heatmap",
  "description": "A treemap of the market — size by market cap, colour by change — on your own EODHD key.",
  "keyNote": "The map needs index fundamentals and real-time quotes; the Screener API adds detail where the plan has it and is not required. Whatever else your key cannot reach is named on screen in EODHD's own words; a plan without the Screener gets the map without that detail, and no notice.",
  "storage": [
    "eodhd_heatmap_"
  ]
};

if (!window.React || !window.ReactDOM) {
  var bootError = document.getElementById('boot-error');
  if (bootError) bootError.style.display = 'block';
  throw new Error('React did not load from unpkg.com, so the app cannot start. See the message on the page.');
}
