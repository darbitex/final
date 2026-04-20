# TWAMM Deploy Log — Knowledge Transfer (2026-04-20)

Self-contained narrative from R5 audit cycle through mainnet smoke. Read this
before touching the TWAMM satellite. Target audience: any future operator
(human or AI — Gemini Antigravity, Claude Code, OpenHands, etc.) who needs to
pick up TWAMM context without re-reading every audit bundle.

---

## 1. Entry state (pre-R5)

The satellite code came in from R3-R4 audit rounds with known architectural
tension: `bridge.move` declared `friend darbitex_twamm::executor` while
sitting in a different package (`darbitex_flashbot`). Aptos Move requires
friend modules to share an address — cross-package friend does not compile.
All 7 prior AI auditors approved this state because none of them ran
`aptos move compile`.

## 2. R5 self-audit (Opus 4.7 with full compile verification)

First action: `aptos move compile` → fails with
`friend modules of ... must have the same address`.

**R4 structural fix applied** (done in this session before R5 audit):
- Moved `bridge.move` from `flashbot/sources/` → `twamm/sources/`
- Renamed namespace `darbitex_flashbot::bridge` → `darbitex_twamm::bridge`
- Updated `use` statement in executor
- Updated Move.toml deps (twamm now directly depends on AavePool + DarbitexThala stubs)
- Flashbot package now contains only the standalone `flashbot::run_arb*`
  user-facing arb entries; they are unrelated to TWAMM

**R5 defensive fix**: added `assert!(reserve_in > 0 && reserve_out > 0)` to
`force_update_oracle` (match `init_ema_oracle` guard) — prevents divide-by-zero
footgun if admin passes (0, 0).

## 3. R5.1 — Gemini 3 Flash external audit

Gemini flagged three items:
- **Dust spam on `create_order`**: overstated severity (keeper not forced to
  tick on-chain spam), but `amount_in > 0` + `duration_seconds > 0` added as
  hygiene.
- **`MAX_EMA_DEVIATION = 5` too loose for stable pairs**: valid advisory,
  deferred to V2 (Candidate D).
- **External-pause cascade**: genuine MEDIUM. If Thala/Aave is paused, bridge
  revert → whole tx revert → `last_executed_time` not updated → order stuck
  accumulating time_elapsed → eventual retry has huge slippage.

  Fix: added `cancel_order(user, order_address)` owner-escape-hatch. Sweeps
  remaining token_in + undelivered token_out back to owner, marks order inert
  (`remaining_amount_in = 0`). New event `OrderCancelled` + error
  `E_NOT_OWNER = 10`.

## 4. R5.1 external audit cycle (7 auditors green)

| Auditor | Verdict |
|---------|---------|
| Claude Opus 4.7 (self-audit) | GREEN |
| Gemini 3 Flash | APPROVED MAINNET |
| Kimi K2.5 (source-verified) | PASS |
| Grok (xAI) | APPROVED MAINNET |
| Qwen | APPROVED |
| OpenHands | PASS |
| DeepSeek | RECOMMENDED FOR PRODUCTION |

All non-blocker findings catalogued as V2 candidates (C–I) in
`memory/darbitex_twamm_v2_candidates.md`. Source code embedded in
`Audit-R5-Bundle.md` after Kimi's first-round source-less review produced
false positives.

## 5. Testnet detour (abandoned)

Tried `aptos move publish` to testnet via `testnet_final` profile. Aborted
with `EPACKAGE_DEP_MISSING` — Aptos validates ALL declared deps at
simulation time, not just bytecode-referenced. Aave (`0x39ddcd9e`) and
Darbitex Thala adapter (`0x583d93de`) don't exist on testnet.

Options considered:
- A.2 Stub bridge + drop deps → creates testnet-divergent bytecode
- A.4 Publish testnet stubs ourselves → 1-2 hours extra work
- X Skip testnet, go direct to mainnet per SOP → chosen

User decision: skip testnet, accept that smoke test IS runtime verification
per `feedback_smoke_test.md`.

## 6. Mainnet deploy sequence

### Phase 2 — 1/5 multisig bootstrap

```
aptos multisig create --additional-owners <addr2..5> --num-signatures-required 1 --profile final
```

Result: multisig `0x9df06f93369effe15ab626044bbbcb03e6bf198af909ac4c133719e637771cf4`
with Pattern A owners (same as Final core).

**Note**: multisig creation doesn't need to be funded — gas is paid by the
signer (not the multisig account) on each `execute`. I mistakenly transferred
0.4 APT to the multisig first; recovered 0.39 APT via a self-transfer in
Phase 4.

### Phase 3 — Publish v0.1.0

```
aptos move build-publish-payload --json-output-file /tmp/twamm-publish.json \
  --named-addresses darbitex_twamm=<multisig_addr>
aptos multisig create-transaction --multisig-address <multisig> --json-file /tmp/twamm-publish.json
aptos multisig execute --multisig-address <multisig>
```

Result: modules `bridge` + `executor` live at the multisig address.
Tx: `0x3489031ef9fb73c9de660269a1c3615746c5068ce5fffd162f78d6453e82aff5`.

### Phase 4 — Bootstrap oracle + keeper

Two multisig txs:
1. `init_ema_from_pool(darbitex_pool=0x3837eff0..., token_in=0xa)` —
   reads APT/USDC pool reserves (361M octas APT, 3.55M units USDC),
   writes `EmaOracle` singleton at multisig address.
2. `add_keeper(0x0047a3e1...)` — whitelists hot wallet as keeper.

### Phase 5 — First smoke test (exposed bug)

- `create_order(token_in=APT, token_out=USDC Circle, amount_in=1_000_000, duration=600)`
  → order address `0x2d00a0fef30b55e93a61f3ea57781c11b50d713723ef1e432c1442aedbf54d64`.
- Waited 60s.
- Oracle went stale (5-min gate) because setup took > 5 min. Ran
  `force_update_oracle` first to refresh.
- `execute_virtual_order(keeper, order_addr, thala_pool=0xa928..., darbitex_pool=0x3837eff0...)`

**Aborted**: `E_MIN_OUT(0x2)` in `0x583d93de::adapter` — Thala adapter
rejected slippage.

### Root cause analysis

`bridge.move:89` passed `deadline` (u64 Unix timestamp, ~1.7 billion) as
arg 5 to `thala::swap`. Live signature expects arg 5 to be `min_out: u64`.
Adapter received 1.7 billion as min_out, couldn't deliver, aborted.

**Why no auditor caught it**: both `deadline` and `min_out` are `u64`.
Compile sees same type. Static analysis sees a value pass-through.
Manual review correlates the parameter by name inside the module, not
across modules at the ABI boundary. The Thala stub at `deps/ThalaStub/`
clearly shows `_min_out: u64` as the 5th param but the bridge author
carried over old signature semantics.

### Phase 5.5 — v0.1.1 upgrade (compatible)

Two-line fix in `bridge.move`:
- Line 89 (user leg): `thala::swap(..., min_amount_out)` — use caller's
  declared min_out.
- Line 104 (arb leg): `thala::swap(..., 0)` — arb leg's economic guard is
  the final `assert!(gross_out >= auto_borrow_amount, E_CANT_REPAY)`, so
  min_out=0 is safe (same pattern as `flashbot::run_arb*`).

Re-compiled, proposed upgrade via multisig, executed. Package upgraded
to v0.1.1 at tx version `4942656615`. Compatible upgrade — no storage
changes.

### Phase 5.6 — Re-smoke (green)

After `force_update_oracle` refresh, re-ran create_order + tick. Result:
- `amount_in: 208,333` octas (0.00208 APT)
- `amount_out: 1,944` USDC units (0.001944 USDC) — ~$0.0018 at $0.93/APT
- `arb_executed: false` — MEV leg skipped because oracle matches Darbitex
  pool price, `calculate_optimal_borrow` returned 0
- Events `VirtualOrderExecuted` + `OmniSwapExecuted` emitted correctly
- Owner `0x0047` received USDC
- `order.remaining_amount_in`: 791,667 octas (balance sweep working)

Then `cancel_order` on remaining order to clean state. Recovered
remaining APT back to owner.

### Phase 6 — Raise to 3/5

```
aptos multisig create-transaction --function-id 0x1::multisig_account::update_signatures_required --args u64:3
aptos multisig execute
```

Result: threshold 3/5. Multisig is now production-governance-ready.

## 7. What V1 does and does not do

**Does**:
- TWAMM virtual orders: `create_order` escrows token_in + schedules
  time-weighted execution over N seconds.
- Keeper-whitelisted `execute_virtual_order`: time-proportional chunking
  with EMA oracle price gate (95% min_out holistic + 90% inner fail-fast).
- Oracle: `EmaOracle` singleton, initialized from a Darbitex pool, blended
  with pool reserves (10% weight) when trade ratio passes 5× deviation gate.
- Admin: add/remove keeper, force_update_oracle (all emit `AdminActionExecuted`
  event, multisig 3/5 gated).
- Owner cancel: `cancel_order` as escape hatch if external dep pauses.

**Does NOT (V1 debt / V2 candidates)**:
- **Multi-venue routing**: Thala-only. R1 had 3 venues, R2 audit deleted
  them as "dead code". V2 primary target is restoring multi-venue. See
  `memory/darbitex_twamm_v2_candidates.md` Candidate J.
- Per-pair oracle deviation config (V2 Candidate D)
- `force_update_oracle` deviation bound (V2 Candidate E)
- Pool-vs-EMA magnitude cross-check before blend (V2 Candidate F)
- `OrderCreated` event for indexer lifecycle tracking (V2 Candidate C)
- `cancel_order` idempotent guard (V2 Candidate G)
- `E_ORDER_EXPIRED` → `E_TIME_NOT_ADVANCED` rename (V2 Candidate I)
- Multi-pair support per single package (V2 Candidate H — requires new package)
- Bounty-based permissionless executor (V2 Candidate A — observability-driven)
- Rate-based continuous orders (V2 Candidate B — Uniswap-V4-style, heavyweight)

## 8. Operational knowledge

### Deployed addresses (reproducible)

```
Package (= multisig):   0x9df06f93369effe15ab626044bbbcb03e6bf198af909ac4c133719e637771cf4
Threshold:              3/5
Owner set:              Pattern A (same 5 as Final core — see DEPLOYMENTS.md)
Keeper:                 0x0047a3e13465172e10661e20b7b618235e9c7e62a365d315e91cf1ef647321c9
Darbitex APT/USDC pool: 0x3837eff0c53a8a23c9f8242267736639945047fe30dce648f939ac08f8ad5811
Thala APT/USDC 5bps:    0xa928222429caf1924c944973c2cd9fc306ec41152ba4de27a001327021a4dff7
Aave flash (0-fee):     0x39ddcd9e1a39fa14f25e3f9ec8a86074d05cc0881cbf667df8a6ee70942016fb
Thala V2 core:          0x7730cd28ee1cdc9e999336cbc430f99e7c44397c0aa77516f6f23a78559bb5
APT metadata:           0xa
USDC (Circle) metadata: 0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b
```

### Keeper tick invariants

- `now > order.last_executed_time` (strict inequality — same-second aborts
  with `E_ORDER_EXPIRED`, semantically misleading, see V2 Candidate I)
- `order.remaining_amount_in > 0`
- `now - oracle.last_timestamp <= 300` (5-min staleness gate). If violated,
  admin must `force_update_oracle` (3/5 multisig).
- Min output = `amount_to_swap * oracle.reserve_out / oracle.reserve_in * 95 / 100`
- Bridge inner fail-fast = `min_out * 90 / 100` (= 85.5% of fair-price implied
  out). Two-gate design: fail fast on catastrophic DEX execution, fail
  holistic on total-delivery-vs-EMA.

### MEV leg trigger condition

`calculate_optimal_borrow` returns > 0 only if Darbitex arb pool price
diverges from oracle (EMA). Formula: `target_in = sqrt(k * oracle_price)`,
borrow = `(target_in - reserve_in) * oracle_price_out/in * 99 / 100 * 50% cap`.

Initialized oracle from same Darbitex pool = no divergence = `borrow = 0`
= MEV leg skipped (happens in V1 smoke; expected).

### Common operational gotchas

1. **Oracle staleness between setup steps**: Allow ≤5 min total between
   `init_ema_from_pool` and first `execute_virtual_order`. Else admin must
   `force_update_oracle` first.
2. **Darbitex pool price must be kept close to real market**: MEV leg
   assumes oracle = pool implied price. If Darbitex pool drifts from market,
   MEV leg attempts aggressive arb against stale oracle → `E_CANT_REPAY`.
3. **Thala stub signatures**: always `diff` `deps/ThalaStub/sources/adapter.move`
   vs live ABI at `0x583d93de::adapter` before touching bridge. ABI drift
   between stub and live is the single most likely source of a future
   E_*-abort bug.
4. **Single-pair per package**: Only ONE `EmaOracle` singleton per TWAMM
   package. For APT/USDC + any other pair you want, spawn a new package
   (new multisig, new deploy). OR ship V2 Candidate H (table-keyed oracles).

### Keeper bot implementation hints

- Keeper needs ≥2 APT in wallet for gas (≤5 APT recommended for headroom).
- Poll cadence: every 30-60s for low-volume pairs, faster for high-volume.
- Before tick: check `oracle.last_timestamp` age via direct resource read.
  If >240s old, admin must refresh first (keeper cannot).
- On `E_ORDER_EXPIRED` error: the order was ticked earlier this second;
  wait 1s and retry.
- On `E_STALE_ORACLE` error: alert admin multisig to `force_update_oracle`.
- On `E_CANT_REPAY`: MEV leg found a phantom arb opportunity. Frequent
  occurrence = signal oracle has drifted from Darbitex pool reality.

## 9. Where to find things

- **Source**: `twamm/sources/{bridge,twamm}.move`
- **Audit trail**: `Audit-R5-Bundle.md` (canonical, source embedded) +
  `audit_report_r3.md` (prior round)
- **Deployments**: `docs/DEPLOYMENTS.md` (canonical address registry)
- **Version history**: `docs/VERSIONS.md`
- **Operator SOP (general)**: `docs/SKILL.md`
- **V2 roadmap**: `/home/rera/.claude/projects/-home-rera/memory/darbitex_twamm_v2_candidates.md`
- **V1 debt / lessons**: this file

## 10. One-line TL;DR for fast pickup

> TWAMM v0.1.1 is LIVE at `0x9df06f93...` on Aptos mainnet under a 3/5
> multisig, Thala-only MEV, 7-auditor green, smoke-verified — and the
> first V2 upgrade must restore multi-venue routing (Hyperion + Cellana)
> that R2 audit accidentally deleted.
