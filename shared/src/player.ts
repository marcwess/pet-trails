import type { ActiveId, PassiveId, RarityName } from './config.js';

export type DeathReason = 'trail' | 'headon' | 'enclosed' | 'time';

export class Player {
  readonly id: number;
  active = false;
  bot = false;
  alive = false;
  name = '';
  pet = 0;
  level = 1;
  x = 0;
  y = 0;
  heading = 0;
  desiredX = 1;
  desiredY = 0;
  turnVel = 0;
  lastSeq = 0;
  /** Inputs waiting for the tick they were sent for. A future seq must not skip ahead. */
  inSeq: number[] = [];
  inX: number[] = [];
  inY: number[] = [];
  /** 1 when that queued packet was a real direction, 0 for a hold. */
  inReal: number[] = [];
  /** Lockstep ticks in a row with no input to apply. */
  starved = 0;
  /** Set when a real direction has been applied. Until then the pet does not wander. */
  steered = false;
  land = 0;
  kills = 0;
  coins = 0;
  xp = 0;
  outside = false;
  /** Trail polyline in cell coordinates, recorded while outside owned land. */
  trailX: Float64Array;
  trailY: Float64Array;
  trailLen = 0;
  /** Cell key for each trail sample, so a cut test only looks near the segment. */
  trailKey: Int32Array;
  trailKeyed: Uint8Array;
  readonly trailCells = new Map<number, number[]>();
  train: Uint8Array;
  trainLen = 0;
  aliveMs = 0;
  respawnTick = 0;
  /** Tick before which head-on, trail cuts, and enclosures do not kill. */
  invulnUntil = 0;
  deathReason: DeathReason | '' = '';
  deathKiller = 0;
  lastPct = 0;
  lastRank = 1;
  lastTime = 0;

  botPhase = 0;
  botDir = 0;
  botLeg = 12;
  botMoved = 0;
  botTurns = 0;
  botNextThink = 0;
  botTurnSign = 1;
  botStyle = 0;
  rarity: RarityName = 'common';
  activeId: ActiveId = 'dash';
  passiveId: PassiveId = 'swift';
  /** Tick when the active can be used again. */
  cdUntil = 0;
  dashUntil = 0;
  shieldUntil = 0;
  slowUntil = 0;
  /** Speed multiplier while slowed. */
  slowMul = 1;
  /** Test hook: skip movement for this player. */
  frozen = false;

  constructor(id: number, maxTrail: number, maxTrain: number) {
    this.id = id;
    this.trailX = new Float64Array(maxTrail);
    this.trailY = new Float64Array(maxTrail);
    this.trailKey = new Int32Array(maxTrail);
    this.trailKeyed = new Uint8Array(maxTrail);
    this.train = new Uint8Array(maxTrain);
  }

  resetRun(): void {
    this.alive = false;
    this.kills = 0;
    this.coins = 0;
    this.xp = 0;
    this.outside = false;
    this.trailLen = 0;
    this.trailCells.clear();
    this.trainLen = 0;
    this.aliveMs = 0;
    this.deathReason = '';
    this.deathKiller = 0;
    this.invulnUntil = 0;
    this.lastPct = 0;
    this.lastRank = 1;
    this.lastTime = 0;
    this.land = 0;
    this.botPhase = 0;
    this.botMoved = 0;
    this.botTurns = 0;
    this.botNextThink = 0;
    this.cdUntil = 0;
    this.dashUntil = 0;
    this.shieldUntil = 0;
    this.slowUntil = 0;
    this.slowMul = 1;
    // A recycled slot must accept the new client's first input. Stale seqs drop the stick.
    this.lastSeq = 0;
    this.inSeq.length = 0;
    this.inX.length = 0;
    this.inY.length = 0;
    this.inReal.length = 0;
    this.starved = 0;
    this.steered = false;
    this.turnVel = 0;
  }
}
