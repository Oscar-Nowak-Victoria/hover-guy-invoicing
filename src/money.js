// Money is held in integer cents everywhere and only formatted at the edges.

export function money(cents) {
  const neg = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${whole}.${String(abs % 100).padStart(2, '0')}`;
}

// "1,234.5" or "$1234.50" -> 123450. Returns NaN for junk.
export function parseMoney(input) {
  const s = String(input ?? '').replace(/[^0-9.\-]/g, '');
  if (!s) return NaN;
  return Math.round(parseFloat(s) * 100);
}

export function quantity(q) {
  return Number.isInteger(q) ? String(q) : String(Number(q.toFixed(3)));
}
