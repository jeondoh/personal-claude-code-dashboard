import fs from 'node:fs';
import path from 'node:path';
import { agentInfo, type Card, type Column, type TimelineItem } from '@/lib/events';
import { fmArray, fmString, parseFrontmatter } from '@/lib/frontmatter';

// Read-only: build the board straight from the ticket folder (directory = status).
// This is the source of truth — the plugin moves files between tickets/<status>/
// on every transition, whereas events.jsonl can lag. The client polls this.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const EVENTS_LOG =
  process.env.EVENTS_LOG ||
  path.resolve(process.cwd(), '../personal-claude-code-v2/.claude-team/events.jsonl');
const TEAM_ROOT = path.dirname(EVENTS_LOG);

// dir name (under tickets/) → board column
const DIR_TO_COLUMN: Record<string, Column> = {
  queue: 'queue',
  'in-progress': 'in-progress',
  'in-review': 'in-review',
  done: 'done',
  cancelled: 'cancelled',
  hold: 'in-progress', // paused work still belongs with active
};
// Historical columns can be huge — show only the most recent N (by id desc).
const RECENT_CAP: Partial<Record<Column, number>> = { done: 50, cancelled: 20 };
const FM_BYTES = 4096; // enough to cover frontmatter without reading whole bodies

/** Read just the leading chunk of a file (frontmatter lives at the top). */
function readHead(file: string, bytes = FM_BYTES): string {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.toString('utf8', 0, n);
  } finally {
    fs.closeSync(fd);
  }
}

const firstTs = (...vals: Array<string | undefined>) => vals.find((v) => !!v);

function buildTimeline(c: {
  createdTs: string;
  startedTs?: string;
  updatedTs: string;
  column: Column;
}): TimelineItem[] {
  const tl: TimelineItem[] = [];
  let seq = 0;
  const add = (ts: string | undefined, label: string, tone: TimelineItem['tone']) => {
    if (ts) tl.push({ seq: seq++, ts, event: 'fs', actor: '', label, tone });
  };
  add(c.createdTs, '생성 (queue)', 'info');
  if (c.startedTs && c.startedTs !== c.createdTs) add(c.startedTs, '작업 시작', 'active');
  if (c.column === 'done') add(c.updatedTs, '완료', 'good');
  else if (c.column === 'cancelled') add(c.updatedTs, '취소', 'bad');
  else if (c.updatedTs !== c.createdTs && c.updatedTs !== c.startedTs)
    add(c.updatedTs, '마지막 업데이트', 'info');
  return tl;
}

function toCard(file: string, column: Column): Card | null {
  const { frontmatter: fm } = parseFrontmatter(readHead(file));
  const id = fmString(fm.id) || path.basename(file).replace(/\.md$/, '');
  if (!id) return null;

  const assignee = fmString(fm.assignee);
  const target = fmString(fm.target);
  const agent = agentInfo(assignee, target);

  const createdTs = fmString(fm.created) || '';
  const updatedTs = fmString(fm.updated) || fmString(fm.last_update_at) || createdTs;
  const startedTs = firstTs(fmString(fm.started), fmString(fm.claimed_at));
  const active = column === 'in-progress';

  const prUrl = fmString(fm.pr_url) || fmString(fm.pr);
  const prNum = prUrl ? Number(prUrl.match(/(\d+)\s*$/)?.[1]) : NaN;

  return {
    id,
    title: fmString(fm.title) || id,
    column,
    squad: agent.squad,
    assignee: agent.skill ?? assignee,
    complexity: fmString(fm.complexity),
    feature: fmString(fm.parent_feature) || null,
    filesInScope: fmArray(fm.files_in_scope),
    dependsOn: fmArray(fm.depends_on),
    branch: fmString(fm.branch),
    pr: Number.isFinite(prNum) ? prNum : undefined,
    stages: [],
    createdTs,
    claimedTs: startedTs,
    doneTs: column === 'done' || column === 'cancelled' ? updatedTs : undefined,
    updatedTs,
    activeSkill: active ? agent.skill ?? assignee : undefined,
    activeAgentName: active ? agent.name : undefined,
    activeSince: active ? firstTs(startedTs, createdTs) : undefined,
    timeline: buildTimeline({ createdTs, startedTs, updatedTs, column }),
  };
}

function scanColumn(dir: string, column: Column): { cards: Card[]; total: number } {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.md'));
  } catch {
    return { cards: [], total: 0 };
  }
  names.sort((a, b) => (a < b ? 1 : -1)); // id desc → newest first
  const total = names.length;
  const cap = RECENT_CAP[column];
  const slice = cap ? names.slice(0, cap) : names;
  const cards = slice
    .map((n) => {
      try {
        return toCard(path.join(dir, n), column);
      } catch {
        return null;
      }
    })
    .filter((c): c is Card => !!c);
  return { cards, total };
}

export function GET() {
  const ticketsDir = path.join(TEAM_ROOT, 'tickets');
  const cards: Card[] = [];
  const totals: Record<string, number> = {};

  for (const [dir, column] of Object.entries(DIR_TO_COLUMN)) {
    const { cards: cc, total } = scanColumn(path.join(ticketsDir, dir), column);
    cards.push(...cc);
    totals[dir] = total;
  }

  cards.sort((a, b) => (a.id < b.id ? 1 : -1)); // newest first

  return new Response(
    JSON.stringify({ root: TEAM_ROOT, totals, count: cards.length, cards }),
    { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } },
  );
}
