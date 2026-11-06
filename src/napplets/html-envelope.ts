const doctype = /^[\t\n\f\r ]*<!doctype[\t\n\f\r ]+html[\t\n\f\r ]*>/i;
const htmlStart = /<html(?:[\t\n\f\r ]+[a-z][a-z0-9:-]*[\t\n\f\r ]*=[\t\n\f\r ]*(?:"[^"<>]*"|'[^'<>]*'))*[\t\n\f\r ]*>/iy;
const headStart = /<head(?:[\t\n\f\r ]+[a-z][a-z0-9:-]*[\t\n\f\r ]*=[\t\n\f\r ]*(?:"[^"<>]*"|'[^'<>]*'))*[\t\n\f\r ]*>/iy;
const whitespace = /[\t\n\f\r ]*/y;
const unsafe = (): never => { throw new Error('Unsafe published document head'); };

function afterTrivia(html: string, offset: number): number {
  for (;;) {
    whitespace.lastIndex = offset;
    whitespace.test(html);
    offset = whitespace.lastIndex;
    if (!html.startsWith('<!--', offset)) return offset;
    const from = offset + 4;
    const end = html.indexOf('-->', from);
    if (end < 0) return unsafe();
    const content = html.slice(from, end);
    if (content.startsWith('>') || content.startsWith('->') || content.endsWith('<!-') ||
        /<!--|--!>|\u0000/.test(content)) return unsafe();
    offset = end + 3;
  }
}

function tagEnd(html: string, tag: RegExp, start: number): number {
  tag.lastIndex = afterTrivia(html, start);
  if (!tag.test(html)) return unsafe();
  return tag.lastIndex;
}

/** Locate an explicit head after a doctype, root start tag and inert comments. */
export function publishedHtmlHead(html: string): Readonly<{doctypeEnd: number; headEnd: number}> {
  const match = doctype.exec(html);
  if (!match) return unsafe();
  const doctypeEnd = match[0].length;
  const headEnd = tagEnd(html, headStart, tagEnd(html, htmlStart, doctypeEnd));
  return {doctypeEnd, headEnd};
}
