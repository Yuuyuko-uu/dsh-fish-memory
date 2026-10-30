import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { exportContractBundle } from '../src/contracts/registry.ts';
import { fixtureSet, legacyFixture } from '../fixtures/scenarios.ts';

const check = process.argv.includes('--check');
if (process.argv.slice(2).some(arg => arg !== '--check')) throw new Error('Only --check is supported');
const outputs = [
  ['../contracts/schema-bundle.json', exportContractBundle()],
  ['../fixtures/conversations.generated.json', fixtureSet],
  ['../fixtures/dsh-import.generated.json', legacyFixture],
] as const;
for (const [relative, value] of outputs) {
  const path = fileURLToPath(new URL(relative, import.meta.url));
  const expected = JSON.stringify(value, null, 2) + '\n';
  if (check) {
    if (readFileSync(path, 'utf8') !== expected) throw new Error(`Generated contract drift: ${relative}. Run npm run schemas:write.`);
  } else writeFileSync(path, expected, { encoding: 'utf8' });
  process.stdout.write(`${check ? 'checked' : 'wrote'} ${relative}\n`);
}
