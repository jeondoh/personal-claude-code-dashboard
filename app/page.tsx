'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { personaOf, type Card, type Column, type EventRec } from '@/lib/events';
import { Markdown } from '@/lib/markdown';

// Board reads the live ticket folder via /api/board (directory = status), polled
// every 5s with a manual refresh — the folder, not events.jsonl, is the truth.
const BOARD_COLUMNS: Column[] = ['backlog', 'queue', 'in-progress', 'in-review', 'done', 'cancelled'];
const POLL_MS = 5000;

const COLUMN_LABEL: Record<Column, string> = {
  backlog: 'Backlog',
  queue: 'Queue',
  'in-progress': 'In Progress',
  'in-review': 'In Review',
  done: 'Done',
  cancelled: 'Cancelled',
};

type FeatureRollup = {
  feature: string;
  total: number;
  done: number;
  active?: number;
  pending?: number;
};
type BoardData = {
  cards: Card[];
  totals: Record<string, number>;
  root: string;
  features: FeatureRollup[];
  staleHours: number;
};

const ms = (ts?: string) => (ts ? new Date(ts).getTime() : NaN);

function fmtDuration(millis: number): string {
  if (!isFinite(millis) || millis < 0) millis = 0;
  const total = Math.floor(millis / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Timeline stamps — clock only: HH:MM:SS */
const fmtTime = (ts?: string) => {
  if (!ts) return '—';
  if (/^\d{4}-\d{2}-\d{2}$/.test(ts)) return '—'; // date-only — time unknown
  const d = new Date(ts);
  if (isNaN(d.getTime())) return ts;
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

/** Metadata stamps — full date + clock: YYYY-MM-DD HH:MM:SS (date-only stays date-only) */
const fmtDateTime = (ts?: string) => {
  if (!ts) return '—';
  if (/^\d{4}-\d{2}-\d{2}$/.test(ts)) return ts; // date-only frontmatter — no fake clock
  const d = new Date(ts);
  if (isNaN(d.getTime())) return ts;
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
};

/** Elapsed run-time for a card: live for active work, total span once finished. */
function elapsedMs(card: Card, now: number): number {
  const start = ms(card.activeSince) || ms(card.claimedTs) || ms(card.createdTs);
  if (card.column === 'done' || card.column === 'cancelled') {
    return (ms(card.doneTs) || ms(card.updatedTs)) - (ms(card.claimedTs) || ms(card.createdTs));
  }
  return now - start;
}

/** Truncate a one-line note for compact card display. */
const truncate = (s: string, n = 90) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export default function Board() {
  const [board, setBoard] = useState<BoardData>({
    cards: [],
    totals: {},
    root: '',
    features: [],
    staleHours: 2,
  });
  const [now, setNow] = useState(0);
  const [lastUpdated, setLastUpdated] = useState(0);
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('loading');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const inflight = useRef(false);

  const refresh = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    setState((s) => (s === 'idle' ? 'idle' : 'loading'));
    try {
      const res = await fetch('/api/board', { cache: 'no-store' });
      const data = (await res.json()) as BoardData;
      setBoard({
        cards: data.cards ?? [],
        totals: data.totals ?? {},
        root: data.root ?? '',
        features: data.features ?? [],
        staleHours: data.staleHours ?? 2,
      });
      setLastUpdated(Date.now());
      setState('idle');
    } catch {
      setState('error');
    } finally {
      inflight.current = false;
    }
  }, []);

  // poll the ticket folder every 5s (+ initial load)
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  // tick once a second so run-timers and "n초 전" stay live
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const byColumn = useMemo(() => {
    const map = new Map<Column, Card[]>();
    for (const col of BOARD_COLUMNS) map.set(col, []);
    for (const c of board.cards) map.get(c.column)?.push(c);
    return map;
  }, [board.cards]);

  const selected = useMemo(
    () => board.cards.find((c) => c.id === selectedId) ?? null,
    [board.cards, selectedId],
  );

  // close the detail modal on Escape
  useEffect(() => {
    if (!selectedId) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setSelectedId(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId]);

  const agoSec = lastUpdated ? Math.max(0, Math.round((now - lastUpdated) / 1000)) : null;

  return (
    <main className="board">
      <header className="topbar">
        <h1>Claude Team Board</h1>
        <span className={`status ${state === 'error' ? 'off' : 'on'}`}>
          {state === 'error' ? '폴더 읽기 실패' : `자동 새로고침 ${POLL_MS / 1000}s`}
        </span>
        <button
          className="refresh"
          onClick={refresh}
          disabled={state === 'loading'}
          title="지금 새로고침"
        >
          <span className={state === 'loading' ? 'spin' : ''}>↻</span> 새로고침
        </button>
        <span className="count">
          {board.cards.length} tickets
          {agoSec != null && <span className="ago"> · {agoSec}s 전 갱신</span>}
        </span>
      </header>

      <MetricsBar />

      <FeatureRollupBar features={board.features} />

      <EventFeed onOpen={setSelectedId} />

      <div className="columns">
        {BOARD_COLUMNS.map((col) => {
          const items = byColumn.get(col) ?? [];
          const total = board.totals[col] ?? items.length;
          const capped = total > items.length;
          return (
            <section key={col} className="column">
              <h2>
                {COLUMN_LABEL[col]}{' '}
                <span className="badge" title={capped ? `총 ${total}건 중 최근 ${items.length}건` : undefined}>
                  {capped ? `${items.length}/${total}` : items.length}
                </span>
              </h2>
              <div className="cards">
                {items.map((c) => (
                  <TicketCard key={c.id} card={c} now={now} onOpen={() => setSelectedId(c.id)} />
                ))}
                {items.length === 0 && <p className="empty">—</p>}
              </div>
            </section>
          );
        })}
      </div>

      {selected && (
        <TicketDetail card={selected} now={now} onClose={() => setSelectedId(null)} />
      )}
    </main>
  );
}

function TicketCard({
  card,
  now,
  onOpen,
}: {
  card: Card;
  now: number;
  onOpen: () => void;
}) {
  const last = card.stages[card.stages.length - 1];
  const running = card.column === 'in-progress' || card.column === 'in-review';
  const finished = card.column === 'done' || card.column === 'cancelled';
  const inProgress = card.column === 'in-progress';
  const queued = card.column === 'queue';

  return (
    <article
      className={`card${card.stale ? ' card-stale' : ''}`}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onOpen())}
    >
      <div className="card-head">
        <span className="id">{card.id}</span>
        <span className={`squad squad-${card.squad}`}>{card.squad}</span>
      </div>
      <p className="title">{card.title}</p>

      {queued && (
        <div className="card-badges">
          {card.priority && card.priority !== 'medium' && (
            <span className={`badge-pri pri-${card.priority}`}>{card.priority}</span>
          )}
          <span className={`badge-dep ${card.ready ? 'dep-ready' : 'dep-blocked'}`}>
            {card.ready ? 'READY' : 'BLOCKED'}
          </span>
        </div>
      )}

      {inProgress && card.progressNote && (
        <p className="progress-note" title={card.progressNote}>
          {truncate(card.progressNote)}
        </p>
      )}

      {inProgress && card.stale && (
        <div className="stale-warn" title={`마지막 활동 ${fmtDateTime(card.lastActivityTs)}`}>
          ⚠ 정체됨 (마지막 활동 {fmtDateTime(card.lastActivityTs)})
        </div>
      )}
      {inProgress && card.stalenessUnknown && !card.stale && (
        <div className="stale-unknown" title="last_activity_at 없음">
          · 활동 시각 미상
        </div>
      )}

      {card.activeSkill && (
        <div className={`runline squad-${card.squad}`}>
          <span className="run-dot" />
          <span className="run-agent">{card.activeAgentName ?? personaOf(card.activeSkill)}</span>
          {card.activeStage && <span className="run-stage">· {card.activeStage}</span>}
          {running && (
            <span className="run-time" title="실행 시간">
              ⏱ {fmtDuration(elapsedMs(card, now))}
            </span>
          )}
        </div>
      )}

      <div className="meta">
        {card.complexity && <span className="chip">{card.complexity}</span>}
        {card.rescueCount != null && card.rescueCount > 0 && (
          <span className="chip chip-rescue" title="rescue 횟수">
            🛟 rescue ×{card.rescueCount}
          </span>
        )}
        {card.reviewRounds != null && card.reviewRounds > 0 && (
          <span className="chip chip-review" title="리뷰 라운드">
            🔁 review ×{card.reviewRounds}
          </span>
        )}
        {last && !card.activeSkill && (
          <span className={`chip stage-${last.status}`}>
            {last.skill}:{last.stage} · {last.status}
          </span>
        )}
        {card.verdict && <span className={`chip verdict-${card.verdict}`}>{card.verdict}</span>}
        {finished && (
          <span className="chip muted" title="총 소요 시간">
            ⏱ {fmtDuration(elapsedMs(card, now))}
          </span>
        )}
      </div>
    </article>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="d-row">
      <span className="d-label">{label}</span>
      <span className="d-value">{children}</span>
    </div>
  );
}

/**
 * Workflow lens: one stacked bar per parent_feature, split pending → active →
 * done. A "feature" is the unit the orchestrator runs a workflow over, so this is
 * the closest read on live workflow progress the ticket tree affords.
 */
function FeatureRollupBar({ features }: { features: FeatureRollup[] }) {
  if (!features.length) return null;
  return (
    <section className="rollup">
      <h2 className="rollup-h">Workflows / Features</h2>
      <div className="rollup-grid">
        {features.map((f) => {
          const done = f.done;
          const active = f.active ?? 0;
          const pending = f.pending ?? Math.max(0, f.total - done - active);
          const pctOf = (n: number) => (f.total ? (n / f.total) * 100 : 0);
          const standalone = f.feature === 'standalone';
          return (
            <div key={f.feature} className={`rollup-item${standalone ? ' standalone' : ''}`}>
              <div className="rollup-top">
                <span className="rollup-name" title={f.feature}>
                  {standalone ? '독립 티켓' : f.feature}
                </span>
                <span className="rollup-count">
                  {active > 0 && <span className="rollup-active-dot" title={`진행 중 ${active}`} />}
                  {done}/{f.total}
                </span>
              </div>
              <div className="rollup-bar" title={`대기 ${pending} · 진행 ${active} · 완료 ${done}`}>
                <span className="seg seg-done" style={{ width: `${pctOf(done)}%` }} />
                <span className="seg seg-active" style={{ width: `${pctOf(active)}%` }} />
                <span className="seg seg-pending" style={{ width: `${pctOf(pending)}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

type Metrics = {
  generatedAt: string;
  kpis: {
    wip: number;
    inReview: number;
    queue: number;
    backlog: number;
    cancelled: number;
    doneToday: number;
    done7d: number;
    merged7d: number;
    mergedTotal: number;
    totalDone: number;
    medianCycleHours: number;
    p90CycleHours: number;
    cycleSample: number;
    openRescues: number;
    openReviews: number;
  };
  throughput: { day: string; count: number }[];
  bySquad: { squad: string; count: number }[];
};

const METRICS_POLL_MS = 15000;

const fmtHours = (h: number) => (h >= 24 ? `${(h / 24).toFixed(1)}d` : `${h}h`);

/** Grafana-style monitoring strip: KPI stat cards + throughput chart + squad mix. */
function MetricsBar() {
  const [m, setM] = useState<Metrics | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let alive = true;
    const pull = () =>
      fetch('/api/metrics', { cache: 'no-store' })
        .then((r) => r.json())
        .then((d) => alive && (setM(d as Metrics), setErr(false)))
        .catch(() => alive && setErr(true));
    pull();
    const t = setInterval(pull, METRICS_POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (err && !m) return null;
  if (!m) return <section className="metrics"><p className="empty">메트릭 로딩 중…</p></section>;

  const k = m.kpis;
  const peak = Math.max(1, ...m.throughput.map((t) => t.count));
  const squadTotal = Math.max(1, m.bySquad.reduce((s, x) => s + x.count, 0));

  const stats: { label: string; value: React.ReactNode; tone?: string; hint?: string }[] = [
    { label: 'WIP', value: k.wip, tone: k.wip > 0 ? 'active' : undefined, hint: 'in-flight + hold' },
    { label: 'In Review', value: k.inReview, tone: k.inReview > 0 ? 'warn' : undefined },
    { label: 'Queue', value: k.queue },
    { label: 'Backlog', value: k.backlog },
    { label: '오늘 완료', value: k.doneToday, tone: 'good' },
    { label: '7일 완료', value: k.done7d, tone: 'good' },
    { label: '7일 머지', value: k.merged7d, tone: 'good', hint: `누적 ${k.mergedTotal}` },
    { label: '총 완료', value: k.totalDone },
    {
      label: '사이클(중앙값)',
      value: fmtHours(k.medianCycleHours),
      hint: `p90 ${fmtHours(k.p90CycleHours)} · n=${k.cycleSample}`,
    },
    ...(k.openRescues > 0 ? [{ label: 'Rescue', value: k.openRescues, tone: 'bad' }] : []),
    ...(k.openReviews > 0 ? [{ label: 'Review rounds', value: k.openReviews, tone: 'warn' }] : []),
  ];

  return (
    <section className="metrics">
      <div className="metrics-stats">
        {stats.map((s) => (
          <div key={s.label} className={`stat${s.tone ? ` stat-${s.tone}` : ''}`}>
            <span className="stat-value">{s.value}</span>
            <span className="stat-label">{s.label}</span>
            {s.hint && <span className="stat-hint">{s.hint}</span>}
          </div>
        ))}
      </div>

      <div className="metrics-charts">
        <div className="chart">
          <div className="chart-h">처리량 (일별 완료 · 14일)</div>
          <div className="bars">
            {m.throughput.map((t) => (
              <div className="bar-col" key={t.day} title={`${t.day}: ${t.count}건`}>
                <div className="bar-track">
                  <div
                    className="bar-fill"
                    style={{ height: `${Math.round((t.count / peak) * 100)}%` }}
                  />
                </div>
                <span className="bar-x">{t.day.slice(8)}</span>
              </div>
            ))}
          </div>
        </div>

        {m.bySquad.length > 0 && (
          <div className="chart chart-squad">
            <div className="chart-h">스쿼드 믹스 (최근 완료)</div>
            <div className="squad-bars">
              {m.bySquad.map((s) => (
                <div className="squad-row" key={s.squad}>
                  <span className={`squad-tag squad-${s.squad}`}>{s.squad}</span>
                  <div className="squad-track">
                    <div
                      className={`squad-fill squad-bg-${s.squad}`}
                      style={{ width: `${Math.round((s.count / squadTotal) * 100)}%` }}
                    />
                  </div>
                  <span className="squad-n">{s.count}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

const FEED_CAP = 60; // keep only the most recent N events client-side

/** Live event feed — consumes /api/events (SSE), newest first. */
function EventFeed({ onOpen }: { onOpen: (id: string) => void }) {
  const [events, setEvents] = useState<EventRec[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const es = new EventSource('/api/events');
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (e) => {
      let rec: EventRec | null = null;
      try {
        rec = JSON.parse(e.data) as EventRec;
      } catch {
        return; // ignore non-JSON (meta/ping)
      }
      if (!rec || !rec.event) return;
      setEvents((prev) => [rec as EventRec, ...prev].slice(0, FEED_CAP));
    };
    return () => es.close();
  }, []);

  return (
    <section className="feed">
      <h2 className="feed-h">
        Event Feed
        <span className={`feed-dot ${connected ? 'on' : 'off'}`} />
      </h2>
      <div className="feed-list">
        {events.length === 0 ? (
          <p className="empty">이벤트 대기 중…</p>
        ) : (
          events.map((ev, i) => (
            <div
              key={`${ev.seq}-${ev.ts}-${i}`}
              className={`feed-row${ev.ticket ? ' clickable' : ''}`}
              onClick={ev.ticket ? () => onOpen(ev.ticket as string) : undefined}
            >
              <span className="feed-time">{fmtTime(ev.ts)}</span>
              <span className="feed-event">{ev.event}</span>
              {ev.ticket && <span className="feed-ticket">{ev.ticket}</span>}
              {ev.actor && <span className="feed-actor">{ev.actor}</span>}
            </div>
          ))
        )}
      </div>
    </section>
  );
}

type TicketDoc = {
  loading: boolean;
  found?: boolean;
  body?: string;
  file?: string;
};

function TicketDetail({
  card,
  now,
  onClose,
}: {
  card: Card;
  now: number;
  onClose: () => void;
}) {
  const [doc, setDoc] = useState<TicketDoc>({ loading: true });

  // pull the actual ticket markdown file (read-only) for the full body
  useEffect(() => {
    let alive = true;
    setDoc({ loading: true });
    fetch(`/api/ticket?id=${encodeURIComponent(card.id)}`)
      .then((r) => r.json())
      .then((d) => alive && setDoc({ loading: false, found: !!d.found, body: d.body, file: d.file }))
      .catch(() => alive && setDoc({ loading: false, found: false }));
    return () => {
      alive = false;
    };
  }, [card.id]);

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div>
            <span className="id">{card.id}</span>
            <span className={`squad squad-${card.squad}`}>{card.squad}</span>
            <span className={`pill col-${card.column}`}>{COLUMN_LABEL[card.column]}</span>
          </div>
          <button className="close" onClick={onClose} aria-label="닫기">
            ✕
          </button>
        </header>

        <h2 className="modal-title">{card.title}</h2>

        <div className="modal-cols">
          <aside className="modal-side">
            <section className="d-block">
              <h3>Files in scope</h3>
              {card.filesInScope?.length ? (
                <ul className="file-list">
                  {card.filesInScope.map((f) => (
                    <li key={f}><code>{f}</code></li>
                  ))}
                </ul>
              ) : (
                <p className="empty">—</p>
              )}
            </section>

            <section className="d-block">
              <h3>Timeline</h3>
              {card.timeline.length === 0 ? (
                <p className="empty">—</p>
              ) : (
                <ol className="timeline">
                  {card.timeline.map((t) => (
                    <li key={t.seq} className={`tl tone-${t.tone}`}>
                      <span className="tl-dot" />
                      <span className="tl-time">{fmtTime(t.ts)}</span>
                      <span className="tl-body">
                        <span className="tl-label">{t.label}</span>
                        {t.detail && <span className="tl-detail">{t.detail}</span>}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </aside>

          <div className="modal-main">
            {card.activeSkill && (card.column === 'in-progress' || card.column === 'in-review') && (
              <div className={`runline big squad-${card.squad}`}>
                <span className="run-dot" />
                <span className="run-agent">{card.activeAgentName ?? personaOf(card.activeSkill)}</span>
                {card.activeStage && <span className="run-stage">· {card.activeStage}</span>}
                <span className="run-time">⏱ {fmtDuration(elapsedMs(card, now))} 실행 중</span>
              </div>
            )}

            <div className="d-grid">
              {card.feature && <Row label="Feature">{card.feature}</Row>}
              {card.priority && <Row label="Priority">{card.priority}</Row>}
              {card.progressNote && <Row label="Progress">{card.progressNote}</Row>}
              {card.complexity && <Row label="Complexity">{card.complexity}</Row>}
              {card.rescueCount != null && card.rescueCount > 0 && (
                <Row label="Rescue">🛟 ×{card.rescueCount}</Row>
              )}
              {card.reviewRounds != null && card.reviewRounds > 0 && (
                <Row label="Review rounds">{card.reviewRounds}</Row>
              )}
              {card.assignee && (
                <Row label="Assignee">
                  {personaOf(card.assignee)} <span className="dim">({card.assignee})</span>
                </Row>
              )}
              {card.pr != null && <Row label="PR">#{card.pr}</Row>}
              {card.reviewRound != null && <Row label="Review round">{card.reviewRound}</Row>}
              {card.verdict && (
                <Row label="Verdict">
                  <span className={`chip verdict-${card.verdict}`}>{card.verdict}</span>
                </Row>
              )}
              {card.branch && <Row label="Branch"><code>{card.branch}</code></Row>}
              {card.worktree && <Row label="Worktree"><code>{card.worktree}</code></Row>}
              {card.mergeCommit && <Row label="Merge"><code>{card.mergeCommit}</code></Row>}
              {card.cancelReason && <Row label="Cancelled">{card.cancelReason}</Row>}
              <Row label="Created">{fmtDateTime(card.createdTs)}</Row>
              {card.claimedTs && <Row label="Claimed">{fmtDateTime(card.claimedTs)}</Row>}
              {card.doneTs && <Row label="Done">{fmtDateTime(card.doneTs)}</Row>}
              <Row label={card.doneTs ? '총 소요' : '경과'}>{fmtDuration(elapsedMs(card, now))}</Row>
            </div>

            {card.findings && (
              <div className="findings">
                <span className="f-blocking">blocking {card.findings.blocking}</span>
                <span className="f-should">should {card.findings.should}</span>
                <span className="f-nit">nit {card.findings.nit}</span>
                <span className="f-oos">oos {card.findings.oos}</span>
              </div>
            )}

            {card.dependsOn?.length ? (
              <section className="d-block">
                <h3>Depends on</h3>
                <div className="dep-chips">
                  {card.dependsOn.map((d) => (
                    <span key={d} className="chip">{d}</span>
                  ))}
                </div>
              </section>
            ) : null}

            <section className="d-block">
              <h3>티켓 본문{doc.file && <span className="doc-file">{doc.file}</span>}</h3>
              {doc.loading ? (
                <p className="empty">불러오는 중…</p>
              ) : doc.found && doc.body ? (
                <div className="ticket-doc">
                  <Markdown source={doc.body} />
                </div>
              ) : (
                <p className="empty doc-missing">
                  {card.id} 본문 파일이 없습니다.
                  <br />
                  <span>
                    이미 done/archive 로 정리됐거나, 하위 티켓으로 분해된 feature 티켓일 수 있습니다.
                  </span>
                </p>
              )}
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
