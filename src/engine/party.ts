import type { NID } from '../data/types';
import type { ItemObject } from '../objects/item';

/**
 * Runtime party object holding shared resources (money, convoy, BEXP).
 * Mirrors Python's PartyObject from app/engine/objects/party.py.
 */
export class PartyObject {
  nid: NID;
  name: string;
  leaderNid: NID;
  money: number;
  convoy: ItemObject[];
  bexp: number;

  constructor(nid: NID, name: string, leaderNid: NID, money: number = 0, bexp: number = 0) {
    this.nid = nid;
    this.name = name;
    this.leaderNid = leaderNid;
    this.money = money;
    this.convoy = [];
    this.bexp = bexp;
  }

  /** Alias: party.items returns the convoy (matching Python's property). */
  get items(): ItemObject[] {
    return this.convoy;
  }
}
