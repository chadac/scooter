/**
 * Title-marker extraction from a streaming assistant message. The agent begins a
 * new conversation with `<title>Concise task title</title>`; this stateful scanner
 * detects the marker even when split across deltas, reports the title once, and
 * strips it from the text shown to the user, buffering only a possible partial tag
 * at the tail so normal text passes through with near-zero latency.
 */

const OPEN = "<title>";
const CLOSE = "</title>";
/** Longer or multi-line: prose mentioning the tag. */
const MAX_TITLE = 200;

export interface TitleExtractor {
  /** Feed a text delta, returning the text to display and, exactly once, the extracted title. */
  push(delta: string): { text: string; title?: string };
  /** Release held-back text; `abandoned` if <title> never closed. */
  flush(): { text: string; abandoned: boolean };
}

export function createTitleExtractor(): TitleExtractor {
  // Pending tail that might be the start of a tag not yet completed.
  let pending = "";
  // Inside a <title>…, accumulate until CLOSE.
  let inTitle = false;
  let titleBuf = "";
  let reported = false;

  /** Length of the longest suffix of `s` that is a proper prefix of `tag`. */
  const partialTagSuffix = (s: string, tag: string): number => {
    const max = Math.min(s.length, tag.length - 1);
    for (let n = max; n > 0; n--) {
      if (s.slice(s.length - n) === tag.slice(0, n)) return n;
    }
    return 0;
  };

  /** Not a marker: return `<title>` and its tail as text. */
  const abandon = (): string => {
    const text = OPEN + titleBuf;
    inTitle = false;
    titleBuf = "";
    return text;
  };
  const implausible = (s: string): boolean => s.length > MAX_TITLE || s.includes("\n");

  return {
    push(delta: string): { text: string; title?: string } {
      let out = "";
      let title: string | undefined;
      let buf = pending + delta;
      pending = "";

      while (buf.length > 0) {
        if (inTitle) {
          const close = buf.indexOf(CLOSE);
          if (close === -1) {
            // Still inside the title, so keep buffering but hold back a partial CLOSE tag.
            const hold = partialTagSuffix(buf, CLOSE);
            titleBuf += buf.slice(0, buf.length - hold);
            pending = buf.slice(buf.length - hold);
            buf = "";
            if (implausible(titleBuf)) {
              out += abandon() + pending;
              pending = "";
            }
          } else if (implausible(titleBuf + buf.slice(0, close))) {
            titleBuf += buf.slice(0, close + CLOSE.length);
            buf = buf.slice(close + CLOSE.length);
            out += abandon();
          } else {
            titleBuf += buf.slice(0, close);
            buf = buf.slice(close + CLOSE.length);
            inTitle = false;
            if (!reported) {
              title = titleBuf.trim();
              reported = true;
            }
            titleBuf = "";
          }
          continue;
        }

        // One title per conversation; later tags are just text.
        const open = reported ? -1 : buf.indexOf(OPEN);
        if (open === -1 && reported) {
          out += buf;
          buf = "";
        } else if (open === -1) {
          // No opening tag, so emit everything except a possible partial OPEN tail.
          const hold = partialTagSuffix(buf, OPEN);
          out += buf.slice(0, buf.length - hold);
          pending = buf.slice(buf.length - hold);
          buf = "";
        } else {
          out += buf.slice(0, open);
          buf = buf.slice(open + OPEN.length);
          inTitle = true;
        }
      }

      return title !== undefined ? { text: out, title } : { text: out };
    },

    flush(): { text: string; abandoned: boolean } {
      const abandoned = inTitle;
      const text = (inTitle ? abandon() : "") + pending;
      pending = "";
      return { text, abandoned };
    },
  };
}
