/**
 * A small curated corpus of Node.js memory-internals notes the researcher
 * sub-agents query with the `knowledge_search` tool. Each entry carries a
 * citation id (C1..C8) so the final report's citations can be grounded: a
 * citation is valid only if its id exists here AND was actually returned by
 * a search call during the run (the tool records what it served).
 */

export interface CorpusEntry {
  id: string;
  title: string;
  url: string;
  text: string;
  keywords: string[];
}

export const CORPUS: CorpusEntry[] = [
  {
    id: 'C1',
    title: 'V8 heap limit and --max-old-space-size',
    url: 'https://nodejs.org/api/cli.html#--max-old-space-sizesize-in-mib',
    text: 'V8 caps the old-generation heap (about 2-4 GiB depending on version and pointer compression). When live old-space objects approach the limit, GC runs longer and more often; once no GC cycle can free enough, the process throws "JavaScript heap out of memory" and exits. --max-old-space-size=<MiB> raises the cap.',
    keywords: ['heap', 'max-old-space-size', 'oom', 'v8', 'limit', 'old space'],
  },
  {
    id: 'C2',
    title: 'GC pauses under pressure',
    url: 'https://nodejs.org/en/learn/diagnostics/memory',
    text: 'As heap occupancy climbs, scavenges (young-gen) stay cheap but mark-sweep-compact cycles over old space get frequent and long. Stop-the-world pauses grow from single-digit ms to hundreds of ms or seconds, which is the first user-visible symptom: latency spikes while RSS is still below the cap.',
    keywords: ['gc', 'pause', 'scavenge', 'mark-sweep', 'latency', 'stop-the-world'],
  },
  {
    id: 'C3',
    title: 'Event loop lag under memory pressure',
    url: 'https://nodejs.org/api/perf_hooks.html#performanceeventloopdelay',
    text: 'Long GC pauses monopolize the main thread, so timers and I/O callbacks run late: event-loop delay (perf_hooks.monitorEventLoopDelay) p95/p99 climbs before the process dies. A common first-break symptom is health-check and keep-alive timeouts even though CPU is idle.',
    keywords: ['event loop', 'lag', 'delay', 'timer', 'health check', 'perf_hooks'],
  },
  {
    id: 'C4',
    title: 'RSS vs heap: external and native memory',
    url: 'https://nodejs.org/api/process.html#processmemoryusage',
    text: 'process.memoryUsage() splits heapUsed/heapTotal from external (Buffers, ArrayBuffers) and rss. Buffers and native addons allocate outside the V8 heap, so RSS can blow past the heap cap; --max-old-space-size does not bound external memory. Leaks in Buffer pools or native code evade the heap OOM entirely.',
    keywords: ['rss', 'external', 'buffer', 'native', 'memoryusage', 'arraybuffer'],
  },
  {
    id: 'C5',
    title: 'Container and OS OOM killer',
    url: 'https://nodejs.org/api/process.html',
    text: 'Under cgroup/container limits the Linux OOM killer terminates the process with SIGKILL (exit 137) before V8 ever throws its heap error, because the limit applies to RSS, not the V8 heap. Mis-sizing --max-old-space-size above the cgroup limit means the kernel kills first.',
    keywords: ['oom killer', 'sigkill', 'exit 137', 'cgroup', 'container', 'kubernetes'],
  },
  {
    id: 'C6',
    title: 'Diagnosing with heap snapshots',
    url: 'https://nodejs.org/api/v8.html#v8getheapsnapshot',
    text: 'v8.getHeapSnapshot() / --heapsnapshot-signal write a snapshot for Chrome DevTools diffing. Taking a snapshot under pressure roughly doubles live-heap usage transiently and can itself trigger the OOM it was meant to diagnose; --heap-prof is the lighter-weight alternative.',
    keywords: ['heapdump', 'heapsnapshot', 'snapshot', 'diagnose', 'heap-prof', 'devtools'],
  },
  {
    id: 'C7',
    title: 'Allocation rate vs leak',
    url: 'https://nodejs.org/en/learn/diagnostics/memory',
    text: 'High allocation churn fills young space fast and forces frequent scavenges; a genuine leak retains objects across GCs so old space grows monotonically. The tell: heapUsed drops after GC for churn, but ratchets up for a leak. Closures, caches without eviction and listener leaks are the usual retainers.',
    keywords: ['leak', 'allocation', 'churn', 'retain', 'cache', 'listeners'],
  },
  {
    id: 'C8',
    title: 'Mitigations and backpressure',
    url: 'https://nodejs.org/api/stream.html',
    text: 'Stream backpressure (pipeline/pipe respecting highWaterMark), bounded queues, and shedding load keep allocation rate under GC throughput. Without backpressure, request queues and buffers grow unboundedly and the app dies from its own backlog, not the traffic peak itself.',
    keywords: ['backpressure', 'stream', 'queue', 'highwatermark', 'load shedding'],
  },
];

const STOPWORDS = new Set(
  'the a an and or of to in for on is are was how do does what when why this that with their its it be by at as from into than then they them we you your can each every'.split(' ')
);

function termsOf(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .filter((word) => word.length > 2 && !STOPWORDS.has(word));
}

/** Corpus entries matching `query`, best overlap first. */
export function searchCorpus(query: string, limit = 4): CorpusEntry[] {
  const terms = new Set(termsOf(query));
  return CORPUS.map((entry) => {
    const haystack = new Set([
      ...termsOf(entry.title),
      ...termsOf(entry.text),
      ...entry.keywords.flatMap(termsOf),
    ]);
    return { entry, score: [...terms].filter((t) => haystack.has(t)).length };
  })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ entry }) => entry);
}

/** Ids the search tool actually served this run - the set a citation may legitimately point at. */
export const servedIds = new Set<string>();
/** Overlap stats proving parallel researchers hit the tool concurrently. */
export const searchStats = { calls: 0, inFlight: 0, maxConcurrent: 0 };
