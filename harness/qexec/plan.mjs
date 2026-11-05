// plan.md parsing for qexec. A plan is free-form Markdown with a title and a "## Verify" section
// whose first fenced code block is the command that decides pass/fail.
export function parsePlan(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const titleLine = lines.find((l) => /^#\s+\S/.test(l)) ?? lines.find((l) => l.trim());
  const title = (titleLine ?? 'untitled').replace(/^#+\s*/, '').trim();

  // explicit boundary instead of \b, which does not work after Cyrillic letters
  const start = lines.findIndex((l) => /^#{2,3}\s*(verify|verification|проверка)(?=$|[\s:.(])/i.test(l.trim()));
  if (start < 0) throw new Error('plan has no "## Verify" section');
  const level = lines[start].match(/^#+/)[0].length;
  let verify = null;
  for (let i = start + 1; i < lines.length; i++) {
    const heading = lines[i].match(/^(#+)\s/);
    if (heading && heading[1].length <= level) break;
    const fence = lines[i].match(/^(```+|~~~+)/);
    if (fence) {
      const body = [];
      for (i++; i < lines.length && !lines[i].startsWith(fence[1]); i++) body.push(lines[i]);
      verify = body.join('\n').trim();
      break;
    }
  }
  if (!verify) throw new Error('the "## Verify" section has no fenced command block');
  return { title, verify, text };
}

export function slugify(s, max = 32) {
  const slug = s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return (slug.slice(0, max).replace(/-+$/, '') || 'task');
}
