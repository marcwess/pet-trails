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
  private readonly stickEl = document.getElementById('stick');
  private readonly knobEl = document.getElementById('stick-knob');

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
    this.placeStick();
  };

  private onMove = (ev: PointerEvent) => {
    this.mouseX = ev.clientX;
    this.mouseY = ev.clientY;
    this.mouseValid = true;
    if (!this.active || ev.pointerId !== this.pointerId) return;
    this.lastX = ev.clientX;
    this.lastY = ev.clientY;
    this.placeStick();
    ev.preventDefault();
  };

  private onUp = (ev: PointerEvent) => {
    if (ev.pointerId !== this.pointerId) return;
    this.active = false;
    this.pointerId = -1;
    this.placeStick();
  };

  private onKey = (ev: KeyboardEvent) => {
    this.keys.add(ev.key.toLowerCase());
  };

  private onKeyUp = (ev: KeyboardEvent) => {
    this.keys.delete(ev.key.toLowerCase());
  };

  private readonly stickOut = { x: 0, y: 0, dx: 0, dy: 0, on: false };

  /** Where the finger is, for the on-screen ring. Steering math is unchanged. */
  stick(): { x: number; y: number; dx: number; dy: number; on: boolean } {
    const out = this.stickOut;
    out.x = this.originX;
    out.y = this.originY;
    out.dx = this.lastX - this.originX;
    out.dy = this.lastY - this.originY;
    out.on = this.active;
    return out;
  }

  /**
   * Absolute stick. Screen up is world +Y and screen right is world +X.
   * Drag is measured from the touch-down point, keys are those axes, and the
   * mouse is measured from the pet's screen position.
   */
  sample(): void {
    let x = 0;
    let y = 0;
    let steering = false;
    let hold = false;
    const w = this.keys.has('w') || this.keys.has('arrowup');
    const a = this.keys.has('a') || this.keys.has('arrowleft');
    const s = this.keys.has('s') || this.keys.has('arrowdown');
    const d = this.keys.has('d') || this.keys.has('arrowright');
    if (w || a || s || d) {
      x = (d ? 1 : 0) - (a ? 1 : 0);
      y = (w ? 1 : 0) - (s ? 1 : 0);
      steering = true;
    } else if (this.active) {
      const dx = this.lastX - this.originX;
      const dy = this.lastY - this.originY;
      const mag = Math.hypot(dx, dy);
      // Inside the deadzone the last heading stays put, so a finger sliding
      // across the anchor cannot flip the pet around.
      if (mag > 14 && !this.reverses(dx, -dy, mag)) {
        x = dx;
        y = -dy;
        steering = true;
      } else if (this.steering) {
        hold = true;
        steering = true;
      }
    } else if (this.fine && this.mouseValid && !this.keysOnly) {
      const p = this.playerScreen();
      if (p) {
        const dx = this.mouseX - p.x;
        const dy = this.mouseY - p.y;
        x = dx;
        y = -dy;
        if (dx * dx + dy * dy > 16) steering = true;
      }
    }
    if (steering && !hold) {
      this.desiredX = x;
      this.desiredY = y;
    }
    if (steering) {
      this.steering = true;
    } else if (!this.active) {
      this.steering = false;
    }
  }

  /** A short drag through the anchor must not spin the target 180 degrees. */
  private reverses(x: number, y: number, mag: number): boolean {
    const prev = Math.hypot(this.desiredX, this.desiredY);
    if (prev < 0.2 || mag >= 32) return false;
    const dot = (this.desiredX / prev) * (x / mag) + (this.desiredY / prev) * (y / mag);
    return dot < -0.35;
  }

  /** Knob sits along the drag, which is the world direction (screen up = north). */
  private placeStick(): void {
    const stick = this.stickEl;
    const knob = this.knobEl;
    if (!stick || !knob) return;
    if (!this.active) {
      stick.hidden = true;
      return;
    }
    stick.hidden = false;
    stick.style.left = `${this.originX}px`;
    stick.style.top = `${this.originY}px`;
    let dx = this.lastX - this.originX;
    let dy = this.lastY - this.originY;
    const mag = Math.hypot(dx, dy);
    const cap = 34;
    if (mag > cap) {
      dx = (dx / mag) * cap;
      dy = (dy / mag) * cap;
    }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
  }
}
