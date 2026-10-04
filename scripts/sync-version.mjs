// Syncs the exported VERSION constant and the create-lousho-agent scaffold's
// SDK dependency pin to the root package.json `version`. Run after any
// `npm version` bump — the pre-release scripts do this for you.
import fs from 'node:fs';

const root = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const version = root.version;

const indexPath = 'src/index.ts';
const indexSrc = fs.readFileSync(indexPath, 'utf8');
if (!/export const VERSION = '[^']+'/.test(indexSrc)) throw new Error('sync-version: VERSION export not found in src/index.ts');
const next = indexSrc.replace(/export const VERSION = '[^']+'/, `export const VERSION = '${version}'`);
if (next !== indexSrc) fs.writeFileSync(indexPath, next);

const scaffoldPath = 'packages/create-lousho-agent/package.json';
const scaffold = JSON.parse(fs.readFileSync(scaffoldPath, 'utf8'));
scaffold.dependencies['@lousho/build-ai-agent'] = `^${version}`;
fs.writeFileSync(scaffoldPath, JSON.stringify(scaffold, null, 2) + '\n');

console.log(`sync-version: VERSION and scaffold pin set to ${version}`);
