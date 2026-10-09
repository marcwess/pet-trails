import { PALETTE } from '@pet-trails/shared';
import type { DeathReason } from '@pet-trails/shared';

export interface BoardRow {
  name: string;
  pct: string;
  me: boolean;
  color: string;
  show: boolean;
}

export interface DeathView {
  title: string;
  icon: string;
  rows: Array<{ k: string; v: string; icon?: string; up?: boolean; bar?: number }>;
}

const REASONS: Record<DeathReason, { title: string; icon: string }> = {
  trail: { title: 'Your trail was cut!', icon: '✂' },
  self: { title: 'You crossed your trail!', icon: '↩' },
  headon: { title: 'Head-on collision!', icon: '💥' },
  enclosed: { title: 'You got surrounded!', icon: '◎' },
  border: { title: 'You hit the wall!', icon: '▣' },
};

export function deathTitle(reason: string): string {
  return REASONS[reason as DeathReason]?.title ?? 'Run over';
}

export function deathIcon(reason: string): string {
  return REASONS[reason as DeathReason]?.icon ?? '✖';
}

export class Hud {
  private readonly chip = must('chip');
  private readonly title = must('title');
  private readonly hud = must('hud');
  private readonly death = must('death');
  private readonly dim = must('dim');
  private readonly deathTitleEl = must('death-title');
  private readonly deathIconEl = must('death-icon');
  private readonly deathStats = must('death-stats');
  private readonly deathRows: HTMLLIElement[] = [];
  private readonly deathIcons: HTMLSpanElement[] = [];
  private readonly deathKeys: HTMLSpanElement[] = [];
  private readonly deathVals: HTMLSpanElement[] = [];
  private readonly deathBars: HTMLElement[] = [];
  private readonly petline = must('petline');
  private readonly playBtn = must('play') as HTMLButtonElement;
  private readonly againBtn = must('again') as HTMLButtonElement;
  private readonly steer = must('steer');
  private readonly stick = must('stick');
  private readonly stickKnob = must('stick-knob');
  private readonly killBannerEl = must('kill-banner');
  private readonly killName = must('kill-name');
  private readonly lb = must('lb');
  private readonly rows: HTMLDivElement[] = [];
  private readonly popups: HTMLDivElement[] = [];
  private popupCursor = 0;
  private readonly toasts: HTMLDivElement[] = [];
  private toastCursor = 0;
  private readonly labels: HTMLDivElement[] = [];

  constructor() {
    for (let i = 0; i < 6; i++) {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = '<span class="rank"></span><i class="swatch"></i><span class="name"></span><span class="pct"></span>';
      this.lb.appendChild(row);
      this.rows.push(row);
    }
    const pops = must('popups');
    for (let i = 0; i < 12; i++) {
      const el = document.createElement('div');
      el.className = 'popup';
      pops.appendChild(el);
      this.popups.push(el);
    }
    const toasts = must('toasts');
    for (let i = 0; i < 3; i++) {
      const el = document.createElement('div');
      el.className = 'toast';
      toasts.appendChild(el);
      this.toasts.push(el);
    }
    for (let i = 0; i < 8; i++) {
      const li = document.createElement('li');
      const ico = document.createElement('span');
      ico.className = 'ico';
      const k = document.createElement('span');
      const v = document.createElement('span');
      v.className = 'val';
      const bar = document.createElement('div');
      bar.className = 'xpbar';
      bar.hidden = true;
      const fill = document.createElement('i');
      bar.appendChild(fill);
      li.append(ico, k, v, bar);
      li.hidden = true;
      this.deathStats.appendChild(li);
      this.deathRows.push(li);
      this.deathIcons.push(ico);
      this.deathKeys.push(k);
      this.deathVals.push(v);
      this.deathBars.push(bar);
    }
    const labels = must('labels');
    for (let i = 0; i < 40; i++) {
      const el = document.createElement('div');
      el.className = 'plus';
      labels.appendChild(el);
      this.labels.push(el);
    }
  }

  onPlay(fn: () => void): void {
    this.playBtn.addEventListener('click', fn);
    this.againBtn.addEventListener('click', fn);
  }

  setChip(mode: 'connecting' | 'online' | 'offline'): void {
    this.chip.classList.remove('online', 'offline', 'wait');
    this.chip.textContent = '';
    if (mode === 'online') {
      this.chip.title = 'Online';
      this.chip.classList.add('online');
    } else if (mode === 'offline') {
      this.chip.title = 'Offline';
      this.chip.classList.add('offline');
    } else {
      this.chip.title = 'Connecting';
      this.chip.classList.add('wait');
    }
  }

  setPetLine(text: string): void {
    this.petline.textContent = text;
  }

  setPlayEnabled(on: boolean): void {
    this.playBtn.disabled = !on;
  }

  showTitle(on: boolean): void {
    this.title.hidden = !on;
  }

  showHud(on: boolean): void {
    this.hud.hidden = !on;
  }

  hideSteer(): void {
    this.steer.classList.add('hide');
  }

  setStick(x: number, y: number, dx: number, dy: number, on: boolean): void {
    if (!on) {
      this.stick.hidden = true;
      return;
    }
    this.stick.hidden = false;
    this.stick.style.left = `${x}px`;
    this.stick.style.top = `${y}px`;
    const mag = Math.hypot(dx, dy);
    const cap = 34;
    const k = mag > cap && mag > 0 ? cap / mag : 1;
    this.stickKnob.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
  }

  killBanner(name: string): void {
    this.killName.textContent = name;
    this.killBannerEl.classList.remove('show');
    void this.killBannerEl.offsetWidth;
    this.killBannerEl.classList.add('show');
  }

  showDeath(view: DeathView | null): void {
    if (!view) {
      this.death.hidden = true;
      this.dim.hidden = true;
      return;
    }
    this.death.hidden = false;
    this.dim.hidden = false;
    this.death.style.animation = 'none';
    this.deathTitleEl.textContent = view.title;
    this.deathIconEl.textContent = view.icon;
    for (let i = 0; i < this.deathRows.length; i++) {
      const row = view.rows[i];
      const li = this.deathRows[i]!;
      if (!row) {
        li.hidden = true;
        continue;
      }
      li.hidden = false;
      li.className = row.up ? 'up' : '';
      this.deathIcons[i]!.textContent = row.icon ?? '•';
      this.deathKeys[i]!.textContent = row.k;
      this.deathVals[i]!.textContent = row.v;
      const bar = this.deathBars[i]!;
      if (row.bar === undefined) {
        bar.hidden = true;
      } else {
        bar.hidden = false;
        const fill = bar.firstElementChild as HTMLElement;
        fill.style.animation = 'none';
        fill.style.setProperty('--xp', `${Math.round(Math.max(0, Math.min(1, row.bar)) * 100)}%`);
        void fill.offsetWidth;
        fill.style.animation = '';
      }
    }
    void this.death.offsetWidth;
    this.death.style.animation = '';
  }

  setBoard(rows: BoardRow[]): void {
    for (let i = 0; i < this.rows.length; i++) {
      const el = this.rows[i]!;
      const row = rows[i];
      if (!row || !row.show) {
        el.style.display = 'none';
        continue;
      }
      el.style.display = 'flex';
      el.classList.toggle('me', row.me);
      if (row.me) {
        el.style.background = row.color;
        el.style.color = bright(row.color) ? '#1c1408' : '#fff';
      } else {
        el.style.background = 'transparent';
        el.style.color = '';
      }
      const rank = el.querySelector('.rank') as HTMLElement;
      const sw = el.querySelector('.swatch') as HTMLElement;
      const name = el.querySelector('.name') as HTMLElement;
      const pct = el.querySelector('.pct') as HTMLElement;
      rank.textContent = String(i + 1);
      sw.style.background = row.color;
      name.textContent = row.name;
      pct.textContent = row.pct;
    }
  }

  toast(text: string): void {
    const el = this.toasts[this.toastCursor]!;
    this.toastCursor = (this.toastCursor + 1) % this.toasts.length;
    el.textContent = text;
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
  }

  setYou(pct: string, kills: number, train = 0): void {
    const pctEl = document.getElementById('you-pct');
    const killsEl = document.getElementById('you-kills');
    const trainEl = document.getElementById('you-train');
    if (pctEl) pctEl.textContent = pct;
    if (killsEl) killsEl.textContent = String(kills);
    if (trainEl) trainEl.textContent = String(train);
  }

  popup(sx: number, sy: number, text: string, kind: 'coin' | 'xp' | 'loot' | 'claim'): void {
    const el = this.popups[this.popupCursor]!;
    this.popupCursor = (this.popupCursor + 1) % this.popups.length;
    el.className = `popup ${kind}`;
    el.textContent = text;
    el.style.left = `${sx}px`;
    el.style.top = `${sy}px`;
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
  }

  setLabels(items: Array<{ sx: number; sy: number; text: string; on: boolean; name?: boolean; color?: string }>): void {
    for (let i = 0; i < this.labels.length; i++) {
      const el = this.labels[i]!;
      const item = items[i];
      if (!item || !item.on) {
        el.style.display = 'none';
        continue;
      }
      el.className = item.name ? 'tag' : 'plus';
      el.style.display = 'block';
      el.style.left = `${item.sx}px`;
      el.style.top = `${item.sy}px`;
      el.style.color = item.name ? (item.color ?? '#1c1408') : '';
      el.textContent = item.text;
    }
  }
}

function must(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
}

function bright(color: string): boolean {
  const m = color.match(/\d+/g);
  if (!m || m.length < 3) return false;
  return Number(m[0]) * 0.3 + Number(m[1]) * 0.59 + Number(m[2]) * 0.11 > 165;
}

export function cssColor(id: number): string {
  const c = PALETTE[(Math.max(1, id) - 1) % PALETTE.length]!;
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}
