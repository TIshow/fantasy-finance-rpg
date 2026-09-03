# Repository instructions for coding agents

## Mission

Build GUILD MARKET as one prediction game that supports live events, schools, families, and solo play. The invariant loop is:

`read information -> forecast -> trade -> observe -> revise -> reflect`

Do not turn it into a kingdom-management game, construction game, combat RPG, or feature-heavy finance simulator.

## Start every session here

1. Read `docs/STATUS.md` for the current phase, completed work, and next action.
2. Read `docs/PROJECT_CHARTER.md` for product intent and boundaries.
3. Read the specification relevant to the requested work.
4. Check `docs/DECISIONS.md` before changing an accepted decision.
5. Inspect git status and preserve unrelated user changes.

Do not treat chat history, agent memory, or an old plan as the source of truth when the repository documents say otherwise.

## Sources of truth

- Product purpose and scope: `docs/PROJECT_CHARTER.md`
- Business and rollout hypotheses: `docs/PRODUCT_STRATEGY.md`
- Rules and player experience: `docs/GAME_DESIGN.md`
- Proposal demo scope: `docs/PROTOTYPE_SPEC.md`
- Event product requirements: `docs/EVENT_MVP_PRD.md`
- System boundaries and state model: `docs/ARCHITECTURE.md`
- Metrics and data policy: `docs/DATA_AND_EVALUATION.md`
- AI/human collaboration workflow: `docs/AI_WORKFLOW.md`
- Accepted and proposed decisions: `docs/DECISIONS.md`
- Current work and handoff: `docs/STATUS.md`

If two documents conflict, stop and reconcile them. Prefer the more specific document only when it is newer and the change is recorded in `docs/DECISIONS.md`.

## Phase gate

Follow the phase recorded in `docs/STATUS.md`. On 2026-09-03 the owner explicitly started implementation of the proposal prototype. The current implementation scope is the dependency-free single HTML in `prototype/` plus its verification script and supporting documentation.

Do not add frameworks, packages, `node_modules`, cloud resources, external runtime assets, or CI workflows for the proposal prototype. Event-MVP application code remains gated on its separate technical decisions.

## Working agreements

- Make the smallest coherent change that satisfies the task.
- Do not invent missing product requirements. Record material uncertainty under `docs/DECISIONS.md` and surface it.
- Keep core rules independent from scenario content.
- Treat live-event operation and solo auto-play as two modes of the same product.
- Keep the market usable with one player; multiplayer participation must enhance the experience, not be required for basic functionality.
- Keep production event outcomes fixed by reviewed scenario data. Trades must not change which guild succeeds.
- Do not use runtime generative AI in the initial event MVP. AI reports are reviewed scenario content.
- Prefer configuration and explicit state transitions over hidden timing or UI-only state.
- Preserve an operator override and an auditable log for event-critical actions.
- Never commit secrets, credentials, production data, or personally identifiable child/parent data.
- Minimize data collection. Use pseudonymous event/team identifiers by default.
- Do not add a dependency, hosted service, or paid integration without documenting its purpose, cost model, and exit path.

## Documentation discipline

- Update the relevant specification when behavior changes.
- Add or amend an entry in `docs/DECISIONS.md` for consequential product or architecture decisions.
- Update `docs/STATUS.md` after a substantive completed change, before handing work to another person or agent.
- Mark assumptions and proposals explicitly; do not present them as accepted decisions.
- Link instead of copying long passages between documents.
- Keep this file concise and stable. Put detailed reference material in `docs/`.

## Implementation and verification

The proposal prototype needs no setup, install, server, or build. Open `prototype/guild-market-demo.html` directly in a browser. Its canonical automated check is:

```sh
node scripts/verify-prototype.mjs
```

This checks JavaScript syntax, offline constraints, core state transitions, market-price invariants, order guards, investigation-ticket behavior, settlement, and reload recovery. PC/mobile visual checks and the complete `file://` playthrough remain manual checks in `docs/PROTOTYPE_SPEC.md`.

The event-MVP technology choices and commands are intentionally undecided.

When code exists:

- write or update tests with behavior changes;
- run the smallest relevant checks first, then the required project checks;
- make server-authoritative checks for orders, balances, market state, and settlement;
- design reconnect and duplicate-order behavior explicitly;
- test participant, operator, and venue-screen state synchronization;
- report checks that could not be run.

## Git and review

- Use short-lived branches and focused pull requests after the initial repository bootstrap.
- Keep commits scoped and explain why the change exists.
- Do not rewrite shared history or delete material data without explicit approval.
- A change is not complete until code, tests, relevant docs, and `docs/STATUS.md` agree.

## Code review rules

- Flag any path that accepts an order after the market is frozen.
- Flag non-idempotent order submission or settlement.
- Flag client-authoritative balances, prices, permissions, or event state.
- Flag collection or logging of unnecessary child/parent personal data.
- Flag runtime AI-generated event facts that can change the reviewed scenario outcome.
- Flag coupling of scenario text/assets to market-engine code.
- Flag changes that make multiplayer participation mandatory for solo play.
