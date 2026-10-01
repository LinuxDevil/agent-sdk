// Coverage run (`npm run test:coverage`). Same file set as the default
// `vitest run`; kept as its own config so coverage-only settings have a home.
// Its `coverage/coverage-final.json` output feeds fallow's CRAP scores (see
// `health.coverage` in .fallowrc.json).
export { default } from './vitest.config';
