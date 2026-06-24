/**
 * Title-marker extraction from a streaming assistant message.
 *
 * The agent is instructed (via a skill) to begin a new conversation by emitting
 * a title marker:  <title>Concise task title</title>
 *
 * The bridge feeds assistant text deltas through this extractor, which:
 *   - detects a complete <title>…</title> (even split across deltas),
 *   - reports the title once (so the bridge can call setTitle),
 *   - and STRIPS the marker from the text shown to the user.
 *
 * It's a small stateful scanner: it buffers only the minimum needed to recognise
 * a (possibly partial) opening tag at the tail of the stream, so normal text
 * passes through with near-zero latency and the marker never leaks to the UI.
 */

const OPEN = "<title>";
const CLOSE = "</title>";

export interface TitleExtractor {
  /** Feed a text delta; returns the text to display (marker removed) and, once a
   *  complete marker has been seen, the extracted title (reported exactly once). */
  push(delta: string): { text: string; title?: string };
}

export function createTitleExtractor(): TitleExtractor {
  // Pending tail that might be the start of an OPEN tag we haven't completed yet.
  let pending = "";
  // Once we're inside a <title>…, accumulate until CLOSE.
  let inTitle = false;
  let titleBuf = "";
  let reported = false;

  /** Longest suffix of `s` that is a proper prefix of `tag` (so we can hold back
   *  a partial tag spanning deltas). Returns its length. */
  const partialTagSuffix = (s: string, tag: string): number => {
    const max = Math.min(s.length, tag.length - 1);
    for (let n = max; n > 0; n--) {
      if (s.slice(s.length - n) === tag.slice(0, n)) return n;
    }
    return 0;
  };

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
            // Still inside the title; keep buffering, but hold back a partial
            // CLOSE tag at the tail.
            const hold = partialTagSuffix(buf, CLOSE);
            titleBuf += buf.slice(0, buf.length - hold);
            pending = buf.slice(buf.length - hold);
            buf = "";
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

        const open = buf.indexOf(OPEN);
        if (open === -1) {
          // No opening tag; emit everything except a possible partial OPEN tail.
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
  };
}
