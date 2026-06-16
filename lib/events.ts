// Mirror of the plugin's docs/events-contract.md (v1). Keep in sync with that contract.

export type EventRec = {
  v: number;
  seq: number;
  ts: string;
  event: string;
  feature: string | null;
  ticket: string | null;
  actor: string;
  data: Record<string, unknown>;
};

export type Column = 'queue' | 'in-progress' | 'in-review' | 'done' | 'cancelled';
export const COLUMNS: Column[] = ['queue', 'in-progress', 'in-review', 'done'];

export type Stage = {
  skill: string;
  stage: string;
  status: 'started' | 'completed' | 'failed';
  ts: string;
  summary?: string;
  errorSignature?: string;
};

export type Findings = { blocking: number; should: number; nit: number; oos: number };

/** One line in a ticket's detail timeline (built straight from the event stream). */
export type TimelineItem = {
  seq: number;
  ts: string;
  event: string;
  actor: string;
  label: string;
  detail?: string;
  tone: 'info' | 'good' | 'warn' | 'bad' | 'active';
};

export type Card = {
  id: string;
  title: string;
  column: Column;
  squad: string;
  complexity?: string;
  /** raw skill id of the ticket's assignee, e.g. `backend` */
  assignee?: string;
  feature?: string | null;
  stages: Stage[];
  verdict?: string;

  // metadata harvested from the event payloads
  filesInScope?: string[];
  dependsOn?: string[];
  worktree?: string;
  branch?: string;
  pr?: number;
  reviewRound?: number;
  findings?: Findings;
  mergeCommit?: string;
  cancelReason?: string;

  // timing
  createdTs: string;
  claimedTs?: string;
  doneTs?: string;
  updatedTs: string;

  // currently-running agent (open stage = started with no later completed/failed)
  activeSkill?: string;
  activeStage?: string;
  activeSince?: string;
  /** display name for the running agent when not derivable from a skill id */
  activeAgentName?: string;

  // full per-ticket event timeline, in seq order
  timeline: TimelineItem[];
};

const SQUAD: Record<string, string> = {
  prd: 'design',
  design: 'design',
  backend: 'BE',
  frontend: 'FE',
  qa: 'QA',
  review: 'review',
  rescue: 'rescue',
};

/** Friendly persona name per skill — what the user thinks of as "the agent". */
const PERSONA: Record<string, string> = {
  prd: 'Spec Shaman',
  design: 'Galaxy Brain',
  backend: 'Persistence Paladin',
  frontend: 'Pixel Wizard',
  qa: 'What-If Witch',
  review: 'Roastmaster',
  rescue: 'Rescue Squad',
  king: 'Technoking',
};

const stripSkill = (s: string) => s.replace(/^skill:/, '');

export function squadOfSkill(skill?: string): string {
  if (!skill) return '—';
  return SQUAD[skill] ?? skill;
}

export function personaOf(skill?: string): string {
  if (!skill) return '—';
  return PERSONA[skill] ?? skill;
}

function squadOf(assignee?: unknown): string {
  if (typeof assignee !== 'string' || !assignee) return '—';
  return squadOfSkill(stripSkill(assignee));
}

/** Persona slugs as they appear in ticket frontmatter `assignee` (v1 tickets). */
const PERSONA_SLUG: Record<string, { name: string; squad: string; skill: string }> = {
  'persistence-paladin': { name: 'Persistence Paladin', squad: 'BE', skill: 'backend' },
  'pixel-wizard': { name: 'Pixel Wizard', squad: 'FE', skill: 'frontend' },
  'spec-shaman': { name: 'Spec Shaman', squad: 'design', skill: 'prd' },
  'galaxy-brain': { name: 'Galaxy Brain', squad: 'design', skill: 'design' },
  'what-if-witch': { name: 'What-If Witch', squad: 'QA', skill: 'qa' },
  roastmaster: { name: 'Roastmaster', squad: 'review', skill: 'review' },
  'the-roastmaster': { name: 'Roastmaster', squad: 'review', skill: 'review' },
  'rescue-squad': { name: 'Rescue Squad', squad: 'rescue', skill: 'rescue' },
};

function squadFromTarget(target?: string): string | undefined {
  const t = (target ?? '').toLowerCase();
  if (t === 'be' || t === 'backend') return 'BE';
  if (t === 'fe' || t === 'frontend') return 'FE';
  if (t === 'design' || t === 'both') return 'design';
  return undefined;
}

/**
 * Resolve a ticket's `assignee` (+ optional `target`) into a display name, squad
 * tag, and (when known) the canonical skill id. Handles both the v2 form
 * (`assignee: backend`) and the v1 persona-slug form (`assignee: pixel-wizard`).
 */
export function agentInfo(
  assignee?: string,
  target?: string,
): { name: string; squad: string; skill?: string } {
  const a = (assignee ?? '').replace(/^skill:/, '').trim();
  if (a && a in SQUAD) return { name: personaOf(a), squad: SQUAD[a], skill: a };
  if (a && PERSONA_SLUG[a]) return { ...PERSONA_SLUG[a] };
  return { name: a || '—', squad: squadFromTarget(target) ?? '—', skill: undefined };
}

function asStringArr(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;
}

/** Reduce the append-only event stream into the current set of ticket cards. */
export function reduce(events: EventRec[]): Card[] {
  const cards = new Map<string, Card>();
  // per-card map of open stages: key = `skill|stage` → start info
  const open = new Map<string, Map<string, { skill: string; stage: string; ts: string }>>();
  const get = (id: string | null): Card | undefined => (id ? cards.get(id) : undefined);
  const push = (c: Card, item: TimelineItem) => c.timeline.push(item);

  for (const e of events) {
    const id = e.ticket;
    const d = e.data ?? {};
    switch (e.event) {
      case 'ticket.published':
        if (id) {
          cards.set(id, {
            id,
            title: (d.title as string) || id,
            column: 'queue',
            squad: squadOf(d.assignee),
            assignee: typeof d.assignee === 'string' ? stripSkill(d.assignee) : undefined,
            feature: e.feature,
            complexity: d.complexity as string | undefined,
            filesInScope: asStringArr(d.files_in_scope),
            dependsOn: asStringArr(d.depends_on),
            stages: [],
            createdTs: e.ts,
            updatedTs: e.ts,
            timeline: [],
          });
          push(cards.get(id)!, {
            seq: e.seq, ts: e.ts, event: e.event, actor: e.actor,
            label: 'Queued', detail: (d.title as string) || undefined, tone: 'info',
          });
          open.set(id, new Map());
        }
        break;
      case 'ticket.claimed':
        { const c = get(id); if (c) {
          c.column = 'in-progress'; c.updatedTs = e.ts; c.claimedTs = e.ts;
          if (typeof d.worktree === 'string') c.worktree = d.worktree;
          if (typeof d.branch === 'string') c.branch = d.branch;
          push(c, { seq: e.seq, ts: e.ts, event: e.event, actor: e.actor,
            label: 'Claimed → in progress', detail: d.branch as string | undefined, tone: 'active' });
        } }
        break;
      case 'ticket.review':
        { const c = get(id); if (c) {
          c.column = 'in-review'; c.updatedTs = e.ts;
          if (typeof d.pr === 'number') c.pr = d.pr;
          if (typeof d.round === 'number') c.reviewRound = d.round;
          push(c, { seq: e.seq, ts: e.ts, event: e.event, actor: e.actor,
            label: 'Sent to review', detail: d.pr ? `PR #${d.pr}` : undefined, tone: 'info' });
        } }
        break;
      case 'ticket.done':
        { const c = get(id); if (c) {
          c.column = 'done'; c.updatedTs = e.ts; c.doneTs = e.ts;
          if (typeof d.merge_commit === 'string') c.mergeCommit = d.merge_commit;
          push(c, { seq: e.seq, ts: e.ts, event: e.event, actor: e.actor,
            label: 'Done (merged)', detail: d.merge_commit as string | undefined, tone: 'good' });
        } }
        break;
      case 'ticket.cancelled':
        { const c = get(id); if (c) {
          c.column = 'cancelled'; c.updatedTs = e.ts;
          if (typeof d.reason === 'string') c.cancelReason = d.reason;
          push(c, { seq: e.seq, ts: e.ts, event: e.event, actor: e.actor,
            label: 'Cancelled', detail: d.reason as string | undefined, tone: 'bad' });
        } }
        break;
      case 'stage.started':
      case 'stage.completed':
      case 'stage.failed': {
        const c = get(id);
        if (c) {
          const status = e.event.split('.')[1] as Stage['status'];
          const skill = (d.skill as string) ?? c.assignee ?? c.squad;
          const stage = (d.stage as string) ?? '';
          c.stages.push({
            skill, stage, status, ts: e.ts,
            summary: d.summary as string | undefined,
            errorSignature: d.error_signature as string | undefined,
          });
          c.updatedTs = e.ts;

          const o = open.get(c.id) ?? new Map();
          open.set(c.id, o);
          const key = `${skill}|${stage}`;
          if (status === 'started') o.set(key, { skill, stage, ts: e.ts });
          else o.delete(key);

          push(c, {
            seq: e.seq, ts: e.ts, event: e.event, actor: e.actor,
            label: `${personaOf(skill)} · ${stage} ${status}`,
            detail: (d.summary as string) || (d.error_signature as string) || undefined,
            tone: status === 'completed' ? 'good' : status === 'failed' ? 'bad' : 'active',
          });
        }
        break;
      }
      case 'review.round': {
        const c = get(id);
        if (c) {
          c.verdict = d.verdict as string | undefined;
          if (typeof d.round === 'number') c.reviewRound = d.round;
          const f = d.findings as Partial<Findings> | undefined;
          if (f && typeof f === 'object') {
            c.findings = {
              blocking: Number(f.blocking ?? 0),
              should: Number(f.should ?? 0),
              nit: Number(f.nit ?? 0),
              oos: Number(f.oos ?? 0),
            };
          }
          c.updatedTs = e.ts;
          push(c, {
            seq: e.seq, ts: e.ts, event: e.event, actor: e.actor,
            label: `Review round ${d.round ?? '?'} — ${d.verdict ?? ''}`.trim(),
            detail: c.findings
              ? `blocking ${c.findings.blocking} · should ${c.findings.should} · nit ${c.findings.nit}`
              : undefined,
            tone: d.verdict === 'APPROVE' ? 'good' : d.verdict === 'BLOCKING' ? 'bad' : 'warn',
          });
        }
        break;
      }
      case 'rescue.triggered':
      case 'rescue.resolved':
      case 'rescue.failed': {
        const c = get(id);
        if (c) {
          const kind = e.event.split('.')[1];
          c.updatedTs = e.ts;
          push(c, {
            seq: e.seq, ts: e.ts, event: e.event, actor: e.actor,
            label: `Rescue ${kind}`,
            detail: (d.trigger as string) || (d.reason as string) || (d.error_signature as string) || undefined,
            tone: e.event === 'rescue.resolved' ? 'good' : e.event === 'rescue.failed' ? 'bad' : 'warn',
          });
        }
        break;
      }
      default:
        break; // feature/phase/stop/escalation events are not card-level (MVP ignores)
    }
  }

  // resolve the currently-running agent for each card from its open stages (latest wins)
  for (const [id, o] of open) {
    const c = cards.get(id);
    if (!c) continue;
    let latest: { skill: string; stage: string; ts: string } | undefined;
    for (const s of o.values()) {
      if (!latest || s.ts > latest.ts) latest = s;
    }
    if (latest) {
      c.activeSkill = latest.skill;
      c.activeStage = latest.stage;
      c.activeSince = latest.ts;
    } else if (c.column === 'in-progress') {
      // claimed but no open stage yet — attribute to the assignee since it was claimed
      c.activeSkill = c.assignee;
      c.activeSince = c.claimedTs;
    }
  }

  return [...cards.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}
