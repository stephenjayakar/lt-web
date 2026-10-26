/**
 * engine-flavor.ts — which Lex Talionis engine a project was authored on.
 *
 * The web port follows upstream lt-maker (`lt-maker/`, 2026.02.17a), but
 * Embrace of the Fog ships on a private fork that branched from upstream in
 * early 2024 (its v1.90 build's source is the reference; see
 * docs/parity/PARITY-REPORT.md "EOtF engine-version notes"). Where the fork
 * and upstream disagree in a way that is specific to the fork's own engine
 * (combat cleanup order, engine sprites), the web checks this flag and
 * follows the fork for that project only.
 */

/** Project metadata.json (both the pre-2024-09 and the current format). */
export interface ProjectMetadata {
  project?: string;
  version?: string;
  engine_version?: string;
}

let forkEngine = false;

/** Whether a project's metadata names Embrace of the Fog, which runs on the fork. */
export function metadataUsesForkEngine(metadata: ProjectMetadata | null | undefined): boolean {
  return metadata?.project === 'EotF';
}

/** Set at boot from the loaded project's metadata (tests may toggle it). */
export function setForkEngine(enabled: boolean): void {
  forkEngine = enabled;
}

/** True when the loaded project runs on EOtF's engine fork. */
export function isForkEngine(): boolean {
  return forkEngine;
}
