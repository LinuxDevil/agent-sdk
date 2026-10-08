import { sqlite, transcript, brief } from '../inspect.js';
console.log(sqlite('SELECT id, length(payload) n FROM sessions'));
console.log(brief(transcript('smoke-2')).join('\n'));
console.log(JSON.stringify(transcript('smoke-2')[1]).slice(0,400));
