import type { DeltaMsg, WelcomeMsg } from '@pet-trails/shared';

export type NetMode = 'connecting' | 'online' | 'offline';

export class NetClient {
  mode: NetMode = 'connecting';
  ping = 0;
  id = 0;
  private ws: WebSocket | null = null;
  private pingTimer = 0;
  private readonly readyWaiters: Array<(mode: NetMode) => void> = [];

  onWelcome: ((msg: WelcomeMsg) => void) | null = null;
  onDelta: ((msg: DeltaMsg) => void) | null = null;
  onGrid: ((owner: Uint8Array, trail: Uint8Array, tick: number) => void) | null = null;
  onMode: ((mode: NetMode) => void) | null = null;
  onFull: (() => void) | null = null;

  constructor(private readonly url: string) {}

  start(): void {
    const deadline = performance.now() + 3000;
    const attempt = () => {
      if (this.mode !== 'connecting') return;
      const left = deadline - performance.now();
      if (left <= 0) {
        this.setMode('offline');
        return;
      }
      let ws: WebSocket;
      try {
        ws = new WebSocket(this.url);
      } catch {
        window.setTimeout(attempt, 200);
        return;
      }
      ws.binaryType = 'arraybuffer';
      let opened = false;
      let finished = false;
      const retry = () => {
        if (finished || opened || this.mode !== 'connecting') return;
        finished = true;
        window.clearTimeout(giveUp);
        window.setTimeout(attempt, 160);
      };
      const giveUp = window.setTimeout(() => {
        if (opened) return;
        try {
          ws.close();
        } catch {
          /* already closed */
        }
        retry();
      }, Math.min(800, Math.max(40, left)));
      ws.onopen = () => {
        opened = true;
        finished = true;
        window.clearTimeout(giveUp);
        this.ws = ws;
        this.setMode('online');
        this.pingTimer = window.setInterval(() => this.sendPing(), 1000);
      };
      ws.onerror = () => {
        if (!opened) retry();
      };
      ws.onclose = () => {
        if (!opened) {
          retry();
          return;
        }
        window.clearInterval(this.pingTimer);
        this.ws = null;
        if (this.mode === 'online') this.setMode('offline');
      };
      ws.onmessage = (ev) => this.onMessage(ev.data);
    };
    attempt();
  }

  whenSettled(): Promise<NetMode> {
    if (this.mode !== 'connecting') return Promise.resolve(this.mode);
    return new Promise((resolve) => this.readyWaiters.push(resolve));
  }

  send(msg: object): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
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
    if (data instanceof ArrayBuffer) {
      const view = new DataView(data);
      if (view.byteLength < 5 || view.getUint8(0) !== 1) return;
      const tick = view.getUint32(1, true);
      const n = (view.byteLength - 5) / 2;
      const bytes = new Uint8Array(data);
      const owner = bytes.subarray(5, 5 + n);
      const trail = bytes.subarray(5 + n, 5 + n * 2);
      this.onGrid?.(owner, trail, tick);
      return;
    }
    const text = typeof data === 'string' ? data : String(data);
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    const t = (msg as { t?: string }).t;
    if (t === 'welcome') this.onWelcome?.(msg as WelcomeMsg);
    else if (t === 'delta') this.onDelta?.(msg as DeltaMsg);
    else if (t === 'pong') {
      const n = (msg as { n?: number }).n;
      if (typeof n === 'number') this.ping = performance.now() - n;
    }     else if (t === 'full') this.onFull?.();
  }
}
