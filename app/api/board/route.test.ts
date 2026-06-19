import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Card } from '@/lib/events';

// The board route reads EVENTS_LOG at module load → build a temp .claude-team
// tree, point EVENTS_LOG at it, then dynamic-import the route. This exercises
// the new frontmatter fields (priority, progress_note, last_activity_at,
// rescue_count, review_rounds, started/done) and the derived
// staleness / ready-blocked / feature-rollup logic.

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'board-test-'));
const teamRoot = path.join(root, '.claude-team');
const tickets = path.join(teamRoot, 'tickets');

const write = (status: string, id: string, fm: string) => {
  const dir = path.join(tickets, status);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.md`), `---\n${fm}\n---\n# body\n`);
};

const old = new Date(Date.now() - 5 * 3600_000).toISOString(); // 5h ago → stale
const fresh = new Date(Date.now() - 60_000).toISOString(); // 1m ago → fresh

beforeAll(() => {
  process.env.EVENTS_LOG = path.join(teamRoot, 'events.jsonl');
  process.env.STALE_HOURS = '2';

  // queue: T-200 depends on a done ticket (READY, high), T-100 depends on a
  // not-done ticket (BLOCKED, low)
  write('queue', 'T-100', 'id: T-100\ntitle: low blocked\npriority: low\nparent_feature: F-1\ndepends_on:\n  - T-300');
  write('queue', 'T-200', 'id: T-200\ntitle: high ready\npriority: high\nparent_feature: F-1\ndepends_on:\n  - T-900');

  // in-progress: stale (old last_activity_at) vs fresh
  write('in-progress', 'T-300', `id: T-300\ntitle: stale wip\nparent_feature: F-1\nstarted: ${fresh}\nlast_activity_at: ${old}\nprogress_note: still wiring the repo\nrescue_count: 2\nreview_rounds: 3`);
  write('in-progress', 'T-400', `id: T-400\ntitle: fresh wip\nparent_feature: F-2\nstarted: ${fresh}\nlast_activity_at: ${fresh}`);
  // in-progress with no last_activity_at → unknown
  write('in-progress', 'T-500', 'id: T-500\ntitle: unknown wip\nparent_feature: standalone');

  // done: provides the satisfied dependency T-900
  write('done', 'T-900', `id: T-900\ntitle: done dep\nparent_feature: F-2\nstarted: ${old}\ndone: ${fresh}`);

  // The plugin's active dir drifted to `in-flight` (frontmatter still in-progress).
  // It must fold into the In Progress column, not vanish.
  write('in-flight', 'T-700', `id: T-700\ntitle: in-flight wip\nassignee: backend\ntarget: backend\nparent_feature: F-2\nlast_activity_at: ${fresh}`);

  // Backlog lives at .claude-team/backlog/ (sibling of tickets/), with done/ and
  // archived/ subdirs that must be ignored.
  const backlogDir = path.join(teamRoot, 'backlog');
  fs.mkdirSync(path.join(backlogDir, 'done'), { recursive: true });
  fs.writeFileSync(path.join(backlogDir, 'BL-1.md'), '---\nid: BL-1\ntype: backlog\ntitle: idea one\npriority: high\n---\n# body\n');
  fs.writeFileSync(path.join(backlogDir, 'done', 'BL-OLD.md'), '---\nid: BL-OLD\ntitle: shipped idea\n---\n# body\n');

  // Event stream supplies clock-precision timestamps the (date-only) frontmatter
  // lacks. T-500 has only a date-only created in frontmatter; events should
  // drive its timeline. Unknown event types must be tolerated (not rendered).
  const events = [
    { v: 1, seq: 1, ts: '2026-06-18T09:15:00+09:00', event: 'ticket.published', feature: null, ticket: 'T-500', actor: 'king', data: { target: 'frontend' } },
    { v: 1, seq: 2, ts: '2026-06-18T09:20:00+09:00', event: 'stage.started', feature: null, ticket: 'T-500', actor: 'skill:prd', data: { stage: 'prd' } },
    { v: 1, seq: 3, ts: '2026-06-18T09:42:00+09:00', event: 'stage.completed', feature: null, ticket: 'T-500', actor: 'skill:prd', data: { stage: 'prd' } },
    { v: 1, seq: 4, ts: '2026-06-18T09:43:00+09:00', event: 'mystery.future', feature: null, ticket: 'T-500', actor: 'king', data: {} },
  ];
  fs.writeFileSync(
    path.join(teamRoot, 'events.jsonl'),
    events.map((e) => JSON.stringify(e)).join('\n') + '\nnot-json-tolerate-me\n',
  );
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.STALE_HOURS;
});

type BoardResp = {
  cards: Card[];
  features: { feature: string; total: number; done: number }[];
  totals: Record<string, number>;
  staleHours: number;
};

async function load(): Promise<BoardResp> {
  const mod = await import('./route');
  const res = mod.GET();
  return res.json() as Promise<BoardResp>;
}

describe('board route', () => {
  it('parses new frontmatter fields and computes staleness/ready/rollup', async () => {
    const data = await load();
    const byId = new Map(data.cards.map((c) => [c.id, c]));

    // ready/blocked from depends_on resolved against done column
    expect(byId.get('T-200')?.ready).toBe(true); // dep T-900 is done
    expect(byId.get('T-100')?.ready).toBe(false); // dep T-300 not done

    // queue priority sort: high (T-200) before low (T-100)
    const queue = data.cards.filter((c) => c.column === 'queue').map((c) => c.id);
    expect(queue).toEqual(['T-200', 'T-100']);

    // staleness
    expect(byId.get('T-300')?.stale).toBe(true);
    expect(byId.get('T-400')?.stale).toBe(false);
    expect(byId.get('T-500')?.stalenessUnknown).toBe(true);

    // script-owned meta
    expect(byId.get('T-300')?.rescueCount).toBe(2);
    expect(byId.get('T-300')?.reviewRounds).toBe(3);
    expect(byId.get('T-300')?.progressNote).toBe('still wiring the repo');

    // done timestamp from `done` frontmatter (not just mtime)
    expect(byId.get('T-900')?.doneTs).toBe(fresh);

    // feature rollup: F-1 (T-100,T-200,T-300)=0/3, F-2 (T-400,T-900)=1/2, standalone last
    const f1 = data.features.find((f) => f.feature === 'F-1');
    const f2 = data.features.find((f) => f.feature === 'F-2');
    // F-1: T-100,T-200 (queue, pending), T-300 (in-progress, active)
    expect(f1).toEqual({ feature: 'F-1', total: 3, done: 0, active: 1, pending: 2 });
    // F-2: T-900 (done), T-400 (in-progress) + T-700 (in-flight) active
    expect(f2).toEqual({ feature: 'F-2', total: 3, done: 1, active: 2, pending: 0 });
    expect(data.features[data.features.length - 1].feature).toBe('standalone');
  });

  it('builds the timeline from the event stream (real clock) and tolerates unknown/bad lines', async () => {
    const data = await load();
    const t500 = data.cards.find((c) => c.id === 'T-500')!;

    // ticket.published + stage.started + stage.completed → 3 entries, in ts order.
    // The unknown 'mystery.future' event and the trailing non-JSON line are dropped.
    expect(t500.timeline.map((t) => t.label)).toEqual(['생성 (queue)', 'PRD 시작', 'PRD 완료']);
    // Real clock timestamps come from the events, not the date-only frontmatter.
    expect(t500.timeline.map((t) => t.ts)).toEqual([
      '2026-06-18T09:15:00+09:00',
      '2026-06-18T09:20:00+09:00',
      '2026-06-18T09:42:00+09:00',
    ]);
    expect(t500.timeline.map((t) => t.seq)).toEqual([0, 1, 2]); // re-sequenced for stable keys

    // No events for T-900 → frontmatter milestones still drive its timeline.
    const t900 = data.cards.find((c) => c.id === 'T-900')!;
    expect(t900.timeline.map((t) => t.label)).toEqual(['작업 시작', '완료']);
  });

  it('maps in-flight → in-progress and surfaces the sibling backlog dir', async () => {
    const data = await load();
    const byId = new Map(data.cards.map((c) => [c.id, c]));

    // in-flight ticket folds into the In Progress column (not dropped)
    expect(byId.get('T-700')?.column).toBe('in-progress');
    // backlog top-level file shows as a backlog card; backlog/done/* is ignored
    expect(byId.get('BL-1')?.column).toBe('backlog');
    expect(byId.has('BL-OLD')).toBe(false);

    // totals are aggregated by column: in-progress = in-flight + in-progress dirs
    const ip = data.cards.filter((c) => c.column === 'in-progress').map((c) => c.id).sort();
    expect(ip).toEqual(['T-300', 'T-400', 'T-500', 'T-700']);
    expect(data.totals['in-progress']).toBe(4);
    expect(data.totals['backlog']).toBe(1);
  });
});
