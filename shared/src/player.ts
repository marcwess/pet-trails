export type DeathReason = 'trail' | 'self' | 'headon' | 'enclosed' | 'border';

export class Player {
  readonly id: number;
  active = false;
  bot = false;
  alive = false;
  name = '';
  pet = 0;
  x = 0;
  y = 0;
  heading = 0;
  desiredX = 1;
  desiredY = 0;
  lastSeq = 0;
  land = 0;
  kills = 0;
  coins = 0;
  xp = 0;
  outside = false;
  trail: Int32Array;
  trailLen = 0;
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
  /** Test hook: skip movement for this player. */
  frozen = false;

  constructor(id: number, maxTrail: number, maxTrain: number) {
    this.id = id;
    this.trail = new Int32Array(maxTrail);
    this.train = new Uint8Array(maxTrain);
  }

  resetRun(): void {
    this.alive = false;
    this.kills = 0;
    this.coins = 0;
    this.xp = 0;
    this.outside = false;
    this.trailLen = 0;
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
  }
}
