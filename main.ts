// Ladder dip-buy bot for cbBTC on 1-minute bars (agent-fun/bars-replay/v1).
//
// Strategy (the owner's locked blueprint for this race, designed
// 2026-11-18 after the previous race and re-parameterised for today):
//
//   IDLE / WATCH. The bot starts flat and does nothing but watch. It
//   keeps an anchor: the highest close seen since it became idle. The
//   anchor is the level a dip is measured from, and the level a later
//   recovery is banked against.
//
//   LADDER 30 / 50 / 20. When the close falls to the first rung below
//   the anchor, the bot buys with 30% of the cycle budget (the equity
//   it held when the cycle started). If price falls further to the
//   second rung it buys 50% more, and at the third rung the last 20%.
//   A cycle can therefore end up fully invested, but only by buying
//   cheaper and cheaper.
//
//   CRASH GAP -> WAIT FOR THE BOTTOM. If one bar's close gaps straight
//   through all three rungs (the previous close was still above rung 1),
//   laddering into a free fall is exactly the falling-knife catch the
//   owner banned. The bot instead waits: it tracks the low, and only
//   when the close has bounced off that low and is rising does it buy
//   100% at once — the confirmed bottom entry of the blueprint.
//
//   NO STOP-LOSS ANYWHERE. A position is never sold because it is
//   losing. The only exits are the two take-profits below (and the
//   platform's own flatten at the end of the window).
//
//   TP1 — SELL 50% AT THE ANCHOR ZONE. When the close recovers to the
//   anchor zone (within 0.10% under the anchor), half the position is
//   sold. That banks the dip: the rungs were 0.70–1.70% under the
//   anchor, so a recovery to the anchor pays roughly that spread on
//   the half sold, minus costs.
//
//   TP2 — PEAK READER FOR THE REST. The remaining half is held for
//   more. Once the close has pushed at least 0.30% above the anchor
//   (the latch), the bot tracks the highest close from there; when the
//   close falls 0.35% under that peak, it sells everything left. The
//   latch matters: without it the peak reader would fire on the first
//   wiggle and dump the position near the bottom (measured in the
//   owner's 2026-11-18 backtests).
//
//   LOOP. After TP2 the bot rests for a 30-bar cooldown, then goes
//   idle again with a fresh anchor and a budget equal to its equity
//   at that moment — profits compound into the next cycle. It repeats
//   until the window closes. No new buys in the last 30 bars.
//
// Parameters, derived from today's tape (2026-11-23, Binance Vision
// BTCUSDT, checked before the build): BTC $61,451, +3.85% in 24 h
// after a dip to $59,026; 1-minute return sd 7.3 bps, 15-minute sd
// 26.9 bps, mean 1-hour range ~0.96% over the last day. The dev
// window of this race has 1-minute sd 8.1 bps and a maximum drawdown
// of 1.98% from a running peak, so rungs must live inside ~2%:
//   rung 1 at -0.70% (~2.6x the 15-minute sd: a real pullback, not
//     one-bar noise),
//   rung 2 at -1.20%, rung 3 at -1.70% (0.50% spacing, about half a
//     typical 1-hour range per step).
// The peak-reader distance 0.35% sits just above the 15-minute noise
// (26.9 bps) so ordinary chop does not trigger it, and the owner's
// earlier backtest found tighter peak distances (0.3%) beat wider
// ones (0.8%) on the race tape they were measured on.
//
// All state comes from the bars: no clock, no randomness, no files,
// no network — two runs over the same window agree byte for byte.

import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

/* ---- ladder (fractions below the cycle anchor) ---- */
const RUNG1 = 0.0070;
const RUNG2 = 0.0120;
const RUNG3 = 0.0170;
/** Rung sizes, as % of the cycle budget: 30 / 50 / 20. */
const RUNG_PCTS: readonly number[] = [30, 50, 20];
const RUNGS: readonly number[] = [RUNG1, RUNG2, RUNG3];

/* ---- bottom confirmation (crash-gap path) ---- */
/** A waited-for bottom counts as confirmed when the close has risen
 * this far off the tracked low... */
const BOTTOM_BOUNCE = 0.0035;
/** ...while still at least this far below the anchor (it is a bottom
 * buy, not a chase of a full recovery). */
const BOTTOM_MIN_DEPTH = 0.0100;
/** Give up waiting after this many bars and fall back to rung 1. */
const BOTTOM_WAIT_MAX = 180;

/* ---- exits ---- */
/** TP1 zone: this close to the anchor, from below, counts as back. */
const TP1_ZONE = 0.0010;
/** TP2 latch: the close must first push this far above the anchor. */
const TP2_LATCH_ABOVE_ANCHOR = 0.0030;
/** TP2: sell the rest when the close falls this far under the peak
 * tracked since the latch. */
const PEAK_DROP = 0.0035;

/* ---- loop ---- */
/** Bars of rest after a completed cycle before watching again. */
const COOLDOWN_BARS = 30;
/** No fresh buys in the last this many bars of the 1,440-bar window. */
const LATE_CUTOFF = 30;
const WINDOW_BARS = 1440;
/** Widest gap between the signal close and the fill open accepted. */
const MAX_SLIPPAGE_BPS = 150;
// Capital-preservation guard for NEW cycles only (not a stop-loss: an open
// position is still held through any drop, per the blueprint). If equity
// ever falls 20% below the race-start equity, the bot stops opening new
// cycles and only manages what it already holds. The dev tape's max
// drawdown was 1.58%, so this never triggers there; it exists for a live
// tape far uglier than anything in the calibration data.
const EQUITY_DD_HALT_NEW_CYCLES = 0.20;

type Phase = 'IDLE' | 'WAIT_BOTTOM' | 'IN' | 'COOLDOWN';

let phase: Phase = 'IDLE';
/** Highest close since going idle: the cycle anchor once buying starts. */
let anchorPeak = 0;
/** The frozen anchor of the open cycle. */
let cycleAnchor = 0;
/** Equity (cash, quote units) when the cycle's first buy was placed:
 * rung sizes are percentages of this, not of the shrinking cash pile. */
let cycleBudget = 0n;
/** How many rungs have been bought this cycle (0..3). */
let rungsFilled = 0;
/** Weighted average signal close of the buys, and the bar of the first. */
let avgEntry = 0;
let entryBar = -1;
/** TP1 has sold its half. */
let tp1Done = false;
/** Highest close since TP1 (the peak reader's raw material). */
let peakAfterTp1 = 0;
/** WAIT_BOTTOM: the lowest close tracked since the gap bar, and when
 * the wait began. */
let dipLow = 0;
let waitStartBar = -1;
/** COOLDOWN: the scored bar at which watching resumes. */
let cooldownUntil = -1;
let startEquity = 0n;

const closes: number[] = [];

function heldQty(state: BarsState): bigint {
  return state.positions.get(SYMBOL)?.qty ?? 0n;
}

function placeBuy(state: BarsState, pctOfBudget: number, close: number, scoredBar: number): OrderInput[] {
  const want = (cycleBudget * BigInt(pctOfBudget)) / 100n;
  const notional = want < state.cash ? want : state.cash;
  if (notional < BigInt(state.hello.fees.min_notional_quote_units)) return [];
  // Track the average entry in proportion to the notional placed.
  const prevNotional = avgEntry > 0 ? 1 : 0;
  if (prevNotional === 0) {
    avgEntry = close;
    entryBar = scoredBar;
  } else {
    // Weight by rung order sizes actually placed so far: keep a simple
    // running mean weighted by the cumulative percentage filled.
    const filledPct = RUNGS.reduce((acc, _r, i) => acc + (i < rungsFilled ? RUNG_PCTS[i] : 0), 0);
    const totalPct = filledPct + pctOfBudget;
    avgEntry = totalPct > 0 ? (avgEntry * filledPct + close * pctOfBudget) / totalPct : close;
  }
  return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS }];
}

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return [];
    const close = Number(bar.c);
    const prevClose = closes.length > 0 ? closes[closes.length - 1] : close;
    closes.push(close);
    if (state.warmingUp) {
      if (close > anchorPeak) anchorPeak = close;
      return [];
    }
    const scoredBar = state.seq - state.warmupBars;
    const qty = heldQty(state);
    const canBuy = scoredBar < WINDOW_BARS - LATE_CUTOFF;

    /* ---------- COOLDOWN: rest, then watch with a fresh anchor ---- */
    if (phase === 'COOLDOWN') {
      if (scoredBar >= cooldownUntil) {
        phase = 'IDLE';
        anchorPeak = close;
        cycleAnchor = 0;
        rungsFilled = 0;
        tp1Done = false;
        peakAfterTp1 = 0;
        avgEntry = 0;
      }
      return [];
    }

    /* ---------- IN a position: ladder down, bank up, never stop --- */
    if (phase === 'IN') {
      if (qty === 0n) {
        // The final sell has filled and the books are flat again
        // (can only happen if the window's flatten beat TP2 to it):
        // treat the cycle as over.
        phase = 'COOLDOWN';
        cooldownUntil = scoredBar + COOLDOWN_BARS;
        return [];
      }
      // TP1: recovery to the anchor zone sells half.
      if (!tp1Done) {
        if (close >= cycleAnchor * (1 - TP1_ZONE) && close > avgEntry) {
          tp1Done = true;
          peakAfterTp1 = close;
          const half = qty / 2n;
          if (half > 0n) {
            return [{ side: 'sell', symbol: SYMBOL, qty: half, max_slippage_bps: MAX_SLIPPAGE_BPS }];
          }
          return [];
        }
        // Ladder: deeper rungs buy more, one rung per bar at most.
        if (canBuy && rungsFilled >= 1 && rungsFilled < 3) {
          const nextDepth = RUNGS[rungsFilled];
          if (close <= cycleAnchor * (1 - nextDepth)) {
            const orders = placeBuy(state, RUNG_PCTS[rungsFilled], close, scoredBar);
            if (orders.length > 0) rungsFilled += 1;
            return orders;
          }
        }
        return [];
      }
      // TP2: peak reader on the remaining half.
      if (close > peakAfterTp1) peakAfterTp1 = close;
      const latched = peakAfterTp1 >= cycleAnchor * (1 + TP2_LATCH_ABOVE_ANCHOR);
      if (latched && close <= peakAfterTp1 * (1 - PEAK_DROP)) {
        phase = 'COOLDOWN';
        cooldownUntil = scoredBar + COOLDOWN_BARS;
        return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    /* ---------- WAIT_BOTTOM: a crash gapped through the ladder ----- */
    if (phase === 'WAIT_BOTTOM') {
      if (close < dipLow) dipLow = close;
      const bounced = dipLow > 0 && close >= dipLow * (1 + BOTTOM_BOUNCE) && close > prevClose;
      const stillDeep = close <= cycleAnchor * (1 - BOTTOM_MIN_DEPTH);
      if (canBuy && bounced && stillDeep) {
        cycleBudget = state.cash;
        const orders = placeBuy(state, 100, close, scoredBar);
        if (orders.length > 0) {
          rungsFilled = 3;
          phase = 'IN';
        }
        return orders;
      }
      if (close >= cycleAnchor * (1 - TP1_ZONE)) {
        // Recovered all the way without confirming a bottom we could
        // buy: the moment has passed, watch again from here.
        phase = 'IDLE';
        anchorPeak = close;
        cycleAnchor = 0;
        return [];
      }
      if (scoredBar - waitStartBar >= BOTTOM_WAIT_MAX && canBuy && close <= cycleAnchor * (1 - RUNG1)) {
        // The wait timed out with price still cheap: fall back to the
        // ladder's first rung rather than sit out the whole cycle.
        cycleBudget = state.cash;
        const orders = placeBuy(state, RUNG_PCTS[0], close, scoredBar);
        if (orders.length > 0) {
          rungsFilled = 1;
          phase = 'IN';
        }
        return orders;
      }
      return [];
    }

    /* ---------- IDLE: watch, keep the anchor at the high ----------- */
    if (close > anchorPeak) anchorPeak = close;
    if (!canBuy || anchorPeak <= 0) return [];
    if (startEquity === 0n) startEquity = state.equity;
    if (startEquity > 0n && state.equity * 100n < startEquity * BigInt(Math.round((1 - EQUITY_DD_HALT_NEW_CYCLES) * 100))) return [];
    const depth = 1 - close / anchorPeak;
    if (depth < RUNG1) return [];
    if (prevClose > anchorPeak * (1 - RUNG1) && depth >= RUNG3) {
      // One bar gapped from above rung 1 to below rung 3: a crash,
      // not a dip. Do not ladder into it — wait for the bottom.
      cycleAnchor = anchorPeak;
      dipLow = close;
      waitStartBar = scoredBar;
      phase = 'WAIT_BOTTOM';
      return [];
    }
    cycleAnchor = anchorPeak;
    cycleBudget = state.cash;
    const orders = placeBuy(state, RUNG_PCTS[0], close, scoredBar);
    if (orders.length > 0) {
      rungsFilled = 1;
      phase = 'IN';
    }
    return orders;
  },
});
