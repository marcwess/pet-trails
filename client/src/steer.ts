/**
 * Touch steering state machine. Screen-right is +x and screen-up is +y
 * (the caller flips y into world +Y). A second finger never steals the
 * stick. The anchor slides once the drag leaves the radius, so a finger
 * pinned to the screen edge can still reverse.
 */
export const STEER_RADIUS = 54;
export const STEER_DEAD = 12;

export interface SteerSample {
  active: boolean;
  steering: boolean;
  /** Finger id that owns the stick, or -1. */
  pointerId: number;
  originX: number;
  originY: number;
  x: number;
  y: number;
  /** World axes: +x east, +y north. */
  dirX: number;
  dirY: number;
  touches: number;
}

interface Finger {
  x: number;
  y: number;
  /** Buttons, inputs, and links. They must not steer. */
  control: boolean;
}

export class Steer {
  private readonly fingers = new Map<number, Finger>();
  private pointerId = -1;
  private originX = 0;
  private originY = 0;
  private x = 0;
  private y = 0;
  private active = false;
  private dirX = 0;
  private dirY = 0;
  private steering = false;

  down(id: number, x: number, y: number, control: boolean): void {
    this.fingers.set(id, { x, y, control });
    if (control) return;
    if (this.active) return;
    this.capture(id, x, y);
  }

  move(id: number, x: number, y: number): void {
    const finger = this.fingers.get(id);
    if (finger) {
      finger.x = x;
      finger.y = y;
    }
    if (!this.active || id !== this.pointerId) return;
    this.x = x;
    this.y = y;
    this.slideAnchor();
    this.aim();
  }

  up(id: number): void {
    this.fingers.delete(id);
    if (id !== this.pointerId) return;
    this.release();
  }

  /**
   * The browser took the gesture (scroll, palm, the ability button).
   * If that finger is gone, adopt another finger that is still down on
   * the playfield so steering does not die until a fresh tap.
   */
  cancel(id: number): void {
    this.fingers.delete(id);
    if (id !== this.pointerId) return;
    const next = this.spareFinger();
    if (next) {
      this.capture(next.id, next.finger.x, next.finger.y);
      return;
    }
    this.release();
  }

  /** Every finger left (touchcancel with an empty list, or blur). */
  cancelAll(): void {
    this.fingers.clear();
    this.release();
  }

  /**
   * Address-bar and visualViewport resizes must not drop the finger.
   * Client coordinates stay valid across that resize.
   */
  noteViewport(): void {
    /* intentional no-op */
  }

  sample(): SteerSample {
    return {
      active: this.active,
      steering: this.steering,
      pointerId: this.pointerId,
      originX: this.originX,
      originY: this.originY,
      x: this.x,
      y: this.y,
      dirX: this.dirX,
      dirY: this.dirY,
      touches: this.fingers.size,
    };
  }

  private capture(id: number, x: number, y: number): void {
    this.active = true;
    this.pointerId = id;
    this.originX = x;
    this.originY = y;
    this.x = x;
    this.y = y;
    this.aim();
  }

  private release(): void {
    this.active = false;
    this.pointerId = -1;
    this.steering = false;
  }

  private spareFinger(): { id: number; finger: Finger } | null {
    for (const [id, finger] of this.fingers) {
      if (!finger.control) return { id, finger };
    }
    return null;
  }

  /** Keep the knob inside the radius by sliding the anchor toward the finger. */
  private slideAnchor(): void {
    const dx = this.x - this.originX;
    const dy = this.y - this.originY;
    const mag = Math.hypot(dx, dy);
    if (mag <= STEER_RADIUS || mag < 1e-4) return;
    const k = (mag - STEER_RADIUS) / mag;
    this.originX += dx * k;
    this.originY += dy * k;
  }

  private aim(): void {
    const dx = this.x - this.originX;
    const dy = this.y - this.originY;
    const mag = Math.hypot(dx, dy);
    if (mag <= STEER_DEAD) {
      if (this.dirX !== 0 || this.dirY !== 0) this.steering = true;
      return;
    }
    this.dirX = dx / mag;
    this.dirY = -dy / mag;
    this.steering = true;
  }
}
