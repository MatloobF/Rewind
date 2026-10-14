// Display helpers shared by the pages.

// 850 -> "850 ms", 12_400 -> "12.4 s", 196_530 -> "3m 17s"
export function formatMs(ms) {
  if (ms == null) return '-';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export const formatNumber = (n) => (n == null ? '-' : n.toLocaleString());

export const formatDate = (iso) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

// Display only: runs are always re-launched from the argv array, never this string.
export const formatCommand = (argv) =>
  argv.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');

export const shortId = (id) => id.slice(0, 8);
