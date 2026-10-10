import {
  ABILITY_BLURB,
  ABILITY_ICON,
  ABILITY_LABEL,
  CONFIG,
  RARITY_COLOR,
  SPECIES,
  SPECIES_LABEL,
  buyBox,
  equippedPet,
  kitOf,
  levelPower,
  openBox,
  unlockNames,
  type PetInstance,
  type Profile,
} from '@pet-trails/shared';
import { mulberry32, randomSeed } from '@pet-trails/shared';
import { sfx } from './sfx.js';

export interface CollectionHost {
  save(): void;
  preview(species: number | null): void;
  line(): void;
  portrait(species: number): string;
}

/** Pets and Boxes screens. The profile stays in localStorage. */
export class Collection {
  private timers: number[] = [];

  constructor(
    private readonly profile: Profile,
    private readonly host: CollectionHost,
  ) {
    must('open-pets').addEventListener('click', () => this.showPets());
    must('open-boxes').addEventListener('click', () => this.showBoxes());
    must('pets-back').addEventListener('click', () => this.close());
    must('boxes-back').addEventListener('click', () => this.close());
    must('box-go').addEventListener('click', () => this.buyAndOpen());
    must('reveal').addEventListener('click', () => {
      if (must('reveal').dataset.phase === 'reveal') this.finishReveal();
    });
  }

  showPets(): void {
    this.closeReveal();
    must('boxes').hidden = true;
    must('title').hidden = true;
    const root = must('pets');
    root.hidden = false;
    root.classList.remove('detailing');
    must('pet-detail').hidden = true;
    must('pet-grid').hidden = false;
    this.paintGrid();
    this.host.preview(null);
  }

  showBoxes(): void {
    this.closeReveal();
    must('pets').hidden = true;
    must('title').hidden = true;
    must('boxes').hidden = false;
    this.paintBoxes();
    this.host.preview(null);
  }

  phase(): string {
    const reveal = must('reveal');
    if (!reveal.hidden && reveal.dataset.phase) return reveal.dataset.phase;
    if (!must('pets').hidden) return must('pet-detail').hidden ? 'pets' : 'detail';
    if (!must('boxes').hidden) return 'boxes';
    return '';
  }

  private close(): void {
    must('pets').hidden = true;
    must('boxes').hidden = true;
    must('title').hidden = false;
    this.host.preview(null);
    this.host.line();
  }

  private paintGrid(): void {
    const grid = must('pet-grid');
    grid.replaceChildren();
    const equipped = equippedPet(this.profile).instanceId;
    for (const pet of this.profile.pets) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'pcard' + (pet.rarity === 'legendary' ? ' legendary' : '') + (pet.instanceId === equipped ? ' on' : '');
      card.style.borderColor = RARITY_COLOR[pet.rarity];
      const species = SPECIES[pet.species] ?? 'cat';
      const portrait = this.host.portrait(pet.species);
      card.classList.add(`rarity-${pet.rarity}`);
      card.innerHTML =
        `<span class="portrait-wrap">` +
        (portrait ? `<img class="portrait" alt="" src="${portrait}" />` : `<i class="portrait"></i>`) +
        `<span class="lv-badge">${pet.level}</span>` +
        `</span>` +
        `<b>${SPECIES_LABEL[species]}</b>` +
        `<span class="rare-name">${label(pet.rarity)}</span>`;
      card.addEventListener('click', () => this.showDetail(pet));
      grid.appendChild(card);
    }
  }

  private showDetail(pet: PetInstance): void {
    must('pet-grid').hidden = true;
    must('pet-detail').hidden = false;
    must('pets').classList.add('detailing');
    this.host.preview(pet.species);
    const sheet = must('pet-sheet');
    const species = SPECIES[pet.species] ?? 'cat';
    sheet.replaceChildren();
    const title = document.createElement('h3');
    title.textContent = SPECIES_LABEL[species];
    const rare = document.createElement('p');
    rare.className = 'rare-name';
    rare.textContent = `${label(pet.rarity)} · Lv ${pet.level}`;
    rare.style.color = RARITY_COLOR[pet.rarity];
    const blurb = document.createElement('p');
    blurb.className = 'blurb';
    const active = pet.actives[pet.equippedActive];
    const passive = pet.passives[pet.equippedPassive];
    blurb.textContent = `${ABILITY_BLURB[active]} ${ABILITY_BLURB[passive]}`;
    const boost = document.createElement('p');
    boost.className = 'boost';
    const pct = Math.round((levelPower(pet.level) - 1) * 100);
    boost.textContent = pct > 0 ? `Abilities +${pct}%` : 'Abilities +0%';
    const next = document.createElement('p');
    next.className = 'next-line';
    const names = unlockNames(pet.level);
    next.textContent = names.length > 0 ? names.join(' · ') : 'Next: Sparkle at 3';
    sheet.append(title, rare, boost, next, blurb, this.pairRow(pet, 'active'), this.pairRow(pet, 'passive'));
    const equip = document.createElement('button');
    equip.type = 'button';
    equip.className = 'btn';
    equip.textContent = pet.instanceId === this.profile.equippedId ? 'Equipped' : 'Equip';
    equip.addEventListener('click', () => {
      this.profile.equippedId = pet.instanceId;
      this.host.save();
      this.host.line();
      equip.textContent = 'Equipped';
    });
    sheet.appendChild(equip);
  }

  private pairRow(pet: PetInstance, kind: 'active' | 'passive'): HTMLElement {
    const row = document.createElement('div');
    row.className = 'kit-row';
    const ids = kind === 'active' ? pet.actives : pet.passives;
    ids.forEach((id, index) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = `${ABILITY_ICON[id]} ${ABILITY_LABEL[id]}`;
      const on = kind === 'active' ? pet.equippedActive === index : pet.equippedPassive === index;
      if (on) btn.classList.add('on');
      btn.addEventListener('click', () => {
        if (kind === 'active') pet.equippedActive = index === 1 ? 1 : 0;
        else pet.equippedPassive = index === 1 ? 1 : 0;
        this.host.save();
        this.showDetail(pet);
      });
      row.appendChild(btn);
    });
    return row;
  }

  private paintBoxes(): void {
    must('box-coins').textContent = `${Math.floor(this.profile.coins)} coins`;
    const go = must('box-go') as HTMLButtonElement;
    const n = this.profile.freeBoxes;
    if (n > 0) {
      go.textContent = n > 1 ? `Open · ${n}` : 'Open';
      go.disabled = false;
    } else {
      go.textContent = `Open · ${CONFIG.boxPrice}`;
      go.disabled = this.profile.coins < CONFIG.boxPrice;
    }
  }

  private buyAndOpen(): void {
    if (this.profile.freeBoxes <= 0 && !buyBox(this.profile)) return;
    this.host.save();
    this.open();
  }

  private open(): void {
    if (this.profile.freeBoxes <= 0) return;
    const pet = openBox(this.profile, mulberry32(randomSeed()));
    if (!pet) return;
    sfx.open();
    this.host.save();
    this.paintBoxes();
    this.playReveal(pet);
  }

  private playReveal(pet: PetInstance): void {
    this.clearTimers();
    const root = must('reveal');
    const card = must('reveal-card');
    card.hidden = true;
    root.hidden = false;
    root.dataset.phase = 'shake';
    const flash = must('reveal-flash');
    flash.style.background = RARITY_COLOR[pet.rarity];
    // Keep the shop panel and the new pet out of view until the box bursts.
    must('boxes').hidden = true;
    this.timers.push(window.setTimeout(() => {
      root.dataset.phase = 'burst';
      this.host.preview(pet.species);
    }, 700));
    this.timers.push(window.setTimeout(() => {
      root.dataset.phase = 'reveal';
      this.fillCard(pet);
      card.hidden = false;
    }, 1150));
  }

  private fillCard(pet: PetInstance): void {
    const card = must('reveal-card');
    const species = SPECIES[pet.species] ?? 'cat';
    card.className = 'reveal-card' + (pet.rarity === 'legendary' ? ' legendary' : '');
    card.style.borderColor = RARITY_COLOR[pet.rarity];
    const kit = kitOf(pet);
    card.innerHTML =
      `<p class="rare-pill" style="background:${RARITY_COLOR[pet.rarity]}">${label(pet.rarity)}</p>` +
      `<h3>${SPECIES_LABEL[species]}</h3>` +
      `<p class="rare-name">Lv ${pet.level}</p>` +
      `<p class="kit">${ABILITY_ICON[kit.actives[0]]} ${ABILITY_LABEL[kit.actives[0]]} · ${ABILITY_ICON[kit.actives[1]]} ${ABILITY_LABEL[kit.actives[1]]}</p>` +
      `<p class="kit">${ABILITY_ICON[kit.passives[0]]} ${ABILITY_LABEL[kit.passives[0]]} · ${ABILITY_ICON[kit.passives[1]]} ${ABILITY_LABEL[kit.passives[1]]}</p>` +
      `<p class="tap">Tap to keep</p>`;
  }

  private finishReveal(): void {
    this.closeReveal();
    this.showPets();
    const pet = this.profile.pets[this.profile.pets.length - 1];
    if (pet) this.showDetail(pet);
  }

  private closeReveal(): void {
    this.clearTimers();
    const root = must('reveal');
    root.hidden = true;
    root.dataset.phase = '';
    must('reveal-card').hidden = true;
  }

  private clearTimers(): void {
    for (const id of this.timers) window.clearTimeout(id);
    this.timers = [];
  }
}

function label(rarity: string): string {
  return rarity.charAt(0).toUpperCase() + rarity.slice(1);
}

function must(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
}
