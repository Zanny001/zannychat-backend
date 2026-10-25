const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migrationsDir = path.resolve(__dirname, '../supabase/migrations');

test('Supabase migration version prefixes are unique and numeric', () => {
  const files = fs.readdirSync(migrationsDir).filter((name) => name.endsWith('.sql'));
  const versions = new Map();
  const invalid = [];
  for (const file of files) {
    const match = file.match(/^(\d+)_.*\.sql$/);
    if (!match) {
      invalid.push(file);
      continue;
    }
    const version = match[1];
    if (versions.has(version)) versions.get(version).push(file);
    else versions.set(version, [file]);
  }
  assert.deepEqual(invalid, [], `Migration filenames must start with a numeric version: ${invalid.join(', ')}`);
  const duplicates = [...versions.entries()].filter(([, names]) => names.length > 1)
    .map(([version, names]) => `${version}: ${names.join(', ')}`);
  assert.deepEqual(duplicates, [], `Duplicate migration versions: ${duplicates.join('; ')}`);
});
