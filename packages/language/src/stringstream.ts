function countCol(
  string: string,
  end: number | null,
  tabSize: number,
  startIndex = 0,
  startValue = 0,
): number {
  if (end == null) {
    end = string.search(/[^\s\u00a0]/);
    if (end == -1) end = string.length;
  }
  let n = startValue;
  for (let i = startIndex; i < end; i++) {
    if (string.charCodeAt(i) == 9) n += tabSize - (n % tabSize);
    else n++;
  }
  return n;
}

export class StringStream {
  pos = 0;
  start = 0;
  private lastColumnPos = 0;
  private lastColumnValue = 0;

  constructor(
    public string: string,
    private tabSize: number,
    public indentUnit: number,
    private overrideIndent?: number,
  ) {}

  eol(): boolean {
    return this.pos >= this.string.length;
  }

  sol(): boolean {
    return this.pos == 0;
  }

  peek() {
    return this.string.charAt(this.pos) || undefined;
  }

  next(): string | void {
    if (this.pos < this.string.length) return this.string.charAt(this.pos++);
  }

  eat(match: string | RegExp | ((ch: string) => boolean)): string | void {
    let ch = this.string.charAt(this.pos);
    let ok;
    if (typeof match == "string") ok = ch == match;
    else ok = ch && (match instanceof RegExp ? match.test(ch) : match(ch));
    if (ok) {
      ++this.pos;
      return ch;
    }
  }

  eatWhile(match: string | RegExp | ((ch: string) => boolean)): boolean {
    let start = this.pos;
    while (this.eat(match)) {}
    return this.pos > start;
  }

  eatSpace() {
    let start = this.pos;
    while (/[\s\u00a0]/.test(this.string.charAt(this.pos))) ++this.pos;
    return this.pos > start;
  }

  skipToEnd() {
    this.pos = this.string.length;
  }

  skipTo(ch: string): boolean | void {
    let found = this.string.indexOf(ch, this.pos);
    if (found > -1) {
      this.pos = found;
      return true;
    }
  }

  backUp(n: number) {
    this.pos -= n;
  }

  column() {
    if (this.lastColumnPos < this.start) {
      this.lastColumnValue = countCol(
        this.string,
        this.start,
        this.tabSize,
        this.lastColumnPos,
        this.lastColumnValue,
      );
      this.lastColumnPos = this.start;
    }
    return this.lastColumnValue;
  }

  indentation() {
    return this.overrideIndent ?? countCol(this.string, null, this.tabSize);
  }

  match(
    pattern: string | RegExp,
    consume?: boolean,
    caseInsensitive?: boolean,
  ): boolean | RegExpMatchArray | null {
    if (typeof pattern == "string") {
      let cased = (str: string) => (caseInsensitive ? str.toLowerCase() : str);
      let substr = this.string.substr(this.pos, pattern.length);
      if (cased(substr) == cased(pattern)) {
        if (consume !== false) this.pos += pattern.length;
        return true;
      }
      return null;
    }
    let match = this.string.slice(this.pos).match(pattern);
    if (match && match.index! > 0) return null;
    if (match && consume !== false) this.pos += match[0].length;
    return match;
  }

  current() {
    return this.string.slice(this.start, this.pos);
  }
}
