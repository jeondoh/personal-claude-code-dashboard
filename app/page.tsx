'use client';

import { useEffect, useMemo, useState } from 'react';
import { COLUMNS, reduce, type Card, type Column, type EventRec } from '@/lib/events';

const COLUMN_LABEL: Record<Column, string> = {
  queue: 'Queue',
  'in-progress': 'In Progress',
  'in-review': 'In Review',
  done: 'Done',
  cancelled: 'Cancelled',
};

export default function Board() {
  const [events, setEvents] = useState<EventRec[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const es = new EventSource('/api/events');
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (m) => {
      try {
        const rec = JSON.parse(m.data) as EventRec;
        setEvents((prev) => [...prev, rec]);
      } catch {
        /* ignore non-JSON keepalives */
      }
    };
    return () => es.close();
  }, []);

  const cards = useMemo(() => reduce(events), [events]);
  const byColumn = useMemo(() => {
    const map = new Map<Column, Card[]>();
    for (const col of COLUMNS) map.set(col, []);
    for (const c of cards) map.get(c.column)?.push(c);
    return map;
  }, [cards]);

  return (
    <main className="board">
      <header className="topbar">
        <h1>Claude Team Board</h1>
        <span className={`status ${connected ? 'on' : 'off'}`}>
          {connected ? 'live' : 'reconnecting…'}
        </span>
        <span className="count">{cards.length} tickets · {events.length} events</span>
      </header>

      <div className="columns">
        {COLUMNS.map((col) => {
          const items = byColumn.get(col) ?? [];
          return (
            <section key={col} className="column">
              <h2>
                {COLUMN_LABEL[col]} <span className="badge">{items.length}</span>
              </h2>
              <div className="cards">
                {items.map((c) => (
                  <TicketCard key={c.id} card={c} />
                ))}
                {items.length === 0 && <p className="empty">—</p>}
              </div>
            </section>
          );
        })}
      </div>
    </main>
  );
}

function TicketCard({ card }: { card: Card }) {
  const last = card.stages[card.stages.length - 1];
  return (
    <article className="card">
      <div className="card-head">
        <span className="id">{card.id}</span>
        <span className={`squad squad-${card.squad}`}>{card.squad}</span>
      </div>
      <p className="title">{card.title}</p>
      <div className="meta">
        {card.complexity && <span className="chip">{card.complexity}</span>}
        {last && (
          <span className={`chip stage-${last.status}`}>
            {last.skill}:{last.stage} · {last.status}
          </span>
        )}
        {card.verdict && <span className={`chip verdict-${card.verdict}`}>{card.verdict}</span>}
      </div>
    </article>
  );
}
