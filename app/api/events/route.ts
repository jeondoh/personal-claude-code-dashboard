import fs from 'node:fs';
import path from 'node:path';

// Stream the plugin's append-only events.jsonl as Server-Sent Events.
// Path is configurable via EVENTS_LOG; defaults to the dogfood sibling repo.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const EVENTS_LOG =
  process.env.EVENTS_LOG ||
  path.resolve(process.cwd(), '../personal-claude-code-v2/.claude-team/events.jsonl');

export function GET(req: Request) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let offset = 0;
      let closed = false;
      const send = (payload: string) => {
        if (!closed) controller.enqueue(encoder.encode(payload));
      };

      const pump = () => {
        try {
          if (!fs.existsSync(EVENTS_LOG)) return;
          const { size } = fs.statSync(EVENTS_LOG);
          if (size < offset) offset = 0; // file truncated / rotated
          if (size <= offset) return;
          const fd = fs.openSync(EVENTS_LOG, 'r');
          const buf = Buffer.alloc(size - offset);
          fs.readSync(fd, buf, 0, buf.length, offset);
          fs.closeSync(fd);
          offset = size;
          for (const line of buf.toString('utf8').split('\n')) {
            if (line.trim()) send(`data: ${line}\n\n`);
          }
        } catch {
          /* transient read error — retry next tick */
        }
      };

      send(`event: meta\ndata: ${JSON.stringify({ log: EVENTS_LOG })}\n\n`);
      pump(); // initial backlog
      const tick = setInterval(pump, 1000);
      const ping = setInterval(() => send(': ping\n\n'), 15000);

      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(tick);
        clearInterval(ping);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      req.signal.addEventListener('abort', close);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
