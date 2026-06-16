import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from '@/lib/frontmatter';

// Read-only: serve a ticket's markdown file (frontmatter + body) for the detail modal.
// The board is a read-only consumer — this only *reads* the plugin's ticket files,
// derived from EVENTS_LOG's directory. It never writes plugin state.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const EVENTS_LOG =
  process.env.EVENTS_LOG ||
  path.resolve(process.cwd(), '../personal-claude-code-v2/.claude-team/events.jsonl');

const TEAM_ROOT = path.dirname(EVENTS_LOG);
const ID_RE = /^[A-Za-z]{1,8}-\d{1,8}$/; // T-0580 / RV-0001 / BL-0009
// Dirs that never hold ticket bodies — skip while walking.
const SKIP_DIRS = new Set(['workers', 'node_modules', '.git', 'handoff']);
const MAX_DEPTH = 6;

/**
 * Locate `<id>-*.md` (or `<id>.md`) anywhere under `.claude-team`.
 * The tree is nested and irregular — tickets live in `tickets/{status}/`, but
 * archived ones sit under `archive/<YYYY-MM>/tickets/...`, backlog under
 * `backlog/`, etc. So we walk the tree (depth-limited) rather than guess paths.
 */
function findTicketFile(id: string): { file: string; status: string } | null {
  const stack: Array<{ dir: string; depth: number }> = [{ dir: TEAM_ROOT, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable dir — skip
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (depth < MAX_DEPTH && !SKIP_DIRS.has(e.name)) {
          stack.push({ dir: path.join(dir, e.name), depth: depth + 1 });
        }
      } else if (
        e.isFile() &&
        e.name.endsWith('.md') &&
        (e.name.startsWith(`${id}-`) || e.name === `${id}.md`)
      ) {
        return { file: path.join(dir, e.name), status: path.basename(dir) };
      }
    }
  }
  return null;
}

export function GET(req: Request) {
  const id = new URL(req.url).searchParams.get('id') ?? '';
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });

  if (!ID_RE.test(id)) return json({ found: false, error: 'invalid id' }, 400);

  const located = findTicketFile(id);
  if (!located) return json({ found: false, id });

  try {
    const raw = fs.readFileSync(located.file, 'utf8');
    const { frontmatter, body } = parseFrontmatter(raw);
    return json({
      found: true,
      id,
      status: located.status,
      file: path.relative(TEAM_ROOT, located.file), // relative location, e.g. tickets/done/T-0060-…
      frontmatter,
      body,
    });
  } catch {
    return json({ found: false, id, error: 'read failed' }, 500);
  }
}
