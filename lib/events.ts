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
};

export type Card = {
  id: string;
  title: string;
  column: Column;
  squad: string;
  complexity?: string;
  stages: Stage[];
  verdict?: string;
  updatedTs: string;
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

function squadOf(assignee?: unknown): string {
  if (typeof assignee !== 'string' || !assignee) return '—';
  const s = assignee.replace(/^skill:/, '');
  return SQUAD[s] ?? s;
}

/** Reduce the append-only event stream into the current set of ticket cards. */
export function reduce(events: EventRec[]): Card[] {
  const cards = new Map<string, Card>();
  const get = (id: string | null): Card | undefined => (id ? cards.get(id) : undefined);

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
            complexity: d.complexity as string | undefined,
            stages: [],
            updatedTs: e.ts,
          });
        }
        break;
      case 'ticket.claimed':
        { const c = get(id); if (c) { c.column = 'in-progress'; c.updatedTs = e.ts; } }
        break;
      case 'ticket.review':
        { const c = get(id); if (c) { c.column = 'in-review'; c.updatedTs = e.ts; } }
        break;
      case 'ticket.done':
        { const c = get(id); if (c) { c.column = 'done'; c.updatedTs = e.ts; } }
        break;
      case 'ticket.cancelled':
        { const c = get(id); if (c) { c.column = 'cancelled'; c.updatedTs = e.ts; } }
        break;
      case 'stage.started':
      case 'stage.completed':
      case 'stage.failed': {
        const c = get(id);
        if (c) {
          c.stages.push({
            skill: (d.skill as string) ?? c.squad,
            stage: (d.stage as string) ?? '',
            status: e.event.split('.')[1] as Stage['status'],
            ts: e.ts,
          });
          c.updatedTs = e.ts;
        }
        break;
      }
      case 'review.round': {
        const c = get(id);
        if (c) { c.verdict = d.verdict as string | undefined; c.updatedTs = e.ts; }
        break;
      }
      default:
        break; // feature/phase/stop/escalation events are not card-level (MVP ignores)
    }
  }

  return [...cards.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}
