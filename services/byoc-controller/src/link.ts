// Resumable link: seq-stamped frames, acked outbox, replay on reconnect.
// Keep identical to the other service's link.ts.

/** How long a dropped link is held before failing. */
export const LINK_GRACE_MS = 120_000;
/** Ack early under load to keep the outbox short. */
export const ACK_EVERY_FRAMES = 64;
/** Ack at most this long after a frame. */
export const ACK_DELAY_MS = 1_000;
/** Past either cap the link cannot resume. */
export const OUTBOX_MAX_FRAMES = 10_000;
export const OUTBOX_MAX_BYTES = 16 * 1024 * 1024;

/** Connect-URL params: link id and highest seq received. */
export const LINK_ID_PARAM = "linkId";
export const LINK_SEQ_PARAM = "linkSeq";

/** The `connected` payload's answer to a resume attempt. */
export interface LinkResume {
  resumed: boolean;
  /** Highest seq the answerer received from the dialer. */
  seq: number;
}

export interface LinkOptions {
  ackDelayMs?: number;
  maxFrames?: number;
  maxBytes?: number;
}

interface InboundFrame {
  ch?: string;
  type?: string;
  seq?: number;
  payload?: unknown;
}

export class Link {
  /** Highest peer seq delivered; the peer may drop up to it. */
  received = 0;
  /** The outbox outgrew its caps, so resume is refused. */
  overflowed = false;

  private nextSeq = 1;
  private outbox: Array<{ seq: number; raw: string }> = [];
  private bytes = 0;
  private unacked = 0;
  private ackTimer: ReturnType<typeof setTimeout> | undefined;
  private write: ((raw: string) => void) | undefined;
  private legacy = false;
  private readonly ackDelayMs: number;
  private readonly maxFrames: number;
  private readonly maxBytes: number;

  constructor(
    readonly id: string,
    opts: LinkOptions = {},
  ) {
    this.ackDelayMs = opts.ackDelayMs ?? ACK_DELAY_MS;
    this.maxFrames = opts.maxFrames ?? OUTBOX_MAX_FRAMES;
    this.maxBytes = opts.maxBytes ?? OUTBOX_MAX_BYTES;
  }

  get used(): boolean {
    return this.nextSeq > 1 || this.received > 0;
  }

  get attached(): boolean {
    return this.write !== undefined;
  }

  get pending(): number {
    return this.outbox.length;
  }

  /** Whether this outbox can catch up a peer at `peerSeq`. */
  canResume(peerSeq: number): boolean {
    if (this.overflowed || !Number.isInteger(peerSeq)) return false;
    const first = this.outbox.length ? this.outbox[0].seq : this.nextSeq;
    return peerSeq >= first - 1 && peerSeq <= this.nextSeq - 1;
  }

  /** Stamp, keep until acked, and write if bound. */
  send(frame: object): void {
    if (this.legacy) {
      this.writeRaw(JSON.stringify(frame));
      return;
    }
    const seq = this.nextSeq++;
    const raw = JSON.stringify({ ...frame, seq });
    if (!this.overflowed) {
      this.outbox.push({ seq, raw });
      this.bytes += raw.length;
      if (this.outbox.length > this.maxFrames || this.bytes > this.maxBytes) {
        this.overflowed = true;
        this.outbox = [];
        this.bytes = 0;
      }
    }
    this.writeRaw(raw);
  }

  /** Bind a socket and replay what the peer lacks. */
  attach(write: (raw: string) => void, peerSeq: number): void {
    this.dropAcked(peerSeq);
    this.write = write;
    for (const { raw } of this.outbox) this.writeRaw(raw);
    if (this.unacked) this.sendAck();
  }

  /** Unbind; later frames wait in the outbox. */
  detach(): void {
    this.write = undefined;
    clearTimeout(this.ackTimer);
    this.ackTimer = undefined;
  }

  /** A peer without links: write bare frames, keep nothing. */
  attachLegacy(write: (raw: string) => void): void {
    this.legacy = true;
    this.outbox = [];
    this.bytes = 0;
    this.write = write;
  }

  /** False for link frames and duplicates, which aren't delivered. */
  receive(frame: InboundFrame): boolean {
    if (frame.ch === "link") {
      if (frame.type === "ack") this.dropAcked((frame.payload as { seq?: number } | undefined)?.seq ?? 0);
      return false;
    }
    if (typeof frame.seq !== "number") return true;
    if (frame.seq <= this.received) return false;
    this.received = frame.seq;
    this.unacked += 1;
    if (this.unacked >= ACK_EVERY_FRAMES) this.sendAck();
    else this.ackTimer ??= setTimeout(() => this.sendAck(), this.ackDelayMs);
    return true;
  }

  dispose(): void {
    this.detach();
    this.outbox = [];
    this.bytes = 0;
  }

  private sendAck(): void {
    clearTimeout(this.ackTimer);
    this.ackTimer = undefined;
    if (!this.write) return;
    this.unacked = 0;
    this.writeRaw(JSON.stringify({ ch: "link", type: "ack", payload: { seq: this.received } }));
  }

  private dropAcked(seq: number): void {
    let n = 0;
    while (n < this.outbox.length && this.outbox[n].seq <= seq) {
      this.bytes -= this.outbox[n].raw.length;
      n += 1;
    }
    if (n) this.outbox.splice(0, n);
  }

  private writeRaw(raw: string): void {
    if (!this.write) return;
    try {
      this.write(raw);
    } catch {
      // A closing socket; the outbox still holds the frame.
    }
  }
}
