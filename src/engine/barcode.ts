// Barcode encoders: Code 128 (B/C auto), Code 39, EAN-13 and QR (via qrcode-generator).
import qrcode from 'qrcode-generator';

const C128 = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];

/** Returns module pattern: string of '1' (bar) and '0' (space). */
function widthsToModules(widths: string, startBar = true): string {
  let out = '';
  let bar = startBar;
  for (const w of widths) {
    out += (bar ? '1' : '0').repeat(Number(w));
    bar = !bar;
  }
  return out;
}

export function encodeCode128(text: string): string {
  const s = Array.from(text)
    .map((ch) => (ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) < 127 ? ch : '?'))
    .join('');
  const codes: number[] = [];
  let set: 'B' | 'C' | null = null;
  let i = 0;
  const digitRun = (from: number) => {
    let n = 0;
    while (from + n < s.length && s[from + n] >= '0' && s[from + n] <= '9') n++;
    return n;
  };
  while (i < s.length) {
    const run = digitRun(i);
    const useC = run >= 4 || (run >= 2 && run === s.length - i && (set === 'C' || set === null) && run % 2 === 0);
    if (useC) {
      const pairs = Math.floor(run / 2) * 2;
      if (set !== 'C') {
        codes.push(set === null ? 105 : 99);
        set = 'C';
      }
      for (let k = 0; k < pairs; k += 2) codes.push(Number(s.substr(i + k, 2)));
      i += pairs;
      continue;
    }
    if (set !== 'B') {
      codes.push(set === null ? 104 : 100);
      set = 'B';
    }
    codes.push(s.charCodeAt(i) - 32);
    i++;
  }
  if (codes.length === 0) codes.push(104);
  let sum = codes[0];
  for (let k = 1; k < codes.length; k++) sum += codes[k] * k;
  codes.push(sum % 103);
  codes.push(106);
  return codes.map((c) => widthsToModules(C128[c])).join('');
}

const C39: Record<string, string> = {
  '0': 'nnnwwnwnn', '1': 'wnnwnnnnw', '2': 'nnwwnnnnw', '3': 'wnwwnnnnn', '4': 'nnnwwnnnw', '5': 'wnnwwnnnn',
  '6': 'nnwwwnnnn', '7': 'nnnwnnwnw', '8': 'wnnwnnwnn', '9': 'nnwwnnwnn', A: 'wnnnnwnnw', B: 'nnwnnwnnw',
  C: 'wnwnnwnnn', D: 'nnnnwwnnw', E: 'wnnnwwnnn', F: 'nnwnwwnnn', G: 'nnnnnwwnw', H: 'wnnnnwwnn',
  I: 'nnwnnwwnn', J: 'nnnnwwwnn', K: 'wnnnnnnww', L: 'nnwnnnnww', M: 'wnwnnnnwn', N: 'nnnnwnnww',
  O: 'wnnnwnnwn', P: 'nnwnwnnwn', Q: 'nnnnnnwww', R: 'wnnnnnwwn', S: 'nnwnnnwwn', T: 'nnnnwnwwn',
  U: 'wwnnnnnnw', V: 'nwwnnnnnw', W: 'wwwnnnnnn', X: 'nwnnwnnnw', Y: 'wwnnwnnnn', Z: 'nwwnwnnnn',
  '-': 'nwnnnnwnw', '.': 'wwnnnnwnn', ' ': 'nwwnnnwnn', '*': 'nwnnwnwnn', $: 'nwnwnwnnn', '/': 'nwnwnnnwn',
  '+': 'nwnnnwnwn', '%': 'nnnwnwnwn',
};

export function encodeCode39(text: string): string {
  const s = '*' + text.toUpperCase().replace(/\*/g, '') + '*';
  let out = '';
  for (const ch of s) {
    const p = C39[ch];
    if (!p) throw new Error(`Character '${ch}' is not valid in Code 39`);
    out += widthsToModules(p.replace(/n/g, '1').replace(/w/g, '3')) + '0';
  }
  return out;
}

const EAN_L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const EAN_G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'];
const EAN_R = ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100'];
const EAN_PAR = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

export function ean13Digits(text: string): string {
  const d = text.replace(/\D/g, '');
  if (d.length < 12 || d.length > 13) throw new Error('EAN-13 needs 12 or 13 digits');
  const base = d.slice(0, 12);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(base[i]) * (i % 2 ? 3 : 1);
  const check = (10 - (sum % 10)) % 10;
  return base + check;
}

export function encodeEan13(text: string): string {
  const d = ean13Digits(text);
  const par = EAN_PAR[Number(d[0])];
  let out = '101';
  for (let i = 1; i <= 6; i++) out += (par[i - 1] === 'L' ? EAN_L : EAN_G)[Number(d[i])];
  out += '01010';
  for (let i = 7; i <= 12; i++) out += EAN_R[Number(d[i])];
  out += '101';
  return out;
}

export function encodeQr(text: string): boolean[][] {
  (qrcode as any).stringToBytes = (qrcode as any).stringToBytesFuncs['UTF-8'];
  const qr = qrcode(0, 'M');
  qr.addData(text || ' ', 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  const m: boolean[][] = [];
  for (let r = 0; r < n; r++) {
    const row: boolean[] = [];
    for (let c = 0; c < n; c++) row.push(qr.isDark(r, c));
    m.push(row);
  }
  return m;
}
