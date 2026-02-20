# wopr-plugin-telegram

Telegram channel plugin for WOPR using the Grammy framework.

## Commands

```bash
npm run build     # tsc
npm run check     # biome check + tsc --noEmit (run before committing)
npm run lint:fix  # biome check --fix src/
npm run format    # biome format --write src/
npm test          # vitest run
```

## Architecture

```
src/
  index.ts   # Plugin entry — exports WOPRPlugin default, wires Grammy bot
  types.ts   # Plugin-local types
```

## Key Details

- **Framework**: Grammy (`grammy` npm package) — not `node-telegram-bot-api`
- Implements `ChannelProvider` from `@wopr-network/plugin-types`
- Bot token configured via plugin config schema (not env vars directly)
- Grammy's webhook vs polling mode controlled by plugin config

## Plugin Contract

Imports only from `@wopr-network/plugin-types`. Never import from `@wopr-network/wopr` core.

## Issue Tracking

All issues in **Linear** (team: WOPR). Issue descriptions start with `**Repo:** wopr-network/wopr-plugin-telegram`.

## Session Memory

At the start of every WOPR session, **read `~/.wopr-memory.md` if it exists.** It contains recent session context: which repos were active, what branches are in flight, and how many uncommitted changes exist. Use it to orient quickly without re-investigating.

The `Stop` hook writes to this file automatically at session end. Only non-main branches are recorded — if everything is on `main`, nothing is written for that repo.