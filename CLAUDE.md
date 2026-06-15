# personal-claude-code-dashboard

Live ticket board for the **personal-claude-code v2** plugin. Read-only consumer of the plugin's `.claude-team/events.jsonl` over SSE — it never writes plugin state or wakes the orchestrator.

## Rules
- Stay a **read-only** view. The plugin appends events; this app only tails + renders.
- The event schema is the **contract** (`docs/events-contract.md` in the plugin repo). Keep `lib/events.ts` in sync; tolerate unknown event types.
- Next.js (App Router) + TypeScript. Server Components by default; the board page is the one client component (EventSource). See the plugin's `nextjs-core` conventions.
- Configure the source via `EVENTS_LOG` (absolute path).
