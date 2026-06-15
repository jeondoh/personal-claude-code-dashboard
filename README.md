# personal-claude-code-dashboard

Live ticket board for [**personal-claude-code v2**](https://github.com/sideholic/personal-claude-code-v2). A read-only Next.js app that tails the plugin's append-only `.claude-team/events.jsonl` and renders a kanban board (queue → in-progress → in-review → done) with per-skill stage detail, streamed live over Server-Sent Events.

It **never** writes plugin state or wakes the orchestrator — the tail-watch lives only here, in the read layer.

## Contract

The event schema is fixed by the plugin's `docs/events-contract.md` (v1). `lib/events.ts` mirrors it: a common envelope (`v/seq/ts/event/feature/ticket/actor/data`), Tier-1 ticket lifecycle (board columns) + Tier-2 per-skill `stage.*` (card timeline). Unknown event types are ignored (forward-compatible).

## Run (local)

```bash
pnpm install
EVENTS_LOG=/abs/path/to/project/.claude-team/events.jsonl pnpm dev
# open http://localhost:4317
```

If `EVENTS_LOG` is unset it defaults to `../personal-claude-code-v2/.claude-team/events.jsonl` (the dogfood sibling layout).

## Run (docker)

```bash
docker build -t claude-board .
docker run -p 4317:4317 \
  -v /abs/path/to/project/.claude-team/events.jsonl:/data/events.jsonl:ro \
  claude-board
```

## Stack

Next.js 15 (App Router) · React 19 · TypeScript · SSE (no extra deps). MVP — live polling tail at 1s. WebSocket upgrade is a later option.
