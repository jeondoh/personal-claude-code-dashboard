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

export function parseFrontmatter(raw: string): { frontmatter: Frontmatter; body: string } {
  const fm: Frontmatter = {};
  const text = raw.replace(/\r\n/g, '\n');
  if (!text.startsWith('---')) return { frontmatter: fm, body: text.trim() };

  const lines = text.split('\n');
  let i = 1; // skip opening ---
  const head: string[] = [];
  while (i < lines.length && lines[i].trim() !== '---') head.push(lines[i++]);
  const body = lines.slice(i + 1).join('\n').trim();

  let j = 0;
  while (j < head.length) {
    const m = head[j].match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!m) {
      j++;
      continue;
    }
    const key = m[1];
    const rest = m[2].trim();

    if (rest === '' ) {
      // possible block list on following indented `- item` lines
      const arr: string[] = [];
      let k = j + 1;
      while (k < head.length && /^\s*-\s+/.test(head[k])) {
        arr.push(unquote(head[k].replace(/^\s*-\s+/, '')));
        k++;
      }
      fm[key] = arr; // empty array if none — harmless
      j = arr.length ? k : j + 1;
    } else if (rest === '[]') {
      fm[key] = [];
      j++;
    } else {
      fm[key] = unquote(rest);
      j++;
    }
  }
  return { frontmatter: fm, body };
}

export const fmString = (v: string | string[] | undefined): string | undefined =>
  typeof v === 'string' ? v : undefined;

export const fmArray = (v: string | string[] | undefined): string[] | undefined =>
  Array.isArray(v) ? v : undefined;
