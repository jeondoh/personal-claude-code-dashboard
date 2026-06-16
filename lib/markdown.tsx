import React from 'react';

// Tiny dependency-free markdown renderer for ticket bodies.
// Handles the constructs tickets actually use: headings, fenced code, ordered/
// unordered lists (one level of nesting), bold, inline code, and paragraphs.
// Builds React nodes directly — no dangerouslySetInnerHTML.

/** Inline: `code` and **bold** (code wins; no bold inside code spans). */
function inline(text: string, keyBase: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const parts = text.split(/(`[^`]+`)/g);
  parts.forEach((part, i) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
      out.push(<code key={`${keyBase}-c${i}`}>{part.slice(1, -1)}</code>);
      return;
    }
    const segs = part.split(/(\*\*[^*]+\*\*)/g);
    segs.forEach((seg, j) => {
      if (!seg) return;
      if (seg.startsWith('**') && seg.endsWith('**') && seg.length >= 4) {
        out.push(<strong key={`${keyBase}-b${i}-${j}`}>{seg.slice(2, -2)}</strong>);
      } else {
        out.push(<React.Fragment key={`${keyBase}-t${i}-${j}`}>{seg}</React.Fragment>);
      }
    });
  });
  return out;
}

type ListItem = { ordered: boolean; content: string; children: ListItem[] };

function renderList(items: ListItem[], key: string): React.ReactNode {
  const ordered = items[0]?.ordered;
  const Tag = ordered ? 'ol' : 'ul';
  return (
    <Tag key={key} className="md-list">
      {items.map((it, i) => (
        <li key={`${key}-${i}`}>
          {inline(it.content, `${key}-${i}`)}
          {it.children.length > 0 && renderList(it.children, `${key}-${i}-sub`)}
        </li>
      ))}
    </Tag>
  );
}

export function Markdown({ source }: { source: string }) {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: React.ReactNode[] = [];
  let key = 0;
  let i = 0;
  let para: string[] = [];

  const flushPara = () => {
    if (para.length) {
      blocks.push(
        <p key={`p${key++}`} className="md-p">
          {inline(para.join(' '), `p${key}`)}
        </p>,
      );
      para = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    // fenced code block
    const fence = line.match(/^```(.*)$/);
    if (fence) {
      flushPara();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
      i++; // closing fence
      blocks.push(
        <pre key={`code${key++}`} className="md-pre">
          <code>{code.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    // heading
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara();
      const level = Math.min(h[1].length, 6);
      const Tag = `h${Math.max(level, 3)}` as 'h3' | 'h4' | 'h5' | 'h6';
      blocks.push(
        <Tag key={`h${key++}`} className={`md-h md-h${level}`}>
          {inline(h[2], `h${key}`)}
        </Tag>,
      );
      i++;
      continue;
    }

    // list block (ordered or unordered, one nesting level via indentation)
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      flushPara();
      const items: ListItem[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        const m = lines[i].match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/)!;
        const indent = m[1].length;
        const ordered = /\d+\./.test(m[2]);
        const item: ListItem = { ordered, content: m[3], children: [] };
        if (indent >= 2 && items.length) items[items.length - 1].children.push(item);
        else items.push(item);
        i++;
      }
      blocks.push(renderList(items, `l${key++}`));
      continue;
    }

    // blank line → paragraph boundary
    if (line.trim() === '') {
      flushPara();
      i++;
      continue;
    }

    para.push(line.trim());
    i++;
  }
  flushPara();

  return <div className="md">{blocks}</div>;
}
