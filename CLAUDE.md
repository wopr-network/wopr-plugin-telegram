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
