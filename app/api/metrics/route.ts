import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter, fmString } from '@/lib/frontmatter';

// Read-only monitoring metrics, derived from the same ticket tree + event log the
// board reads. Kept in a separate endpoint so it can be polled on a slower cadence
// than the board (it stats the whole done/ history and reads a bounded recent
// window of frontmatter). Never writes plugin state.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const EVENTS_LOG =
  process.env.EVENTS_LOG ||
  path.resolve(process.cwd(), '../personal-claude-code-v2/.claude-team/events.jsonl');
const TEAM_ROOT = path.dirname(EVENTS_LOG);
const TICKETS = path.join(TEAM_ROOT, 'tickets');

const FM_BYTES = 4096;
const KST_OFFSET_MS = 9 * 3600_000;
const DAY_MS = 86400_000;
const THROUGHPUT_DAYS = 14; // bars in the throughput chart
const CYCLE_WINDOW = 150; // most-recent done tickets sampled for cycle-time / squad mix

/** KST calendar day (YYYY-MM-DD) for an epoch-ms instant. */
const kstDay = (ms: number) => new Date(ms + KST_OFFSET_MS).toISOString().slice(0, 10);

function listMd(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((n) => n.endsWith('.md'));
  } catch {
    return [];
  }
}
const countMd = (dir: string) => listMd(dir).length;

function readHead(file: string): string {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(FM_BYTES);
    const n = fs.readSync(fd, buf, 0, FM_BYTES, 0);
    return buf.toString('utf8', 0, n);
  } finally {
    fs.closeSync(fd);
  }
}

const squadOfTarget = (t?: string): string => {
  const v = (t ?? '').toLowerCase();
  if (v === 'be' || v === 'backend') return 'BE';
  if (v === 'fe' || v === 'frontend') return 'FE';
  if (v === 'design' || v === 'both') return 'design';
  return 'other';
};

const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const quantile = (xs: number[], q: number): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.floor(q * s.length));
  return s[idx];
};

export function GET() {
  const now = Date.now();

  // --- Active pipeline counts (cheap dir scans) ---
  const wip =
    countMd(path.join(TICKETS, 'in-flight')) +
    countMd(path.join(TICKETS, 'in-progress')) +
    countMd(path.join(TICKETS, 'hold'));
  const inReview = countMd(path.join(TICKETS, 'in-review'));
  const queue = countMd(path.join(TICKETS, 'queue'));
  const cancelled = countMd(path.join(TICKETS, 'cancelled'));
  const backlog = countMd(path.join(TEAM_ROOT, 'backlog')); // top-level BL only

  // --- Throughput: bucket done/ files by completion day (file mtime proxy) ---
  const doneDir = path.join(TICKETS, 'done');
  const doneNames = listMd(doneDir);
  const totalDone = doneNames.length;
  const todayKey = kstDay(now);
  const since7d = now - 7 * DAY_MS;
  const days: string[] = [];
  for (let i = THROUGHPUT_DAYS - 1; i >= 0; i--) days.push(kstDay(now - i * DAY_MS));
  const dayCount = new Map<string, number>(days.map((d) => [d, 0]));

  let doneToday = 0;
  let done7d = 0;
  for (const n of doneNames) {
    let mtime: number;
    try {
      mtime = fs.statSync(path.join(doneDir, n)).mtimeMs;
    } catch {
      continue;
    }
    const key = kstDay(mtime);
    if (dayCount.has(key)) dayCount.set(key, (dayCount.get(key) ?? 0) + 1);
    if (key === todayKey) doneToday++;
    if (mtime >= since7d) done7d++;
  }
  const throughput = days.map((day) => ({ day, count: dayCount.get(day) ?? 0 }));

  // --- Cycle time + squad mix over the most-recent done window (bounded reads) ---
  const recentDone = [...doneNames].sort((a, b) => (a < b ? 1 : -1)).slice(0, CYCLE_WINDOW);
  const cycleHours: number[] = [];
  const squadCount = new Map<string, number>();
  for (const n of recentDone) {
    const file = path.join(doneDir, n);
    let head: string;
    let mtime: number;
    try {
      head = readHead(file);
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      continue;
    }
    const { frontmatter: fm } = parseFrontmatter(head);
    squadCount.set(
      squadOfTarget(fmString(fm.target)),
      (squadCount.get(squadOfTarget(fmString(fm.target))) ?? 0) + 1,
    );
    const createdRaw = fmString(fm.created);
    const doneRaw = fmString(fm.completed_at) || fmString(fm.done);
    const startMs = createdRaw ? Date.parse(createdRaw) : NaN;
    const endMs = doneRaw ? Date.parse(doneRaw) : mtime;
    if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs) {
      cycleHours.push((endMs - startMs) / 3600_000);
    }
  }
  const bySquad = [...squadCount.entries()]
    .map(([squad, count]) => ({ squad, count }))
    .sort((a, b) => b.count - a.count);

  // --- Merge cadence + open review/rescue load from the event log (single read) ---
  let merged7d = 0;
  let mergedTotal = 0;
  try {
    const raw = fs.readFileSync(EVENTS_LOG, 'utf8');
    for (const line of raw.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      let e: { event?: string; ts?: string };
      try {
        e = JSON.parse(s);
      } catch {
        continue;
      }
      if (e.event === 'ticket.merged' || e.event === 'release.merged') {
        mergedTotal++;
        if (e.ts && Date.parse(e.ts) >= since7d) merged7d++;
      }
    }
  } catch {
    /* no event log → merge metrics stay 0 */
  }

  // --- Rescue / review load across active tickets (bounded — few active) ---
  let openRescues = 0;
  let openReviews = 0;
  for (const d of ['in-flight', 'in-progress', 'hold', 'in-review']) {
    const dir = path.join(TICKETS, d);
    for (const n of listMd(dir)) {
      try {
        const { frontmatter: fm } = parseFrontmatter(readHead(path.join(dir, n)));
        openRescues += Number(fmString(fm.rescue_count)) || 0;
        openReviews += Number(fmString(fm.review_rounds)) || 0;
      } catch {
        /* skip unreadable */
      }
    }
  }

  return new Response(
    JSON.stringify({
      generatedAt: new Date(now).toISOString(),
      kpis: {
        wip,
        inReview,
        queue,
        backlog,
        cancelled,
        doneToday,
        done7d,
        merged7d,
        mergedTotal,
        totalDone,
        medianCycleHours: Math.round(median(cycleHours) * 10) / 10,
        p90CycleHours: Math.round(quantile(cycleHours, 0.9) * 10) / 10,
        cycleSample: cycleHours.length,
        openRescues,
        openReviews,
      },
      throughput,
      bySquad,
    }),
    { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } },
  );
}
