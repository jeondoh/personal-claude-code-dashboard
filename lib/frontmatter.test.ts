import { describe, expect, it } from 'vitest';
import { fmArray, fmString, parseFrontmatter } from './frontmatter';

describe('parseFrontmatter', () => {
  it('parses scalars, quoted values, block lists, and []', () => {
    const raw = [
      '---',
      'id: T-0582',
      'title: "imweb 상품 연동 BE"',
      'status: in_progress',
      'assignee: backend',
      'acceptance_criteria:',
      '  - "AC-1 적재"',
      '  - "AC-2 soft-mark"',
      'depends_on: []',
      '---',
      '# 본문',
      '내용 한 줄',
    ].join('\n');
    const { frontmatter, body } = parseFrontmatter(raw);
    expect(frontmatter.id).toBe('T-0582');
    expect(frontmatter.title).toBe('imweb 상품 연동 BE');
    expect(frontmatter.assignee).toBe('backend');
    expect(fmArray(frontmatter.acceptance_criteria)).toEqual(['AC-1 적재', 'AC-2 soft-mark']);
    expect(fmArray(frontmatter.depends_on)).toEqual([]);
    expect(body).toBe('# 본문\n내용 한 줄');
  });

  it('returns empty frontmatter when there is no fence', () => {
    const { frontmatter, body } = parseFrontmatter('no frontmatter here');
    expect(frontmatter).toEqual({});
    expect(body).toBe('no frontmatter here');
  });

  it('fmString / fmArray narrow values safely', () => {
    expect(fmString('x')).toBe('x');
    expect(fmString(['a'])).toBeUndefined();
    expect(fmArray(['a'])).toEqual(['a']);
    expect(fmArray('x')).toBeUndefined();
  });
});
