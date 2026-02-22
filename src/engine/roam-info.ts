/**
 * RoamInfo — Simple class storing free roam mode state on the GameState.
 *
 * When `roam` is true and `roamUnitNid` is set, the FreeState redirects
 * to FreeRoamState for ARPG-style direct unit control.
 */

import type { NID } from '../data/types';

export class RoamInfo {
  roam: boolean;
  roamUnitNid: NID | null;

  constructor(roam: boolean = false, roamUnitNid: NID | null = null) {
    this.roam = roam;
    this.roamUnitNid = roamUnitNid;
  }

  clear(): void {
    this.roam = false;
    this.roamUnitNid = null;
  }
}
