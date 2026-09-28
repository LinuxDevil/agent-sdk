/**
 * Minimal, dependency-free "lint": rejects use of `var` in src/*.js.
 * Standing in for a real lint config so this fixture repo has zero
 * node_modules of its own (LOU-E11's tests mutate a scratch copy of this
 * fixture and don't want to run `npm install` per test).
 */
const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, 'src');
let failed = false;

for (const file of fs.readdirSync(srcDir)) {
  if (!file.endsWith('.js')) continue;
  const content = fs.readFileSync(path.join(srcDir, file), 'utf8');
  if (/\bvar\s/.test(content)) {
    console.error(`Lint error in ${file}: use of 'var' is not allowed, use const/let`);
    failed = true;
  }
}

if (failed) {
  process.exit(1);
}
console.log('Lint passed');
