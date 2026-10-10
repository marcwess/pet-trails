import { Steer, type SteerSample } from './steer.js';

const CONTROL = 'button, a, input, textarea, select, label';

/**
 * Window-level steering. Touch fingers go through TouchEvents so a second
 * finger (the ability button) cannot replace the stick's identifier.
 * Pointer events cover the mouse. Listeners are non-passive so preventDefault
 * can stop double-tap zoom and the iOS back-swipe.
 */
export class Input {
  desiredX = 0;
  desiredY = 0;
  steering = false;
  readonly steer = new Steer();
  private readonly keys = new Set<string>();
  private mouseX = 0;
  private mouseY = 0;
  private mouseValid = false;
  private mouseDown = false;
  private readonly fine = window.matchMedia('(pointer: fine)').matches;
  private readonly keysOnly = new URLSearchParams(location.search).has('keys');
  private sawTouch = false;

  constructor(private readonly playerScreen: () => { x: number; y: number } | null) {
    const opts: AddEventListenerOptions = { passive: false, capture: true };
    window.addEventListener('touchstart', this.onTouchStart, opts);
    window.addEventListener('touchmove', this.onTouchMove, opts);
    window.addEventListener('touchend', this.onTouchEnd, opts);
    window.addEventListener('touchcancel', this.onTouchCancel, opts);
    window.addEventListener('pointerdown', this.onPointerDown, opts);
    window.addEventListener('pointermove', this.onPointerMove, opts);
    window.addEventListener('pointerup', this.onPointerUp, opts);
    window.addEventListener('pointercancel', this.onPointerCancel, opts);
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', () => {
      this.steer.cancelAll();
      this.mouseDown = false;
      this.keys.clear();
    });
    window.addEventListener('contextmenu', (e) => e.preventDefault());
    const vv = window.visualViewport;
    vv?.addEventListener('resize', () => this.steer.noteViewport());
    window.addEventListener('resize', () => this.steer.noteViewport());
  }

  /** Promote a finger that is still down, including the Play thumb. */
  claimHeld(): void {
    this.steer.claimHeld();
  }

  /** Anchor and drag, for the on-screen ring. */
  stick(): { x: number; y: number; dx: number; dy: number; on: boolean } {
    const s = this.steer.sample();
    return { x: s.originX, y: s.originY, dx: s.x - s.originX, dy: s.y - s.originY, on: s.active };
  }

  debug(): SteerSample & { mouse: boolean; keys: number } {
    const s = this.steer.sample();
    return { ...s, mouse: this.mouseDown, keys: this.keys.size };
  }

  private onTouchStart = (ev: TouchEvent) => {
    this.sawTouch = true;
    if (!isControl(ev.target)) ev.preventDefault();
    for (const t of Array.from(ev.changedTouches)) {
      this.steer.down(t.identifier, t.clientX, t.clientY, isControl(t.target));
    }
  };

  private onTouchMove = (ev: TouchEvent) => {
    if (!isControl(ev.target)) ev.preventDefault();
    for (const t of Array.from(ev.changedTouches)) this.steer.move(t.identifier, t.clientX, t.clientY);
  };

  private onTouchEnd = (ev: TouchEvent) => {
    if (!isControl(ev.target)) ev.preventDefault();
    for (const t of Array.from(ev.changedTouches)) this.steer.up(t.identifier);
    if (ev.touches.length === 0 && !this.steer.sample().active) this.steer.cancelAll();
  };

  private onTouchCancel = (ev: TouchEvent) => {
    ev.preventDefault();
    if (ev.touches.length === 0) {
      this.steer.cancelAll();
      return;
    }
    for (const t of Array.from(ev.changedTouches)) this.steer.cancel(t.identifier);
  };

  private onPointerDown = (ev: PointerEvent) => {
    if (ev.pointerType === 'touch' || this.sawTouch) return;
    if (isControl(ev.target)) {
      this.steer.down(ev.pointerId, ev.clientX, ev.clientY, true);
      return;
    }
    ev.preventDefault();
    this.mouseDown = true;
    this.mouseX = ev.clientX;
    this.mouseY = ev.clientY;
    this.mouseValid = true;
    this.steer.down(ev.pointerId, ev.clientX, ev.clientY, false);
  };

  private onPointerMove = (ev: PointerEvent) => {
    this.mouseX = ev.clientX;
    this.mouseY = ev.clientY;
    this.mouseValid = true;
    if (ev.pointerType === 'touch' || this.sawTouch) return;
    this.steer.move(ev.pointerId, ev.clientX, ev.clientY);
    if (!this.mouseDown) return;
    ev.preventDefault();
  };

  private onPointerUp = (ev: PointerEvent) => {
    if (ev.pointerType === 'touch' || this.sawTouch) return;
    this.mouseDown = false;
    this.steer.up(ev.pointerId);
  };

  private onPointerCancel = (ev: PointerEvent) => {
    if (ev.pointerType === 'touch' || this.sawTouch) return;
    this.mouseDown = false;
    this.steer.cancel(ev.pointerId);
  };

  private onKey = (ev: KeyboardEvent) => {
    if (isControl(ev.target)) return;
    this.keys.add(ev.key.toLowerCase());
  };

  private onKeyUp = (ev: KeyboardEvent) => {
    this.keys.delete(ev.key.toLowerCase());
  };

  /**
   * Absolute stick. Screen up is world +Y and screen right is world +X.
   * Keys use those axes. A fine pointer with no finger aims from the pet.
   */
  sample(): void {
    const stick = this.steer.sample();
    let x = 0;
    let y = 0;
    let steering = false;
    const w = this.keys.has('w') || this.keys.has('arrowup');
    const a = this.keys.has('a') || this.keys.has('arrowleft');
    const s = this.keys.has('s') || this.keys.has('arrowdown');
    const d = this.keys.has('d') || this.keys.has('arrowright');
    if (w || a || s || d) {
      x = (d ? 1 : 0) - (a ? 1 : 0);
      y = (w ? 1 : 0) - (s ? 1 : 0);
      steering = true;
    } else if (stick.active && stick.steering) {
      x = stick.dirX;
      y = stick.dirY;
      steering = true;
    } else if (!stick.active && this.fine && this.mouseValid && !this.mouseDown && !this.keysOnly && !this.sawTouch) {
      const p = this.playerScreen();
      if (p) {
        const dx = this.mouseX - p.x;
        const dy = this.mouseY - p.y;
        x = dx;
        y = -dy;
        if (dx * dx + dy * dy > 16) steering = true;
      }
    }
    if (steering && (x !== 0 || y !== 0)) {
      this.desiredX = x;
      this.desiredY = y;
      this.steering = true;
    } else if (!stick.active && !this.mouseDown) {
      this.steering = false;
    } else if (stick.active) {
      this.steering = true;
    }
  }
}

function isControl(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest(CONTROL);
}
