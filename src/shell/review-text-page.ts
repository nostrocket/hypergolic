const pageSize = 4096;

export function reviewTextPage(text: string, page: number) {
  const count = Math.max(1, Math.ceil(text.length / pageSize));
  const index = Math.max(0, Math.min(page, count - 1));
  function boundary(offset: number): number {
    if (offset >= text.length) return text.length;
    const unit = text.charCodeAt(offset);
    const previous = text.charCodeAt(offset - 1);
    return unit >= 0xdc00 && unit <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff ? offset - 1 : offset;
  }
  return {index, count, text: text.slice(boundary(index * pageSize), boundary((index + 1) * pageSize))};
}
