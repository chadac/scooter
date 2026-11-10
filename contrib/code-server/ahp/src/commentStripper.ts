const OPEN = "<!--";
const CLOSE = "-->";

/** Removes HTML comments from streamed markdown, across chunk boundaries. */
export class CommentStripper {
  private buf = "";
  private inComment = false;

  push(chunk: string): string {
    this.buf += chunk;
    let out = "";
    for (;;) {
      const marker = this.inComment ? CLOSE : OPEN;
      const at = this.buf.indexOf(marker);
      if (at >= 0) {
        if (!this.inComment) out += this.buf.slice(0, at);
        this.buf = this.buf.slice(at + marker.length);
        this.inComment = !this.inComment;
        continue;
      }
      // Hold back a tail that may be the start of the marker.
      const keep = partialSuffix(this.buf, marker);
      if (!this.inComment) out += this.buf.slice(0, this.buf.length - keep);
      this.buf = this.buf.slice(this.buf.length - keep);
      return out;
    }
  }

  /** The held-back tail once the message ends; an unclosed comment stays hidden. */
  end(): string {
    const rest = this.inComment ? "" : this.buf;
    this.buf = "";
    return rest;
  }
}

function partialSuffix(s: string, marker: string): number {
  for (let n = Math.min(marker.length - 1, s.length); n > 0; n--) {
    if (s.endsWith(marker.slice(0, n))) return n;
  }
  return 0;
}
