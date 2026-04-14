# Darbitex — Final Design

> ### ⚠ DEPRECATED — describes a pre-implementation architecture that was abandoned
>
> This file describes the original **`beforeSwap` / `afterSwap` callback hook pattern** where `pool::swap` would internally call into an `arbitrage` module via a `friend` relationship and a `swap_raw` friend function. That architecture was **abandoned during implementation** in favor of a cleaner **wrapper pattern**: `arbitrage.move` is a separate module that wraps `pool::swap` from the outside, with no callback into `arbitrage` from `pool`, no friend relationship between the two modules, and no `swap_raw` function.
>
> The implemented architecture is documented authoritatively in **`AUDIT-FINAL-SUBMISSION.md`** and the source itself:
>
> - `pool.move` only declares `friend darbitex::pool_factory` — zero coupling to arbitrage
> - `arbitrage.move` imports `pool` and `pool_factory` one-way, no reverse dep
> - Users call `arbitrage::swap_entry` which wraps `pool::swap` with smart routing + service-charge split
> - `pool::swap` remains a pure composable primitive callable from any Move code
> - Zero reentrancy surface (no code callback from `pool::swap` into external modules)
>
> This file is kept as a historical record of early design thinking. **Do not use it as a reference for the implemented protocol.** See `AUDIT-FINAL-SUBMISSION.md` for the authoritative architecture, threat model, and design principles.
>
> — Flagged by Claude (fresh web) R1 audit, INFORMATIONAL-3.

---

## Original design doc (historical)

> Last design of Darbitex. Beta (`0x2656e373...`) stays as legacy; users migrate
> organically. This is the terminal iteration: clean-slate package, native
> programmable hook, no HookNFT fee slots, no hook owner, fully open callback.

---

## 0. Principles

1. **Clone, don't rewrite.** Source base is beta pool.move / pool_factory.move /
   library.move. Delete HookNFT machinery, add arbitrage module. Minimize code
   divergence from audited beta to preserve audit equity.
2. **Hook is programmable code, not a revenue slot.** Nobody owns it, nobody
   mints it, nobody claims its fees. It is a beforeSwap + afterSwap callback
   in the pool module that anyone's swap triggers, and the profit of the
   rebalance it executes is credited to the user whose swap triggered it.
3. **Native layer.** Pool and hook live in the same package. Compile-time
   dispatch. No circular dep workaround, no external wrapper.
4. **Internal flash only.** No Aave. Triangle rebalance borrows from a sister
   Darbitex pool using the existing native flash primitive.
5. **Compat-then-immutable.** Launch with `upgrade_policy = compatible` for
   bug fix runway. Freeze to immutable after 3–6 months of clean operation.

---

## 1. Package structure

```
/home/rera/darbitex-final/
├── Move.toml                  # named address: darbitex = _
├── sources/
│   ├── pool.move              # cloned from beta, HookNFT stripped, hook wired
│   ├── pool_factory.move      # cloned, hook NFT escrow removed, registry added
│   ├── lp_position.move       # cloned 1:1
│   ├── library.move           # cloned 1:1
│   ├── arbitrage.move          # NEW — programmable afterSwap callback
│   └── tests.move             # cloned + hook-specific test cases added
└── docs/
    └── design.md              # this doc
```

**Named address:** Launch with a fresh address (new 3/5 multisig). The brand
name "Darbitex" in user-facing surfaces points to THIS package. Beta remains
addressable on-chain at its own address but is deprecated in frontend.

---

## 2. What gets cloned from beta, unchanged

- `x*y=k` constant product math (`library.move`)
- LP position accounting (`lp_position.move` — debt snapshot, accumulator)
- Pool state struct minus hook NFT fields
- `add_liquidity`, `remove_liquidity`, LP mint/burn
- `flash_borrow` / `flash_repay` with `FlashReceipt` hot-potato + pool lock
- `FLASH_FEE_BPS = 1`
- Swap math core (`swap_internal`)
- Factory pool creation flow (minus HookNFT mint + escrow listing)
- Events: LpAdded, LpRemoved, Swap, FlashBorrowed, FlashRepaid

## 3. What gets removed from the clone

- `struct HookNFT`, `mint_hook_nft`, `claim_hook_fees`
- `hook_nft_1` / `hook_nft_2` fields on Pool
- `hook_1_fee_a/b`, `hook_2_fee_a/b` accumulators
- `HOOK_SPLIT_PCT` constant
- `extra_fee` pot accounting in `accrue_fee` — fee is now pure LP fee (see §4)
- Factory: `hook_listings` table, `buy_hook`, `set_hook_price`, `current_hook_price`
- Events: HookFeesClaimed, HookPurchased, HookPriceUpdated

## 4. Fee accounting (open question — needs user confirmation)

**Two independent revenue streams, confirmed:**

Stream 1 — **swap fee (1 bps)**:
- 100% accrued to LP providers via single accumulator
- Identical math to beta, just without the HookNFT `extra_fee` pot split
- Hook code does NOT touch this stream at all

Stream 2 — **arb surplus (triangle rebalance profit)**:
- Only flows when arbitrage fires a profitable rebalance
- Split 90% to `sender` (user whose swap triggered the hook)
- Split 10% to hardcoded treasury address
- No LP share of this stream
- No passive hook fee slot — hook is pure compute, owns nothing

Streams are orthogonal. LP earns from swap fee as always. When a user's swap
happens to create rebalance-worthy imbalance, that same user gets 90% of the
arb surplus on top — free upside for being the trigger. Treasury skims 10%
as protocol sustenance.

## 5. What gets added to the clone

### 5.1 Pool module additions

- `friend darbitex::arbitrage;`
- `public(friend) fun swap_raw(...)` — swap without hook callback, used by
  hook internally to avoid recursion. Identical body to `swap_internal`, just
  friend-exposed.
- Existing `public fun swap(...)` body gets TWO hook callouts:
  1. **beforeSwap** — `arbitrage::before_swap(pool_addr, sender, token_in,
     token_out, amt_in)` called as the very first step, before any reserve
     reads. Catches imbalance accumulated from prior txs.
  2. **afterSwap** — `arbitrage::after_swap(pool_addr, sender, token_in,
     token_out, amt_in, amt_out)` called as the very last step, after
     reserves mutated and Swap event emitted. Catches imbalance created by
     this swap itself.
  Both callbacks are wrapped in soft-skip error handling (§9.2) so hook
  bugs never cause user swaps to revert at launch.

### 5.2 pool_factory additions

- Global pool registry for sister-pool discovery:
  ```move
  struct Factory has key {
      ...existing fields minus hook stuff...
      asset_index: Table<address, vector<address>>,  // asset_meta -> pool_addrs
      pool_count: u64,
  }
  ```
- On `create_pool`: insert `pool_addr` into `asset_index[asset_a]` and
  `asset_index[asset_b]` vectors
- `public fun pools_containing_asset(asset: address): vector<address>` —
  read-only view used by arbitrage
- Cost: O(1) insert on pool creation, O(n) read on every hook fire where
  n = pools sharing the asset. Bounded by practical pool count (tens, not
  thousands).

### 5.3 arbitrage module (new)

```move
module darbitex::arbitrage {
    friend darbitex::pool;  // only pool module calls on_swap

    const IMBALANCE_THRESHOLD_BPS: u64 = 10;  // fire only if > 10 bps edge
    const TREASURY_BPS: u64 = 1_000;           // 10% of surplus
    const SENDER_BPS: u64 = 9_000;             // 90% of surplus
    const TOTAL_BPS: u64 = 10_000;
    const TREASURY: address = @0xdbce8911...;  // existing 3/5 treasury

    struct HookFired has drop, store {
        pool_addr: address,
        sender: address,
        triangle_path: vector<address>,
        principal: u64,
        gross_out: u64,
        surplus: u64,
        treasury_cut: u64,
        sender_cut: u64,
        timestamp: u64,
    }

    struct HookSkipped has drop, store {
        pool_addr: address,
        reason: u8,  // 1=no_triangle, 2=below_threshold, 3=insufficient_liquidity
        best_spread_bps: u64,
        timestamp: u64,
    }

    public(friend) fun before_swap(
        pool_addr: address,
        sender: address,
        token_in: address,
        token_out: address,
        amt_in: u64,
    ) { try_rebalance(pool_addr, sender, token_in) }

    public(friend) fun after_swap(
        pool_addr: address,
        sender: address,
        token_in: address,
        token_out: address,
        amt_in: u64,
        amt_out: u64,
    ) { try_rebalance(pool_addr, sender, token_out) }

    fun try_rebalance(pool_addr, sender, anchor_asset) {
        // 1. Discover pools containing anchor_asset via factory registry
        // 2. Find best cycle starting+ending at anchor_asset (see §6)
        // 3. If no profitable cycle above threshold → emit HookSkipped, return
        // 4. Flash borrow from a pool on the cycle
        // 5. swap_raw through each leg
        // 6. flash_repay the borrowed amount + fee
        // 7. Split surplus: 10% → treasury, 90% → sender
        //    (deposit FAs directly to primary fungible stores)
        // 8. Emit HookFired
        // Any abort is caught by soft-skip wrapper at callsite.
    }
}
```

### 5.4 Cycle discovery algorithm (variable length, pruned DFS)

Given an anchor asset (for beforeSwap this is `token_in`, for afterSwap
`token_out`), find the best cycle starting and ending at the anchor:

```
const MAX_CYCLE_LEN: u64 = 5;
const MAX_PER_LEG_SLIPPAGE_BPS: u64 = 100;  // skip leg if > 1% impact

fn find_best_cycle(anchor, factory) -> Option<Cycle> {
    let mut best = None;
    dfs(anchor, anchor, path=[], visited_pools=[], depth=0, &mut best);
    best
}

fn dfs(current, start, path, visited, depth, best) {
    if depth >= MAX_CYCLE_LEN return;
    for pool in factory.pools_containing_asset(current) {
        if pool in visited continue;
        let other = pool.other_asset(current);
        let new_path = path ++ (pool, current→other);
        if other == start && depth + 1 >= 3 {
            // candidate cycle closes
            let (size, surplus, max_leg_slip) = ternary_search_optimal(new_path);
            if max_leg_slip > MAX_PER_LEG_SLIPPAGE_BPS continue;
            if best.is_none() || surplus > best.surplus { *best = Some(cycle) }
            // upper bound for pruning deeper cycles: skip
        } else {
            dfs(other, start, new_path, visited ++ pool, depth + 1, best);
        }
    }
}
```

Pruning strategy:
- Length-3 cycles explored first (cheapest, likely to yield baseline)
- Length-4+ explored only if projected upper-bound surplus > current best
- Per-pool visited set prevents revisiting the same pool in one cycle
- `max_leg_slip > MAX_PER_LEG_SLIPPAGE_BPS` skips cycles where any single
  leg eats too much (user directive: "skip jika membuat slippage parah")

Realistic gas cost: with current Darbitex pool set (3–4 pools), DFS
terminates in < 20 ops per hook fire. Bounded by `MAX_CYCLE_LEN` even as
pool count grows.

### 5.5 Optimal borrow size via ternary search

For each candidate cycle, find the borrow amount that maximizes net surplus:

```
fn ternary_search_optimal(cycle) -> (size, surplus, max_leg_slip) {
    let mut lo = 0u64;
    let mut hi = min(each leg's reserve × 0.5);
    for _ in 0..20 {  // log3(u64 max) ~ 40; 20 iter = enough precision
        let m1 = lo + (hi - lo) / 3;
        let m2 = hi - (hi - lo) / 3;
        let s1 = simulate_cycle(cycle, m1);
        let s2 = simulate_cycle(cycle, m2);
        if s1 < s2 { lo = m1; } else { hi = m2; }
    }
    let final_size = (lo + hi) / 2;
    simulate_cycle(cycle, final_size)
}
```

Why ternary search over closed form:
- Closed form exists for length-3 but gets ugly for length-4+
- One implementation handles all cycle lengths uniformly
- Robust to off-by-one / sign errors; unit tests cover `simulate_cycle` once
- Gas cost: ~20 × `get_amount_out` per candidate ≈ 5–10k gas extra per fire
- Acceptable tradeoff vs audit risk of hand-rolled closed-form math

`simulate_cycle(cycle, amount_in)` is pure math — repeatedly calls
`library::get_amount_out(r_in, r_out, amt)` walking the cycle, no state
mutation, no flash borrow. The actual flash borrow + swap_raw execution
happens once after the optimal size is found.

**User decision pending:** scaffold Phase 1 with length-3 hardcoded
(simpler, faster ship) and generalize to DFS later via compat upgrade, OR
ship DFS + ternary search from day one.

## 6. Anti-reentrancy

- `pool::swap` calls `arbitrage::on_swap` at end of swap body
- `arbitrage::on_swap` calls `pool::swap_raw` (friend-only, **does not call
  back into arbitrage**) for its two triangle legs
- Flash borrow path: `pool::flash_borrow` sets pool lock flag; during lock,
  `swap_raw` on that pool would abort. Hook MUST repay on the same pool it
  borrowed from before touching that pool again. Sequence:
  `borrow(pool_Q) → swap_raw(pool_P, ...) → swap_raw(pool_X, ...) → repay(pool_Q)`.
  (Pool_X has already finished its user swap and its lock is released by the
  time hook runs.)
- No global reentrancy flag needed — the friend boundary enforces it.

## 7. Profit split mechanics

On a successful rebalance:
- `principal` = amount flash-borrowed from sister pool
- `flash_fee` = principal × 1 / 10_000
- `gross_out` = output of the final leg returning to the borrow asset
- `surplus` = gross_out − principal − flash_fee
- `treasury_cut` = surplus × 1_000 / 10_000
- `sender_cut` = surplus − treasury_cut
- Flash debt is repaid first. Then `treasury_cut` deposited to @TREASURY.
  Then `sender_cut` deposited to the `sender` address (user who triggered
  the original pool::swap).
- Deposits use `primary_fungible_store::deposit` — no intermediary custody.

## 8. Gas overhead analysis

Every user swap now pays overhead for:
- 1× factory registry read (`Table::borrow` × 2 keys)
- Triangle enumeration (bounded: with N sister pools, O(N²) worst case but
  realistically ~3 for current asset set)
- Price check on each candidate (3× `get_amount_out` math ops per candidate)
- If triangle exists: ternary search or closed-form optimal size calc
- If fire: 3× pool reads + 3× pool writes + 2× events

Mitigation decisions (user confirmed option "a" during spec discussion):
**Always-compute.** No size threshold, no cached timestamp short-circuit.
Gas cost accepted as baseline because (1) sorting math is cheap relative to
FA ops, (2) profit split 90% to sender means user gets rebated even on tiny
rebalances, (3) we don't want first-mover disadvantage where small swaps
are skipped and pile up imbalance.

**Worst-case gas estimate:** ~2k–5k extra gas per swap when no fire, ~15k–25k
extra when hook fires (2 extra swaps + events + deposits). Pending on-chain
benchmark.

## 9. Edge cases and failure modes

1. **Insufficient sister pool reserves for optimal size.** Cap borrow at
   `min(optimal, sister_reserve × 50%)`. If capped size produces surplus
   below threshold, skip.
2. **Triangle computed profitable but actual execution slips.** Two failure
   modes:
   - Rounding in library math vs arbitrage estimate
   - Reserves changed between estimate and execute (can't happen — all in
     one tx, no concurrency)
   - Mitigation: after triangle execution, check `gross_out ≥ principal +
     flash_fee`. If not, abort the whole pool::swap. This means user's swap
     also reverts. **Alternative:** hook swallows its own failure (try-style
     emit HookSkipped) so user swap doesn't revert from hook misfire.
   - **→ DECISION NEEDED:** Hard-revert or soft-skip on hook execution
     failure? Soft-skip is safer (user's swap always succeeds) but masks
     bugs. Hard-revert is cleaner but creates DoS surface if hook has a bug.
   - My recommendation: **soft-skip** in launch, tighten to hard-revert
     after 3 months stable. This is also why we keep `compatible` upgrade
     policy for that window.
3. **Only 2 pools exist** (no triangle closeable). HookSkipped reason=1, return.
4. **User swap is itself one of the triangle legs.** The just-executed swap
   already shifted pool_X state; hook reads post-swap state, which is
   correct. The triangle includes the NEW pool_X state, not pre-swap.
5. **LP operations (add/remove) do NOT trigger hook.** Only `swap` does.
   Rationale: LP ops don't create triangle-closable mispricing the same way
   a directional swap does; adding complexity isn't worth it.
6. **Flash loan during triangle execution is on sister pool, not swapped
   pool.** Pool X (just swapped) is unlocked. Pool Q (borrow source) is
   locked during triangle. Pool P (middle leg) must not be Q.
7. **Nested swap → hook → flash → swap_raw → would that swap_raw trigger
   hook?** No. `swap_raw` is friend-only and does not call `arbitrage::on_swap`.
   Only public `swap` does.

## 10. Resolved decisions

- **Q1 — fee accounting.** LP gets 100% of 1 bps swap fee. Hook has no
  passive fee slot. Hook revenue is exclusively arb surplus. **CONFIRMED.**
- **Q2 — hook failure mode.** Soft-skip at launch (user swap always
  succeeds, hook errors caught + emitted as HookSkipped event). Tighten to
  hard-revert possible in later compat upgrade after stabilization. **CONFIRMED.**
- **Q3 — imbalance threshold.** 10 bps. **CONFIRMED.**
- **Q4 — named address.** Fresh multisig, separate from beta and existing
  treasury. **Launch threshold 1/5** for deploy velocity (publish + initial
  pool creation + smoke test in single-signer flow). **Raise to 3/5** as a
  multisig admin tx immediately after smoke test passes and before any
  real liquidity / user routing. Threshold change is a standard multisig
  operation, no code upgrade required. **CONFIRMED.**
- **Q5 — optimal size algorithm.** Ternary search. Single implementation for
  all cycle lengths, auditable, ~20 iterations to u64 precision. **CONFIRMED.**
- **Q6 — cycle length.** Variable length, MAX_CYCLE_LEN=5, MAX_PER_LEG_SLIPPAGE_BPS=100.
  DFS-based discovery. **CONFIRMED.**
- **Q7 — directory.** `/home/rera/darbitex-final/`. **CONFIRMED.**
- **Hook position.** BOTH beforeSwap and afterSwap fire on every pool::swap.
  beforeSwap catches legacy imbalance, afterSwap catches newly-created
  imbalance. Each wrapped in soft-skip. **CONFIRMED.**

- **Q8 — cycle discovery scaffold.** Length-3 hardcoded in Phase 1.
  Generalize to DFS variable-length later via compat upgrade if pool count
  grows beyond 4. Faster ship, simpler audit surface at launch. `find_best_cycle`
  extracted as isolated function so future generalization is a swap-in, not
  a structural rewrite. **CONFIRMED.**

## 10b. No remaining open questions

All spec decisions locked. Ready for Phase 1 scaffolding.

## 11. Implementation phases (after spec lock)

1. **Phase 1 — scaffold** (½ day): create Move.toml, clone sources, strip
   HookNFT, verify clean compile with HookNFT removed
2. **Phase 2 — registry** (½ day): add `asset_index` to factory, wire into
   `create_pool`, add `pools_containing_asset` view
3. **Phase 3 — arbitrage module** (1–2 days): on_swap, triangle discovery,
   size calc, execution, profit split, events
4. **Phase 4 — swap wiring** (½ day): add `swap_raw` friend, wire
   `arbitrage::on_swap` into `pool::swap` body
5. **Phase 5 — tests** (1–2 days): unit tests for triangle math, integration
   test for full cycle, test all edge cases from §9
6. **Phase 6 — audit prep** (ongoing): docs, threat model, scenarios
7. **Phase 7 — deploy** (½ day): create fresh 1/5 multisig, publish package,
   create initial pools, seed minimal LP, frontend wiring pointing at new
   package address
8. **Phase 8 — smoke test** (½ day): execute swaps across each pool pair,
   verify hook fires correctly, verify LP fee accrual, verify arb surplus
   split, verify events
9. **Phase 9 — raise threshold** (1 tx): multisig `update_signatures_required`
   from 1/5 to 3/5. No code change. After this, beta → final migration
   communication can begin
10. **Phase 10 — soak** (3–6 months): production traffic, bug fixes via
    compat upgrades, metrics
11. **Phase 11 — freeze** (1 tx): switch upgrade_policy to immutable

Total: ~5–7 days implementation + 3–6 months soak before freeze.

## 12. Non-goals

- CLMM. Not in scope. Ever, for this package.
- Multi-hop user swaps beyond the native router beta had. Aggregator remains
  an external satellite.
- Cross-venue hooking (reading Hyperion/Thala state from on-chain). External
  venues remain the domain of the off-chain scanner + arb page.
- Hook ownership / tokenization / fee-claim UX. Hook is ownerless, period.
- Governance. No admin cap, no parameter tuning post-launch for anything
  arbitrage-related. Constants are hardcoded.
- Backwards compat with beta LP tokens. Beta LPs withdraw from beta, deposit
  to final. No migration helper.
