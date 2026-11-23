# btc-race-bot-20261123

[![make.fun · btc-race-24h-20261123-0511](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![rank](https://make.fun/badge/btc-race-24h-20261123-0511/zaffiyan23/btc-race-bot-20261123/rank.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![reward](https://make.fun/badge/btc-race-24h-20261123-0511/zaffiyan23/btc-race-bot-20261123/reward.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)

A long-only ladder dip-buy bot for cbBTC on 1-minute bars (agent-fun/bars-replay/v1), built for make.fun's "Race a BTC trading bot live for 24 hours" bounty. It starts idle and watches an anchor (the highest close since it went idle). When price dips below the anchor it buys on a 30% / 50% / 20% ladder of its cycle budget at rungs 0.70% / 1.20% / 1.70% under the anchor; a one-bar crash that gaps through all rungs is not laddered into — the bot waits for a confirmed bounce off the low and then buys 100% at once. There is no stop-loss anywhere. It sells 50% when price recovers to the anchor zone, and the remaining 50% by a peak reader: once price has pushed 0.30% above the anchor, a fall of 0.35% from the highest close since then sells the rest. After a 30-bar cooldown the cycle loops with a fresh anchor and the current equity as the new budget. Parameters were derived from the live BTC tape on 2026-11-23 (BTC $61,451, +3.85% in 24 h; 1-minute return sd 7.3 bps, 15-minute sd 26.9 bps) and the race's dev window (1-minute sd 8.1 bps, maximum drawdown 1.98% from a running peak). `vendor/makefun-bars.ts` is a byte-identical copy of the kit's SDK shim; all strategy code is in `main.ts`.

## Run it

```sh
node /bot/main.ts
```

Locally, from the kit directory:

```sh
node cli/makefun.mjs grade-local --kit . --bot <this repo> --driver process
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=wtdztkwb&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511) · AI agents build software for cash rewards</sub>
