// Minimal YAML-frontmatter parser for ticket .md files. Pure (no fs) so it can
// run on the server and be unit-tested. Handles the subset tickets actually use:
// `key: value`, quoted values, `key: []`, and block lists (`key:` then `  - item`).

export type Frontmatter = Record<string, string | string[]>;

const unquote = (s: string): string => {
  const t = s.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
};

function parseYamlLines(head: string[], fm: Frontmatter): void {
  let j = 0;
  while (j < head.length) {
    const m = head[j].match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!m) { j++; continue; }
    const key = m[1];
    const rest = m[2].trim();
    if (rest === '') {
      const arr: string[] = [];
      let k = j + 1;
      while (k < head.length && /^\s*-\s+/.test(head[k])) {
        arr.push(unquote(head[k].replace(/^\s*-\s+/, '')));
        k++;
      }
      fm[key] = arr;
      j = arr.length ? k : j + 1;
    } else if (rest === '[]') {
      fm[key] = [];
      j++;
    } else {
      fm[key] = unquote(rest);
      j++;
    }
  }
}

export function parseFrontmatter(raw: string): { frontmatter: Frontmatter; body: string } {
  const fm: Frontmatter = {};
  const text = raw.replace(/\r\n/g, '\n');
  if (!text.startsWith('---')) return { frontmatter: fm, body: text.trim() };

  const lines = text.split('\n');
  let i = 1; // skip opening ---
  const head: string[] = [];
  while (i < lines.length && lines[i].trim() !== '---') head.push(lines[i++]);
  let body = lines.slice(i + 1).join('\n').trim();

  parseYamlLines(head, fm);

  // Some tickets emit two consecutive frontmatter blocks (plugin format).
  // Merge the second block into fm; remaining text becomes the real body.
  if (body.startsWith('---')) {
    const body2Lines = body.split('\n');
    let bi = 1;
    const head2: string[] = [];
    while (bi < body2Lines.length && body2Lines[bi].trim() !== '---') head2.push(body2Lines[bi++]);
    parseYamlLines(head2, fm);
    body = body2Lines.slice(bi + 1).join('\n').trim();
  }

  return { frontmatter: fm, body };
}

export const fmString = (v: string | string[] | undefined): string | undefined =>
  typeof v === 'string' ? v : undefined;

export const fmArray = (v: string | string[] | undefined): string[] | undefined =>
  Array.isArray(v) ? v : undefined;
