# Repository instructions for coding agents

## Mission

Build GUILD MARKET as one prediction game that supports live events, schools, families, and solo play. The invariant loop is:

`read information -> forecast -> trade -> observe -> revise -> reflect`

The market is an artificial market: players trade alongside about 100 NPC merchants, and every order placed during a round clears together at the round's deadline (D-024).

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
- Market engine rules (clearing, NPC market, invariants): `docs/MARKET_SPEC.md`
- First scenario content: `docs/SCENARIO_01.md`
- Proposal-meeting MVP scope: `docs/MEETING_MVP_SPEC.md`
- Event product requirements: `docs/EVENT_MVP_PRD.md`
- System boundaries, state model, and stack: `docs/ARCHITECTURE.md`
- Metrics and data policy: `docs/DATA_AND_EVALUATION.md`
- AI/human collaboration workflow: `docs/AI_WORKFLOW.md`
- Accepted and proposed decisions: `docs/DECISIONS.md`
- Current work and handoff: `docs/STATUS.md`

If two documents conflict, stop and reconcile them. Prefer the more specific document only when it is newer and the change is recorded in `docs/DECISIONS.md`.

## Phase gate

Follow the phase recorded in `docs/STATUS.md`. On 2026-10-29 the owner switched GUILD MARKET to the artificial-market, batch-clearing design and retired the single-HTML prototype (D-024). The proposal-meeting MVP and the bank-event MVP are one app built on one game engine.

The owner approved D-025 to D-027 on 2026-10-29, so `apps/web` may be created with the dependencies listed in `docs/ARCHITECTURE.md`; document any other dependency before adding it. Do not create cloud resources or sign up for paid plans without separate owner approval. Do not add CI workflows without a recorded decision.

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

Use asdf for Node (`.tool-versions`, nodejs 24.16.0) and uv for Python (`uv run`, `.python-version`). Do not rely on a system Node or globally installed Python packages.

Run these in `apps/web` (copy `.env.example` to `.env` first):

```sh
npm install
npm run db:up        # local Postgres 17 in Docker on port 5433 (also creates the test database)
npm run db:migrate   # apply Prisma migrations
npm test             # engine: invariants, clearing examples, rules A/B, state machine
npm run test:db      # DB integration: concurrency, deadlines, idempotency, rollback, reveal timing
npm run typecheck
npm run build
npm run simulate     # 10,000 random games and the k table (about 70 seconds)
npm run dev          # then: npm run match:create -- --fast, and npm run smoke for a 6-team HTTP run
npm run test:e2e     # Playwright: 6 players, host, and venue screen play 5 rounds on a production build (about 2 minutes)
```

Regenerate the reviewed NPC sheet only on purpose (`npm run npc:generate -- 2 20261029`), and review the diff before committing it. Check document links and section references from the repository root with `uv run scripts/check_docs.py`. Record new commands here and in `CONTRIBUTING.md` when they are added.

When code exists:

- keep `src/engine` pure: no imports from Next.js, React, Prisma, or `node:*`;
- test the market invariants in `docs/MARKET_SPEC.md`;
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

- Flag any path that accepts or changes an order after the order deadline (plus grace) or while the match is paused.
- Flag non-idempotent order submission, round clearing, or settlement.
- Flag clearing results that depend on order arrival sequence or client clocks.
- Flag client-authoritative balances, prices, permissions, or event state.
- Flag collection or logging of unnecessary child/parent personal data.
- Flag runtime AI-generated event facts that can change the reviewed scenario outcome.
- Flag coupling of scenario text/assets to market-engine code.
- Flag changes that make multiplayer participation mandatory for solo play.
