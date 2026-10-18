import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
export function score(cases, annotations) {
  if (!Array.isArray(cases) || !Array.isArray(annotations)) throw new Error('Expected arrays');
  const references = new Map(cases.map(item => [item.id, item]));
  if (references.size !== cases.length || annotations.length !== cases.length) throw new Error('Missing or duplicate cases');
  let found = 0, total = 0, violations = 0;
  const seen = new Set();
  const results = [];
  for (const row of annotations) {
    const reference = references.get(row.id);
    if (!reference || seen.has(row.id)) throw new Error('Unknown or duplicate case: ' + row.id);
    seen.add(row.id);
    for (const [key, allowed] of [['detected', reference.expected], ['violations', reference.forbidden]]) {
      if (!Array.isArray(row[key]) || new Set(row[key]).size !== row[key].length || row[key].some(value => !allowed.includes(value))) {
        throw new Error('Invalid ' + key + ' labels for ' + row.id);
      }
    }
    found += row.detected.length;
    total += reference.expected.length;
    violations += row.violations.length;
    results.push({ id: row.id, detected: row.detected.length, expected: reference.expected.length, violations: row.violations.length });
  }
  return { cases: cases.length, ambiguityRecall: total ? found / total : null, detected: found, expected: total, unsupportedAssumptionViolations: violations, results };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const filename = process.argv[2];
  if (!filename) { console.error('Usage: node benchmarks/intentbench/evaluate.mjs <annotations.json>'); process.exitCode = 2; }
  else {
    try {
      const cases = JSON.parse(readFileSync(resolve(directory, 'cases.json'), 'utf8'));
      const annotations = JSON.parse(readFileSync(resolve(filename), 'utf8'));
      console.log(JSON.stringify(score(cases, annotations), null, 2));
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
