export class Input {
  desiredX = 0;
  desiredY = 0;
  steering = false;
  private active = false;
  private pointerId = -1;
  private originX = 0;
  private originY = 0;
  private lastX = 0;
  private lastY = 0;
  private readonly keys = new Set<string>();
  private mouseX = 0;
  private mouseY = 0;
  private mouseValid = false;
  private readonly fine = window.matchMedia('(pointer: fine)').matches;

  constructor(private readonly playerScreen: () => { x: number; y: number } | null) {
    window.addEventListener('pointerdown', this.onDown, { passive: false });
    window.addEventListener('pointermove', this.onMove, { passive: false });
    window.addEventListener('pointerup', this.onUp);
    window.addEventListener('pointercancel', this.onUp);
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', () => {
      this.active = false;
      this.keys.clear();
    });
    window.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private onDown = (ev: PointerEvent) => {
    if (ev.target instanceof Element && ev.target.closest('button, a, input')) return;
    this.active = true;
    this.pointerId = ev.pointerId;
    this.originX = ev.clientX;
    this.originY = ev.clientY;
    this.lastX = ev.clientX;
    this.lastY = ev.clientY;
  };

  private onMove = (ev: PointerEvent) => {
    this.mouseX = ev.clientX;
    this.mouseY = ev.clientY;
    this.mouseValid = true;
    if (!this.active || ev.pointerId !== this.pointerId) return;
    this.lastX = ev.clientX;
    this.lastY = ev.clientY;
    ev.preventDefault();
  };

  private onUp = (ev: PointerEvent) => {
    if (ev.pointerId !== this.pointerId) return;
    this.active = false;
    this.pointerId = -1;
  };

  private onKey = (ev: KeyboardEvent) => {
    this.keys.add(ev.key.toLowerCase());
  };

  private onKeyUp = (ev: KeyboardEvent) => {
    this.keys.delete(ev.key.toLowerCase());
  };

  /** Screen +Y is sim +Y (camera looks from +Z). WASD up is screen-up, sim -Y. */
  sample(): void {
    let x = 0;
    let y = 0;
    let steering = false;
    const w = this.keys.has('w') || this.keys.has('arrowup');
    const a = this.keys.has('a') || this.keys.has('arrowleft');
    const s = this.keys.has('s') || this.keys.has('arrowdown');
    const d = this.keys.has('d') || this.keys.has('arrowright');
    if (w || a || s || d) {
      x = (d ? 1 : 0) - (a ? 1 : 0);
      y = (s ? 1 : 0) - (w ? 1 : 0);
      steering = true;
    } else if (this.active) {
      const dx = this.lastX - this.originX;
      const dy = this.lastY - this.originY;
      if (dx * dx + dy * dy > 36) {
        x = dx;
        y = dy;
        steering = true;
      }
    } else if (this.fine && this.mouseValid) {
      const p = this.playerScreen();
      if (p) {
        x = this.mouseX - p.x;
        y = this.mouseY - p.y;
        if (x * x + y * y > 16) steering = true;
      }
    }
    if (steering) {
      this.desiredX = x;
      this.desiredY = y;
      this.steering = true;
    } else if (!this.active) {
      this.steering = false;
    }
  }
}
