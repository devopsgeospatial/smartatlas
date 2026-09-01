/* Smoke test for the search parser. Run: npm run check:search */
import { interpret } from '../src/lib/search';

const cases: [string, string][] = [
  ['-1.9441, 30.0619', 'coords'],
  ['-1.9441,30.0619', 'coords'],
  ['30.0619, -1.9441', 'coords'],           // reversed — must be corrected
  ['1.9441S, 30.0619E', 'coords'],
  ['1°56\'38.8"S 30°03\'42.8"E', 'coords'],
  ['https://www.google.com/maps/@-1.9441,30.0619,17z', 'coords'],
  ['https://maps.google.com/?q=-1.9441,30.0619', 'coords'],
  ['1/03/07/02/1234', 'upi'],
  ['1 / 03 / 07 / 02 / 1234', 'upi'],
  ['Remera', 'sector'],
  ['reme', 'sector'],
  ['KIMIRONKO', 'sector'],
  ['', 'empty'],
  ['zzzz nonsense', 'unknown'],
  ['51.5074, -0.1278', 'coords'],           // London — valid, flagged outside
];

let fail = 0;
for (const [input, expected] of cases) {
  const r = interpret(input);
  const ok = r.kind === expected;
  if (!ok) fail++;
  const detail =
    r.kind === 'coords'
      ? `${r.label}  [${r.detail}]`
      : r.kind === 'sector'
        ? `${r.label} (${r.detail})`
        : r.kind === 'upi'
          ? r.label
          : '';
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${JSON.stringify(input).padEnd(46)} -> ${r.kind.padEnd(8)} ${detail}`);
}

// Order correction must produce the same point from either input order.
const a = interpret('-1.9441, 30.0619');
const b = interpret('30.0619, -1.9441');
if (a.kind === 'coords' && b.kind === 'coords') {
  const same = a.lat === b.lat && a.lon === b.lon;
  if (!same) fail++;
  console.log(`${same ? 'PASS' : 'FAIL'}  reversed pair resolves to the same point`);
} else {
  fail++;
}

console.log(fail === 0 ? '\nAll checks passed.' : `\n${fail} check(s) failed.`);
process.exit(fail === 0 ? 0 : 1);
