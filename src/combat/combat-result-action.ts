import { Action } from '../engine/action';
import type { ItemObject } from '../objects/item';
import type { SkillObject } from '../objects/skill';
import type { StatusEffect, UnitObject } from '../objects/unit';

interface UnitMutationSnapshot {
  currentHp: number;
  dead: boolean;
  currentFatigue: number;
  exp: number;
  level: number;
  stats: Record<string, number>;
  growthPoints: Record<string, number>;
  wexp: Record<string, number>;
  fields: Map<string, any>;
  skills: SkillObject[];
  statusEffects: StatusEffect[];
  items: ItemObject[];
  hasCanto: boolean;
  currentGuardGauge: number;
  builtGuard: boolean;
  strikePartner: UnitObject | null;
}

interface ItemMutationSnapshot {
  uses: number;
  maxUses: number;
  droppable: boolean;
  owner: UnitObject | null;
  data: Map<string, any>;
}

interface CombatMutationSnapshot {
  units: Map<UnitObject, UnitMutationSnapshot>;
  items: Map<ItemObject, ItemMutationSnapshot>;
}

function copyStatusEffects(statuses: StatusEffect[]): StatusEffect[] {
  return statuses.map((status) => ({
    ...status,
    statMods: { ...status.statMods },
  }));
}

function capture(units: UnitObject[], explicitItems: ItemObject[]): CombatMutationSnapshot {
  const uniqueUnits = [...new Set(units)];
  const allItems = new Set<ItemObject>(explicitItems);
  for (const unit of uniqueUnits) {
    for (const item of unit.items) allItems.add(item);
  }
  return {
    units: new Map(uniqueUnits.map((unit) => [unit, {
      currentHp: unit.currentHp,
      dead: unit.dead,
      currentFatigue: unit.currentFatigue,
      exp: unit.exp,
      level: unit.level,
      stats: { ...unit.stats },
      growthPoints: { ...unit.growthPoints },
      wexp: { ...unit.wexp },
      fields: new Map(unit.fields),
      skills: [...unit.skills],
      statusEffects: copyStatusEffects(unit.statusEffects),
      items: [...unit.items],
      hasCanto: unit.hasCanto,
      currentGuardGauge: unit.getGuardGauge(),
      builtGuard: unit.builtGuard,
      strikePartner: unit.strikePartner,
    }])),
    items: new Map([...allItems].map((item) => [item, {
      uses: item.uses,
      maxUses: item.maxUses,
      droppable: item.droppable,
      owner: item.owner,
      data: new Map(item.data),
    }])),
  };
}

function restore(snapshot: CombatMutationSnapshot): void {
  for (const [unit, state] of snapshot.units) {
    unit.currentHp = state.currentHp;
    unit.dead = state.dead;
    unit.currentFatigue = state.currentFatigue;
    unit.exp = state.exp;
    unit.level = state.level;
    unit.stats = { ...state.stats };
    unit.growthPoints = { ...state.growthPoints };
    unit.wexp = { ...state.wexp };
    unit.fields = new Map(state.fields);
    unit.skills = [...state.skills];
    unit.statusEffects = copyStatusEffects(state.statusEffects);
    unit.items = [...state.items];
    unit.hasCanto = state.hasCanto;
    unit.currentGuardGauge = state.currentGuardGauge;
    unit.builtGuard = state.builtGuard;
    unit.strikePartner = state.strikePartner;
  }
  for (const [item, state] of snapshot.items) {
    item.uses = state.uses;
    item.maxUses = state.maxUses;
    item.droppable = state.droppable;
    item.owner = state.owner;
    item.data.clear();
    for (const [key, value] of state.data) item.data.set(key, value);
  }
}

/**
 * Records the complete mechanical result of one combat as one turnwheel action.
 * The first execution resolves combat normally and captures its after-state;
 * redo restores that exact state without rerolling level gains or hooks.
 */
export class CombatResultAction<Result> extends Action {
  private units: UnitObject[];
  private items: ItemObject[];
  private resolve: () => Result;
  private before: CombatMutationSnapshot | null = null;
  private after: CombatMutationSnapshot | null = null;
  private result: Result | null = null;

  constructor(units: UnitObject[], items: ItemObject[], resolve: () => Result) {
    super();
    this.units = [...new Set(units)];
    this.items = [...new Set(items)];
    this.resolve = resolve;
  }

  execute(): void {
    if (this.after) {
      restore(this.after);
      return;
    }
    this.before = capture(this.units, this.items);
    this.result = this.resolve();
    this.after = capture(this.units, this.items);
  }

  reverse(): void {
    if (this.before) restore(this.before);
  }

  getResult(): Result {
    if (this.result === null) throw new Error('CombatResultAction has not executed');
    return this.result;
  }
}
