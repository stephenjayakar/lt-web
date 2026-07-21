# Runtime Parity Completion-Gate Audit

The gate is not currently closable.

## Existing evidence

- 255/255 event commands are structurally parser-recognized and dispatched.
- Continuous Sacred Stones coverage exists from Prologue through Chapter 5; the checked-in project has no Chapter 6+ levels.
- Rekka and testing_proj provide non-default, non-chunked/chunked compatibility coverage.
- Broad save, turnwheel, RNG, map rendering, and project-load tests exist.
- Build, parity audit, and full-suite commands are available separately.

## Additional blockers beyond P1-P6 implementation

- Structural component/event manifests do not classify semantic parity or test evidence.
- `docs/parity/PARITY-REPORT.md` and parts of `runtime-inventory.md` are stale/conflicting.
- The soak script repeats selected harness sections, not the continuous campaign chain or project compatibility suite.
- Non-default compatibility filters broad resource errors and does not meaningfully exercise animated combat fallback.
- No single completion-gate command runs build, audits, continuous/seeded soak, compatibility, and full serial Playwright.

## Final gate work after implementation

1. Add semantic classification/test IDs and custom-project component coverage to generated inventories.
2. Reconcile the runtime inventory and published parity report from current generated evidence.
3. Expand soak to repeat the continuous Prologue-to-Chapter-5 chain and representative compatibility paths.
4. Add real non-default combat-asset fallback scenarios.
5. Add one completion-gate command and run it on the final state.

Primary surfaces: `scripts/parity-audit.mjs`, `scripts/sacred-stones-soak.mjs`, `tests/campaign-chain.spec.ts`, `tests/project-compat.spec.ts`, `tests/resource-paths.spec.ts`, and `docs/parity/`.
