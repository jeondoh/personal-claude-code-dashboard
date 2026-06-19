import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Token-usage metrics, aggregated from Claude Code's own transcripts
// (~/.claude/projects/<encoded-cwd>/*.jsonl) — the only place per-message `usage`
// (input/output/cache tokens + model + timestamp) is recorded. The plugin's
// events.jsonl carries no token data, so this reaches OUTSIDE .claude-team, but
// stays strictly read-only.
//
// Caveats this endpoint inherits from its source:
//  - Covers ALL Claude Code activity under the monitored workspace (the plugin's
//    background workflow agents AND any manual sessions) — not just workflows.
//  - Cost is approximate: per-model list price, no enterprise/discount terms.
//  - Other CLIs (Codex, Gemini) are not in these transcripts.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const EVENTS_LOG =
  process.env.EVENTS_LOG ||
  path.resolve(process.cwd(), '../personal-claude-code-v2/.claude-team/events.jsonl');
// Monitored workspace = parent of .claude-team. Claude Code encodes a cwd into a
// projects dir name by replacing every `/` and `.` with `-`.
const WORKSPACE = path.dirname(path.dirname(EVENTS_LOG));
const ENCODED_BASE = WORKSPACE.replace(/[/.]/g, '-');
const PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects');

const KST_OFFSET_MS = 9 * 3600_000;
const DAY_MS = 86400_000;
const SERIES_DAYS = 14;

const kstDay = (ms: number) => new Date(ms + KST_OFFSET_MS).toISOString().slice(0, 10);

// Input $/MTok per model family; output is exactly 5× input for all three.
// Cache read = 0.1× input; cache write = 1.25× (5m TTL) / 2× (1h TTL).
const inputRatePerMTok = (model: string): number => {
  const m = model.toLowerCase();
  if (m.includes('haiku')) return 1;
  if (m.includes('sonnet')) return 3;
  return 5; // opus / fable / unknown → opus-tier
};

type Bucket = { input: number; output: number; cacheWrite: number; cacheRead: number; cost: number };
const emptyBucket = (): Bucket => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 });
const addInto = (a: Bucket, b: Bucket) => {
  a.input += b.input;
  a.output += b.output;
  a.cacheWrite += b.cacheWrite;
  a.cacheRead += b.cacheRead;
  a.cost += b.cost;
};

type FileAgg = {
  grand: Bucket;
  messages: number;
  byDay: Map<string, Bucket>;
  byModel: Map<string, Bucket & { messages: number }>;
};

// Per-file cache keyed by (size, mtime) — first request parses everything (the
// transcripts run to ~GBs); steady-state 60s polls only re-read the active file.
const cache = new Map<string, { size: number; mtimeMs: number; agg: FileAgg }>();

function parseFile(file: string): FileAgg {
  const agg: FileAgg = { grand: emptyBucket(), messages: 0, byDay: new Map(), byModel: new Map() };
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return agg;
  }
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let rec: {
      type?: string;
      timestamp?: string;
      message?: { model?: string; usage?: Record<string, number | Record<string, number>> };
    };
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const u = rec.message?.usage;
    if (rec.type !== 'assistant' || !u) continue;

    const model = rec.message?.model || 'unknown';
    const ir = inputRatePerMTok(model) / 1e6;
    const input = Number(u.input_tokens) || 0;
    const output = Number(u.output_tokens) || 0;
    const cacheRead = Number(u.cache_read_input_tokens) || 0;
    const cc = (u.cache_creation as Record<string, number> | undefined) ?? undefined;
    const write1h = Number(cc?.ephemeral_1h_input_tokens) || 0;
    const write5m =
      Number(cc?.ephemeral_5m_input_tokens) ||
      (cc ? 0 : Number(u.cache_creation_input_tokens) || 0); // fall back when no split
    const cacheWrite = write5m + write1h;
    const cost =
      input * ir +
      output * ir * 5 +
      cacheRead * ir * 0.1 +
      write5m * ir * 1.25 +
      write1h * ir * 2;

    const b: Bucket = { input, output, cacheWrite, cacheRead, cost };
    addInto(agg.grand, b);
    agg.messages += 1;

    const ts = rec.timestamp ? Date.parse(rec.timestamp) : NaN;
    if (Number.isFinite(ts)) {
      const day = kstDay(ts);
      const db = agg.byDay.get(day) ?? emptyBucket();
      addInto(db, b);
      agg.byDay.set(day, db);
    }
    const mb = agg.byModel.get(model) ?? { ...emptyBucket(), messages: 0 };
    addInto(mb, b);
    mb.messages += 1;
    agg.byModel.set(model, mb);
  }
  return agg;
}

function listProjectDirs(): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(PROJECTS_ROOT);
  } catch {
    return [];
  }
  // Exact workspace, or any nested dir (worktrees, backend, frontend, .claude-team).
  return names
    .filter((n) => n === ENCODED_BASE || n.startsWith(ENCODED_BASE + '-'))
    .map((n) => path.join(PROJECTS_ROOT, n));
}

/**
 * All transcript files under a project dir, recursing into subdirs. Subagent
 * transcripts live in `<session-uuid>/subagents/agent-*.jsonl` — those are the
 * workflow/Task agents' own token usage, so skipping them would undercount the
 * very work this panel is meant to surface.
 */
function walkJsonl(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkJsonl(full, out);
    else if (e.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

export function GET() {
  const now = Date.now();
  const todayKey = kstDay(now);
  const since7d = now - 7 * DAY_MS;

  let fileCount = 0;
  const grand = emptyBucket();
  let messages = 0;
  const byDay = new Map<string, Bucket>();
  const byModel = new Map<string, Bucket & { messages: number }>();

  for (const dir of listProjectDirs()) {
    for (const file of walkJsonl(dir)) {
      let st: fs.Stats;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      fileCount += 1;
      const cached = cache.get(file);
      let agg: FileAgg;
      if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) {
        agg = cached.agg;
      } else {
        agg = parseFile(file);
        cache.set(file, { size: st.size, mtimeMs: st.mtimeMs, agg });
      }
      addInto(grand, agg.grand);
      messages += agg.messages;
      for (const [day, b] of agg.byDay) {
        const db = byDay.get(day) ?? emptyBucket();
        addInto(db, b);
        byDay.set(day, db);
      }
      for (const [model, b] of agg.byModel) {
        const mb = byModel.get(model) ?? { ...emptyBucket(), messages: 0 };
        addInto(mb, b);
        mb.messages += b.messages;
        byModel.set(model, mb);
      }
    }
  }

  // Today / 7d windows from the day buckets.
  const today = emptyBucket();
  const last7d = emptyBucket();
  for (const [day, b] of byDay) {
    if (day === todayKey) addInto(today, b);
    const dayMs = Date.parse(day + 'T00:00:00+09:00');
    if (Number.isFinite(dayMs) && dayMs >= since7d - DAY_MS) addInto(last7d, b);
  }

  const days: string[] = [];
  for (let i = SERIES_DAYS - 1; i >= 0; i--) days.push(kstDay(now - i * DAY_MS));
  const series = days.map((day) => {
    const b = byDay.get(day) ?? emptyBucket();
    return { day, totalTokens: b.input + b.output + b.cacheWrite + b.cacheRead, cost: b.cost };
  });

  const models = [...byModel.entries()]
    .map(([model, b]) => ({
      model,
      messages: b.messages,
      input: b.input,
      output: b.output,
      cacheWrite: b.cacheWrite,
      cacheRead: b.cacheRead,
      cost: Math.round(b.cost * 100) / 100,
    }))
    .sort((a, b) => b.cost - a.cost);

  const round = (b: Bucket) => ({
    input: b.input,
    output: b.output,
    cacheWrite: b.cacheWrite,
    cacheRead: b.cacheRead,
    totalTokens: b.input + b.output + b.cacheWrite + b.cacheRead,
    cost: Math.round(b.cost * 100) / 100,
  });

  return new Response(
    JSON.stringify({
      generatedAt: new Date(now).toISOString(),
      coverage: { workspace: WORKSPACE, projectDirs: listProjectDirs().length, files: fileCount, messages },
      total: round(grand),
      today: round(today),
      last7d: round(last7d),
      series,
      models,
    }),
    { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } },
  );
}
