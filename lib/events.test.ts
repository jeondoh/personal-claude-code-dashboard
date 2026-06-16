import { describe, expect, it } from 'vitest';
import { agentInfo, personaOf, reduce, squadOfSkill, type EventRec } from './events';

let seq = 0;
const ev = (event: string, ticket: string | null, data: Record<string, unknown> = {}, ts = '2026-06-16T10:00:00+09:00'): EventRec => ({
  v: 1,
  seq: ++seq,
  ts,
  event,
  feature: 'T-0006',
  ticket,
  actor: 'king',
  data,
});

describe('reduce', () => {
  it('places a published ticket in queue with its metadata', () => {
    const [c] = reduce([
      ev('ticket.published', 'T-1', {
        title: '취소 API',
        complexity: 'medium',
        assignee: 'skill:backend',
        files_in_scope: ['a.kt', 'b.kt'],
        depends_on: ['T-0'],
      }),
    ]);
    expect(c.column).toBe('queue');
    expect(c.title).toBe('취소 API');
    expect(c.squad).toBe('BE');
    expect(c.assignee).toBe('backend');
    expect(c.filesInScope).toEqual(['a.kt', 'b.kt']);
    expect(c.dependsOn).toEqual(['T-0']);
    expect(c.activeSkill).toBeUndefined();
  });

  it('identifies the currently-running agent as the open (unclosed) stage', () => {
    const [c] = reduce([
      ev('ticket.published', 'T-1', { title: 't', assignee: 'skill:backend' }),
      ev('ticket.claimed', 'T-1', { branch: 'feat/T-1' }),
      ev('stage.started', 'T-1', { skill: 'qa', stage: 'qa-pre' }),
      ev('stage.completed', 'T-1', { skill: 'qa', stage: 'qa-pre' }),
      ev('stage.started', 'T-1', { skill: 'backend', stage: 'impl' }, '2026-06-16T10:05:00+09:00'),
    ]);
    expect(c.column).toBe('in-progress');
    expect(c.activeSkill).toBe('backend'); // qa-pre closed, impl still open
    expect(c.activeStage).toBe('impl');
    expect(c.activeSince).toBe('2026-06-16T10:05:00+09:00');
    expect(c.branch).toBe('feat/T-1');
  });

  it('falls back to the assignee when claimed but no stage has started yet', () => {
    const [c] = reduce([
      ev('ticket.published', 'T-1', { title: 't', assignee: 'skill:frontend' }),
      ev('ticket.claimed', 'T-1', {}),
    ]);
    expect(c.activeSkill).toBe('frontend');
    expect(c.activeSince).toBe(c.claimedTs);
  });

  it('clears the active agent once the ticket is done and captures merge/verdict', () => {
    const [c] = reduce([
      ev('ticket.published', 'T-1', { title: 't', assignee: 'skill:backend' }),
      ev('ticket.claimed', 'T-1', {}),
      ev('stage.started', 'T-1', { skill: 'backend', stage: 'impl' }),
      ev('stage.completed', 'T-1', { skill: 'backend', stage: 'impl' }),
      ev('ticket.review', 'T-1', { pr: 42, round: 1 }),
      ev('review.round', 'T-1', { round: 1, verdict: 'APPROVE', findings: { blocking: 0, should: 1, nit: 2, oos: 0 } }),
      ev('ticket.done', 'T-1', { merge_commit: 'a1b2c3d' }),
    ]);
    expect(c.column).toBe('done');
    expect(c.activeSkill).toBeUndefined();
    expect(c.pr).toBe(42);
    expect(c.verdict).toBe('APPROVE');
    expect(c.findings).toEqual({ blocking: 0, should: 1, nit: 2, oos: 0 });
    expect(c.mergeCommit).toBe('a1b2c3d');
    expect(c.doneTs).toBeDefined();
  });

  it('builds a per-ticket timeline in seq order', () => {
    const [c] = reduce([
      ev('ticket.published', 'T-1', { title: 't', assignee: 'skill:backend' }),
      ev('ticket.claimed', 'T-1', {}),
      ev('stage.started', 'T-1', { skill: 'backend', stage: 'impl' }),
    ]);
    expect(c.timeline.map((t) => t.event)).toEqual(['ticket.published', 'ticket.claimed', 'stage.started']);
    expect(c.timeline[2].tone).toBe('active');
  });

  it('tolerates unknown event types without throwing', () => {
    const cards = reduce([
      ev('ticket.published', 'T-1', { title: 't' }),
      ev('some.future.event', 'T-1', { whatever: true }),
      ev('phase.entered', null, { phase: 'build' }),
    ]);
    expect(cards).toHaveLength(1);
    expect(cards[0].column).toBe('queue');
  });
});

describe('helpers', () => {
  it('maps skills to squads and personas', () => {
    expect(squadOfSkill('backend')).toBe('BE');
    expect(squadOfSkill('qa')).toBe('QA');
    expect(personaOf('frontend')).toBe('Pixel Wizard');
    expect(personaOf('unknown')).toBe('unknown');
  });

  it('agentInfo resolves v2 skill ids, v1 persona slugs, and target fallback', () => {
    expect(agentInfo('backend')).toEqual({ name: 'Persistence Paladin', squad: 'BE', skill: 'backend' });
    expect(agentInfo('skill:frontend')).toEqual({ name: 'Pixel Wizard', squad: 'FE', skill: 'frontend' });
    expect(agentInfo('persistence-paladin')).toEqual({ name: 'Persistence Paladin', squad: 'BE', skill: 'backend' });
    // unknown assignee → name kept, squad derived from target
    expect(agentInfo('mystery', 'fe')).toEqual({ name: 'mystery', squad: 'FE', skill: undefined });
    expect(agentInfo(undefined, 'both')).toEqual({ name: '—', squad: 'design', skill: undefined });
  });
});
