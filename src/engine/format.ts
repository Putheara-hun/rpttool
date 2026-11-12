// .NET-style format strings: n2, c, p1, d, yyyy-MM-dd, #,##0.00, "Total: {0:c2}" ...

const nfCache = new Map<string, Intl.NumberFormat>();
function nf(locale: string, opts: Intl.NumberFormatOptions) {
  const key = locale + JSON.stringify(opts);
  let f = nfCache.get(key);
  if (!f) {
    try {
      f = new Intl.NumberFormat(locale, opts);
    } catch {
      f = new Intl.NumberFormat('en-US', opts);
    }
    nfCache.set(key, f);
  }
  return f;
}

export interface FormatOptions {
  locale: string;
  currency: string;
}

const DEFAULT_OPTS: FormatOptions = { locale: 'en-US', currency: 'USD' };

export function isDate(v: unknown): v is Date {
  return v instanceof Date && !isNaN(v.getTime());
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
export function looksLikeIsoDate(s: string) {
  return ISO_RE.test(s);
}
export function parseDate(v: unknown): Date | null {
  if (isDate(v)) return v;
  if (typeof v === 'number') return new Date(v);
  if (typeof v === 'string' && v.trim()) {
    const s = v.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      const [y, m, d] = s.split('-').map(Number);
      return new Date(y, m - 1, d);
    }
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

export function defaultToString(v: unknown, o: FormatOptions = DEFAULT_OPTS): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') {
    if (!isFinite(v)) return '';
    if (Number.isInteger(v)) return String(v);
    return String(Math.round(v * 1e10) / 1e10);
  }
  if (isDate(v)) {
    const hasTime = v.getHours() || v.getMinutes() || v.getSeconds();
    return hasTime ? v.toLocaleString(o.locale) : v.toLocaleDateString(o.locale);
  }
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (Array.isArray(v)) return v.map((x) => defaultToString(x, o)).join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** Format a single value with a .NET-like format specifier or a composite format ("{0:n2} items"). */
export function formatValue(v: unknown, fmt: string | undefined, o: FormatOptions = DEFAULT_OPTS): string {
  if (!fmt) return defaultToString(v, o);
  if (fmt.includes('{0')) return compositeFormat(fmt, [v], o);
  if (v === null || v === undefined || v === '') return '';
  if (isDate(v)) return formatDate(v, fmt, o);
  let num: number | null = null;
  if (typeof v === 'number') num = v;
  else if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) num = Number(v);
  if (num !== null) return formatNumber(num, fmt, o);
  if (typeof v === 'string' && looksLikeIsoDate(v)) {
    const d = parseDate(v);
    if (d) return formatDate(d, fmt, o);
  }
  if (typeof v === 'boolean') {
    // allow "Yes;No" style formats for booleans
    if (fmt.includes(';')) {
      const [t, f] = fmt.split(';');
      return v ? t : f;
    }
  }
  return defaultToString(v, o);
}

export function compositeFormat(fmt: string, args: unknown[], o: FormatOptions = DEFAULT_OPTS): string {
  return fmt.replace(/\{\{|\}\}|\{(\d+)(?::([^}]*))?\}/g, (m, idx, spec) => {
    if (m === '{{') return '{';
    if (m === '}}') return '}';
    return formatValue(args[Number(idx)], spec, o);
  });
}

// ---------------------------------------------------------------- numbers

export function formatNumber(n: number, fmt: string, o: FormatOptions = DEFAULT_OPTS): string {
  if (!isFinite(n)) return '';
  const m = /^([cCdDeEfFgGnNpPxX])(\d{0,2})$/.exec(fmt);
  if (m) {
    const c = m[1].toLowerCase();
    const prec = m[2] === '' ? undefined : Number(m[2]);
    switch (c) {
      case 'c':
        return nf(o.locale, { style: 'currency', currency: o.currency || 'USD', minimumFractionDigits: prec ?? 2, maximumFractionDigits: prec ?? 2 }).format(n);
      case 'n':
        return nf(o.locale, { minimumFractionDigits: prec ?? 2, maximumFractionDigits: prec ?? 2 }).format(n);
      case 'f':
        return nf(o.locale, { minimumFractionDigits: prec ?? 2, maximumFractionDigits: prec ?? 2, useGrouping: false }).format(n);
      case 'p':
        return nf(o.locale, { style: 'percent', minimumFractionDigits: prec ?? 2, maximumFractionDigits: prec ?? 2 }).format(n);
      case 'd': {
        const s = Math.abs(Math.round(n)).toString().padStart(prec ?? 0, '0');
        return (n < 0 ? '-' : '') + s;
      }
      case 'e': {
        const s = n.toExponential(prec ?? 6).replace(/e([+-])(\d)$/, 'e$10$2');
        return m[1] === 'E' ? s.toUpperCase() : s;
      }
      case 'x': {
        const s = Math.round(n).toString(16).padStart(prec ?? 0, '0');
        return m[1] === 'X' ? s.toUpperCase() : s;
      }
      case 'g':
        return prec ? Number(n.toPrecision(prec)).toString() : defaultToString(n, o);
    }
  }
  if (/[0#]/.test(fmt)) return customNumber(n, fmt, o);
  return defaultToString(n, o);
}

function customNumber(n: number, fmt: string, o: FormatOptions): string {
  const sections = splitSections(fmt);
  let sec = sections[0];
  let useAbs = false;
  if (n < 0 && sections.length > 1 && sections[1]) {
    sec = sections[1];
    useAbs = true;
  } else if (n === 0 && sections.length > 2 && sections[2]) {
    sec = sections[2];
  }
  let v = useAbs ? Math.abs(n) : n;
  // locate numeric pattern
  const start = sec.search(/[0#]/);
  let end = start;
  for (let i = start; i < sec.length; i++) if (/[0#.,]/.test(sec[i])) end = i;
  const prefix = unquote(sec.slice(0, start));
  const pattern = sec.slice(start, end + 1);
  const suffix = unquote(sec.slice(end + 1));
  if (prefix.includes('%') || suffix.includes('%')) v *= 100;
  const [intPat, decPat = ''] = pattern.split('.');
  const minDec = (decPat.match(/0/g) || []).length;
  const maxDec = (decPat.match(/[0#]/g) || []).length;
  const minInt = (intPat.match(/0/g) || []).length;
  const grouping = intPat.includes(',');
  let s = nf(o.locale, {
    minimumFractionDigits: minDec,
    maximumFractionDigits: maxDec,
    minimumIntegerDigits: Math.max(1, Math.min(21, minInt || 1)),
    useGrouping: grouping,
  }).format(v);
  if (minInt === 0 && /^-?0[.,]/.test(s) && maxDec > 0) s = s.replace(/^(-?)0/, '$1');
  if (minInt === 0 && s === '0' && maxDec === 0) s = '';
  return prefix + s + suffix;
}

function splitSections(fmt: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = '';
  for (const ch of fmt) {
    if (q) {
      cur += ch;
      if (ch === q) q = '';
    } else if (ch === "'" || ch === '"') {
      q = ch;
      cur += ch;
    } else if (ch === ';') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}
const unquote = (s: string) => s.replace(/'([^']*)'|"([^"]*)"/g, (_m, a, b) => a ?? b ?? '');

// ---------------------------------------------------------------- dates

export function formatDate(d: Date, fmt: string, o: FormatOptions = DEFAULT_OPTS): string {
  const L = o.locale;
  switch (fmt) {
    case 'd':
      return d.toLocaleDateString(L);
    case 'D':
      return d.toLocaleDateString(L, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    case 't':
      return d.toLocaleTimeString(L, { hour: '2-digit', minute: '2-digit' });
    case 'T':
      return d.toLocaleTimeString(L);
    case 'f':
      return d.toLocaleDateString(L, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) + ' ' + d.toLocaleTimeString(L, { hour: '2-digit', minute: '2-digit' });
    case 'F':
      return d.toLocaleDateString(L, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) + ' ' + d.toLocaleTimeString(L);
    case 'g':
      return d.toLocaleDateString(L) + ' ' + d.toLocaleTimeString(L, { hour: '2-digit', minute: '2-digit' });
    case 'G':
      return d.toLocaleString(L);
    case 'M':
    case 'm':
      return d.toLocaleDateString(L, { month: 'long', day: 'numeric' });
    case 'Y':
    case 'y':
      return d.toLocaleDateString(L, { month: 'long', year: 'numeric' });
    case 's':
      return customDate(d, "yyyy-MM-dd'T'HH:mm:ss", L);
    case 'u':
      return customDate(d, "yyyy-MM-dd HH:mm:ss'Z'", L);
    case 'o':
    case 'O':
      return d.toISOString();
  }
  return customDate(d, fmt, L);
}

const monthNames = (L: string, style: 'long' | 'short') => {
  const f = new Intl.DateTimeFormat(L, { month: style });
  return Array.from({ length: 12 }, (_, i) => f.format(new Date(2000, i, 1)));
};
const dayNames = (L: string, style: 'long' | 'short') => {
  const f = new Intl.DateTimeFormat(L, { weekday: style });
  return Array.from({ length: 7 }, (_, i) => f.format(new Date(2000, 0, 2 + i))); // 2000-01-02 is Sunday
};
const nameCache = new Map<string, string[]>();
const cached = (k: string, fn: () => string[]) => {
  let v = nameCache.get(k);
  if (!v) nameCache.set(k, (v = fn()));
  return v;
};

function customDate(d: Date, fmt: string, L: string): string {
  const re = /'[^']*'|"[^"]*"|yyyy|yy|MMMM|MMM|MM|M|dddd|ddd|dd|d|HH|H|hh|h|mm|m|ss|s|fff|ff|f|tt|t|zzz|\\./g;
  const p2 = (n: number) => String(n).padStart(2, '0');
  return fmt.replace(re, (tok) => {
    switch (tok) {
      case 'yyyy':
        return String(d.getFullYear()).padStart(4, '0');
      case 'yy':
        return p2(d.getFullYear() % 100);
      case 'MMMM':
        return cached('ML' + L, () => monthNames(L, 'long'))[d.getMonth()];
      case 'MMM':
        return cached('MS' + L, () => monthNames(L, 'short'))[d.getMonth()];
      case 'MM':
        return p2(d.getMonth() + 1);
      case 'M':
        return String(d.getMonth() + 1);
      case 'dddd':
        return cached('DL' + L, () => dayNames(L, 'long'))[d.getDay()];
      case 'ddd':
        return cached('DS' + L, () => dayNames(L, 'short'))[d.getDay()];
      case 'dd':
        return p2(d.getDate());
      case 'd':
        return String(d.getDate());
      case 'HH':
        return p2(d.getHours());
      case 'H':
        return String(d.getHours());
      case 'hh':
        return p2(d.getHours() % 12 || 12);
      case 'h':
        return String(d.getHours() % 12 || 12);
      case 'mm':
        return p2(d.getMinutes());
      case 'm':
        return String(d.getMinutes());
      case 'ss':
        return p2(d.getSeconds());
      case 's':
        return String(d.getSeconds());
      case 'fff':
        return String(d.getMilliseconds()).padStart(3, '0');
      case 'ff':
        return String(Math.floor(d.getMilliseconds() / 10)).padStart(2, '0');
      case 'f':
        return String(Math.floor(d.getMilliseconds() / 100));
      case 'tt':
        return d.getHours() < 12 ? 'AM' : 'PM';
      case 't':
        return d.getHours() < 12 ? 'A' : 'P';
      case 'zzz': {
        const off = -d.getTimezoneOffset();
        return (off >= 0 ? '+' : '-') + p2(Math.floor(Math.abs(off) / 60)) + ':' + p2(Math.abs(off) % 60);
      }
    }
    if (tok.startsWith('\\')) return tok.slice(1);
    return tok.slice(1, -1); // quoted literal
  });
}

export const FORMAT_PRESETS: { label: string; value: string }[] = [
  { label: '(none)', value: '' },
  { label: 'Number 1,234.57', value: 'n2' },
  { label: 'Number 1,235', value: 'n0' },
  { label: 'Currency $1,234.57', value: 'c2' },
  { label: 'Currency $1,235', value: 'c0' },
  { label: 'Percent 12.35%', value: 'p2' },
  { label: 'Percent 12%', value: 'p0' },
  { label: 'Fixed 1234.57', value: 'f2' },
  { label: 'Custom #,##0.00', value: '#,##0.00' },
  { label: 'Padded 00042', value: 'd5' },
  { label: 'Short date', value: 'd' },
  { label: 'Long date', value: 'D' },
  { label: 'Date yyyy-MM-dd', value: 'yyyy-MM-dd' },
  { label: 'Date dd/MM/yyyy', value: 'dd/MM/yyyy' },
  { label: 'Date MM/dd/yyyy', value: 'MM/dd/yyyy' },
  { label: 'Date MMM d, yyyy', value: 'MMM d, yyyy' },
  { label: 'Month MMMM yyyy', value: 'MMMM yyyy' },
  { label: 'Date + time', value: 'g' },
  { label: 'Time HH:mm', value: 'HH:mm' },
  { label: 'Yes / No', value: 'Yes;No' },
];
