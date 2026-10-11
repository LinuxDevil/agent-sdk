#!/usr/bin/env node
'use strict';

const { main } = require('../dist/index.js');

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = typeof code === 'number' ? code : 0;
  },
  (err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exitCode = 1;
  }
);
