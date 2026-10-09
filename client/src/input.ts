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
  private readonly keysOnly = new URLSearchParams(location.search).has('keys');

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

  /** Where the finger is, for the on-screen ring. Steering math is unchanged. */
  stick(): { x: number; y: number; dx: number; dy: number; on: boolean } {
    return {
      x: this.originX,
      y: this.originY,
      dx: this.lastX - this.originX,
      dy: this.lastY - this.originY,
      on: this.active,
    };
  }

  /**
   * Screen-space stick. `heading` is the pet's facing (camera looks along it),
   * so drag-up and W move toward the top of the screen.
   */
  sample(heading: number): void {
    let x = 0;
    let y = 0;
    let steering = false;
    const fx = Math.cos(heading);
    const fz = Math.sin(heading);
    const w = this.keys.has('w') || this.keys.has('arrowup');
    const a = this.keys.has('a') || this.keys.has('arrowleft');
    const s = this.keys.has('s') || this.keys.has('arrowdown');
    const d = this.keys.has('d') || this.keys.has('arrowright');
    if (w || a || s || d) {
      const sx = (d ? 1 : 0) - (a ? 1 : 0);
      const sy = (w ? 1 : 0) - (s ? 1 : 0);
      x = -fz * sx + fx * sy;
      y = fx * sx + fz * sy;
      steering = true;
    } else if (this.active) {
      const dx = this.lastX - this.originX;
      const dy = this.lastY - this.originY;
      if (dx * dx + dy * dy > 36) {
        x = -fz * dx - fx * dy;
        y = fx * dx - fz * dy;
        steering = true;
      }
    } else if (this.fine && this.mouseValid && !this.keysOnly) {
      const p = this.playerScreen();
      if (p) {
        const dx = this.mouseX - p.x;
        const dy = this.mouseY - p.y;
        x = -fz * dx - fx * dy;
        y = fx * dx - fz * dy;
        if (dx * dx + dy * dy > 16) steering = true;
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
