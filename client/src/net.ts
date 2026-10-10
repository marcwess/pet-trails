import type { DeltaMsg, WelcomeMsg } from '@pet-trails/shared';

export type NetMode = 'connecting' | 'online' | 'offline';

/** Empty config, or ws:// from an https page, must not open a socket. */
export function offlineSocketReason(protocol: string, url: string): 'empty' | 'mixed' | null {
  const trimmed = url.trim();
  if (!trimmed) return 'empty';
  if (protocol === 'https:' && /^ws:\/\//i.test(trimmed)) return 'mixed';
  return null;
}

export class NetClient {
  mode: NetMode = 'connecting';
  ping = 0;
  id = 0;
  private ws: WebSocket | null = null;
  private pingTimer = 0;
  private readonly readyWaiters: Array<(mode: NetMode) => void> = [];

  onWelcome: ((msg: WelcomeMsg) => void) | null = null;
  onDelta: ((msg: DeltaMsg) => void) | null = null;
  onMode: ((mode: NetMode) => void) | null = null;
  onFull: (() => void) | null = null;

  /** One-way delay from `?lag=`, so a local server can feel like a phone RTT. */
  private readonly lag: number;
  /** Recent packets, only when `?debug=1`. */
  readonly trace: string[] = [];
  private readonly tracing: boolean;

  constructor(private readonly url: string) {
    const raw = typeof location === 'undefined' ? '' : new URLSearchParams(location.search).get('lag') ?? '';
    const n = Number(raw);
    this.lag = Number.isFinite(n) && n > 0 ? Math.min(400, n) : 0;
    this.tracing = typeof location !== 'undefined' && new URLSearchParams(location.search).get('debug') === '1';
  }

  private note(line: string): void {
    if (!this.tracing) return;
    this.trace.push(line);
    if (this.trace.length > 40) this.trace.shift();
  }

  start(): void {
    if (this.mode !== 'connecting') return;
    const protocol = typeof location === 'undefined' ? 'http:' : location.protocol;
    if (offlineSocketReason(protocol, this.url)) {
      this.setMode('offline');
      return;
    }
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.setMode('offline');
      return;
    }
    ws.binaryType = 'arraybuffer';
    let opened = false;
    let failed = false;
    let hard = 0;
    const fail = () => {
      if (opened || failed || this.mode !== 'connecting') return;
      failed = true;
      window.clearTimeout(hard);
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      this.setMode('offline');
    };
    // A blocked mixed-content socket may never emit error or close. Don't wait on it.
    hard = window.setTimeout(fail, 3000);
    ws.onopen = () => {
      if (failed || this.mode !== 'connecting') {
        try {
          ws.close();
        } catch {
          /* already closed */
        }
        return;
      }
      opened = true;
      window.clearTimeout(hard);
      this.ws = ws;
      this.setMode('online');
      this.pingTimer = window.setInterval(() => this.sendPing(), 1000);
    };
    ws.onerror = () => fail();
    ws.onclose = () => {
      if (!opened) {
        fail();
        return;
      }
      window.clearInterval(this.pingTimer);
      if (this.ws === ws) this.ws = null;
      if (this.mode === 'online') this.setMode('offline');
    };
    ws.onmessage = (ev) => {
      if (this.lag > 0) window.setTimeout(() => this.onMessage(ev.data), this.lag);
      else this.onMessage(ev.data);
    };
  }

  whenSettled(): Promise<NetMode> {
    if (this.mode !== 'connecting') return Promise.resolve(this.mode);
    return new Promise((resolve) => this.readyWaiters.push(resolve));
  }

  send(msg: object): void {
    if ((msg as { t?: string }).t !== 'ping') this.note('> ' + JSON.stringify(msg).slice(0, 96));
    const deliver = () => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
    };
    if (this.lag > 0) window.setTimeout(deliver, this.lag);
    else deliver();
  }

  private setMode(mode: NetMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.onMode?.(mode);
    if (mode !== 'connecting') {
      for (const fn of this.readyWaiters) fn(mode);
      this.readyWaiters.length = 0;
    }
  }

  private sendPing(): void {
    this.send({ t: 'ping', n: performance.now() });
  }

  private onMessage(data: unknown): void {
    if (data instanceof ArrayBuffer) return;
    const text = typeof data === 'string' ? data : String(data);
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    const t = (msg as { t?: string }).t;
    if (t === 'welcome') {
      const w = msg as WelcomeMsg;
      this.note(`< welcome id=${w.id}`);
      this.onWelcome?.(w);
    } else if (t === 'delta') {
      const d = msg as DeltaMsg;
      this.note(`< delta ack=${d.ack} you=${d.you?.join(',')}`);
      this.onDelta?.(d);
    } else if (t === 'pong') {
      const n = (msg as { n?: number }).n;
      if (typeof n === 'number') this.ping = performance.now() - n;
    } else if (t === 'full') this.onFull?.();
  }
}
