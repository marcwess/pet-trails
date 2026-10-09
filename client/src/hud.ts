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
  rows: Array<{ k: string; v: string; up?: boolean }>;
}

const REASONS: Record<DeathReason, string> = {
  trail: 'Your trail was cut!',
  headon: 'Head-on collision!',
  enclosed: 'You got surrounded!',
};

export function deathTitle(reason: string): string {
  return REASONS[reason as DeathReason] ?? 'Run over';
}

export class Hud {
  private readonly chip = must('chip');
  private readonly title = must('title');
  private readonly hud = must('hud');
  private readonly death = must('death');
  private readonly dim = must('dim');
  private readonly deathTitleEl = must('death-title');
  private readonly deathStats = must('death-stats');
  private readonly deathRows: HTMLLIElement[] = [];
  private readonly deathKeys: HTMLSpanElement[] = [];
  private readonly deathVals: HTMLSpanElement[] = [];
  private readonly petline = must('petline');
  private readonly playBtn = must('play') as HTMLButtonElement;
  private readonly againBtn = must('again') as HTMLButtonElement;
  private readonly steer = must('steer');
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
      row.innerHTML = '<i class="swatch"></i><span class="name"></span><span class="pct"></span>';
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
      const k = document.createElement('span');
      const v = document.createElement('span');
      li.append(k, v);
      li.hidden = true;
      this.deathStats.appendChild(li);
      this.deathRows.push(li);
      this.deathKeys.push(k);
      this.deathVals.push(v);
    }
    const labels = must('labels');
    for (let i = 0; i < 16; i++) {
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
    if (mode === 'online') {
      this.chip.textContent = 'Online';
      this.chip.classList.add('online');
    } else if (mode === 'offline') {
      this.chip.textContent = 'Offline';
      this.chip.classList.add('offline');
    } else {
      this.chip.textContent = 'Connecting…';
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

  showDeath(view: DeathView | null): void {
    if (!view) {
      this.death.hidden = true;
      this.dim.hidden = true;
      return;
    }
    this.death.hidden = false;
    this.dim.hidden = false;
    this.deathTitleEl.textContent = view.title;
    for (let i = 0; i < this.deathRows.length; i++) {
      const row = view.rows[i];
      const li = this.deathRows[i]!;
      if (!row) {
        li.hidden = true;
        continue;
      }
      li.hidden = false;
      li.className = row.up ? 'up' : '';
      this.deathKeys[i]!.textContent = row.k;
      this.deathVals[i]!.textContent = row.v;
    }
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
      const sw = el.querySelector('.swatch') as HTMLElement;
      const name = el.querySelector('.name') as HTMLElement;
      const pct = el.querySelector('.pct') as HTMLElement;
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

  setYou(pct: string, kills: number): void {
    const pctEl = document.getElementById('you-pct');
    const killsEl = document.getElementById('you-kills');
    if (pctEl) pctEl.textContent = pct;
    if (killsEl) killsEl.textContent = kills === 1 ? '1 kill' : `${kills} kills`;
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

  setLabels(items: Array<{ sx: number; sy: number; text: string; on: boolean }>): void {
    for (let i = 0; i < this.labels.length; i++) {
      const el = this.labels[i]!;
      const item = items[i];
      if (!item || !item.on) {
        el.style.display = 'none';
        continue;
      }
      el.style.display = 'block';
      el.style.left = `${item.sx}px`;
      el.style.top = `${item.sy}px`;
      el.textContent = item.text;
    }
  }
}

function must(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
}

export function cssColor(id: number): string {
  const c = PALETTE[(Math.max(1, id) - 1) % PALETTE.length]!;
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}
