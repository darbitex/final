# TWAMM v0.2.0 — Multisig Upgrade Signing Guide

**Target package**: `0x9df06f93369effe15ab626044bbbcb03e6bf198af909ac4c133719e637771cf4`
**Multisig**: 3/5 (Pattern A owners)
**Upgrade policy**: `compatible` (no storage breaking changes)
**Payload**: `twamm-v0.2.0-upgrade.json` (at repo root, 26 KB)
**Prepared**: 2026-04-20 by Claude Opus 4.7
**Self-audit**: GREEN (see TWAMM-DEPLOY-LOG.md + this doc §3)

---

## 1. What v0.2.0 changes

All changes are small, local, and bounded. None of them touch storage layout
— safe compatible upgrade.

### Features added

1. **Auto-refresh stale oracle inside `execute_virtual_order`**
   — if oracle age > `MAX_ORACLE_AGE` (300s), the tick itself reads
   `darbitex_arb_pool` reserves (same pool already used for MEV calc)
   and resets the oracle atomically, then proceeds with the tick.
   Keeper whitelist is the trust gate — same as any other tick. No
   new attacker surface, no 3/5 multisig coordination needed for stale
   recovery.

   Earlier iteration considered a standalone permissionless
   `refresh_oracle_from_pool` entry; **rejected** because arbitrary
   caller supplying wrong-pair pool opens a DDoS vector. In the
   integrated form, pool comes from the whitelisted keeper's own
   execute call, so the trust boundary stays at keeper whitelist.

2. **`MIN_SWAP_FOR_EMA` threshold removed**
   — previously only trades ≥ 1,000,000 octas (0.01 APT) would blend the
   EMA. Now every successful tick blends 10% of pool reserves into the
   oracle. Sufficient bounds: `ratio_ok` 5× gate + 10% smoothing + keeper
   whitelist + gas cost per trade. Unlocks small-chunk TWAMM orders
   (0.00001 APT/tick) keeping oracle fresh organically.

3. **`OrderCreated` event** — indexer lifecycle completeness.

4. **`OracleRefreshed` event** — emitted when the auto-refresh branch
   inside `execute_virtual_order` fires. Captures keeper address, pool
   used, new reserves, timestamp.

5. **`cancel_order` idempotent guard** — now aborts `E_NO_ORDER` if order
   is already finished/cancelled, instead of silently no-op'ing.

6. **`E_ORDER_EXPIRED` renamed to `E_TIME_NOT_ADVANCED`** (value 2 preserved
   for indexer backward compat). The old name was misleading for the
   same-second-collision case.

### Errors removed

- `E_STALE_ORACLE` (value 5) — removed because stale oracle can no longer
  abort a tick (auto-refresh handles it). Numbering keeps a gap at 5; no
  issue because error codes don't need to be contiguous.

### No changes to

- Storage layout (LongTermOrder, EmaOracle, AdminState structs unchanged)
- Existing entry function signatures
- Access control (multisig still 3/5, keeper whitelist unchanged)
- Math / bridge MEV logic
- Thala / Aave integration

---

## 2. Self-audit 8-dim (by Claude Opus 4.7, 2026-04-20)

| Dim | Verdict |
|-----|---------|
| ABI | ✓ New entry primitive-friendly, events additive |
| Args | ✓ `refresh_oracle_from_pool` pool_exists + stale + reserves>0 asserts |
| Math | ✓ No new math; removing MIN_SWAP_FOR_EMA bounded by existing ratio_ok + smoothing |
| Reentrancy | ✓ Single mut borrow, read-only pool views, no callbacks |
| Edges | ✓ Stale-only guard, non-stale → abort E_NOT_STALE |
| Interactions | ✓ Cross-package reads same as `init_ema_from_pool` (trusted) |
| Errors | ✓ 11 codes, all used |
| Events | ✓ OrderCreated + OracleRefreshed additive |

**DDoS vector closed**: earlier draft exposed `refresh_oracle_from_pool`
as a standalone permissionless entry. User correctly flagged that an
arbitrary caller supplying a wrong-pair pool every 5 minutes could
sustain oracle corruption and grief every TWAMM tick for the cost of gas.
Revised design folds the refresh into `execute_virtual_order` where the
keeper whitelist already gates who can trigger, and the pool address
comes from the whitelisted keeper's own execute call (same pool they're
using for the MEV calc and the 10% blend). No standalone entry; no new
attacker surface.

**External audit**: not run for this upgrade. Rationale: changes are
small (~30 lines diff), local, additive, and all with bounded safety
properties. Same-day compatible upgrade in response to operational
blocker (oracle-stale coordination bottleneck). A full R6 audit round
was judged disproportionate to the risk. Revisit audit policy if V2
features beyond this one (e.g. Candidate J multi-venue) are bundled.

---

## 3. Multisig signing — step-by-step

### Setup for each signer

Each of the three co-signers must have their own `aptos` CLI profile
loaded with their owner private key. The profile can be any name —
e.g. the 5 canonical profile names for Pattern A owners might be
`final`, `owner-13f`, `owner-f6e`, `owner-c25`, `owner-a11`.

You will need at minimum the `final` profile (which is the proposer —
already set up on this machine) plus **two** other owner profiles.

### Step 1 — propose (any ONE owner)

This registers the upgrade as pending in the multisig queue. Any single
owner can propose. Recommended: use `final`.

```bash
cd /home/rera/antigravity/final

aptos multisig create-transaction \
  --multisig-address 0x9df06f93369effe15ab626044bbbcb03e6bf198af909ac4c133719e637771cf4 \
  --json-file twamm-v0.2.0-upgrade.json \
  --profile final
```

This submits an on-chain "proposal" tx. Note the `sequence_number` of
the proposed multisig tx (should be 4 given the current sequence after
prior multisig txs). Gas cost: ~0.005 APT.

### Step 2 — second signer approves

The second owner opens their own CLI session on their own machine (with
their own private key) and runs:

```bash
aptos multisig approve \
  --multisig-address 0x9df06f93369effe15ab626044bbbcb03e6bf198af909ac4c133719e637771cf4 \
  --sequence-number <the_number_from_step_1> \
  --profile <their_owner_profile>
```

Gas cost: ~0.001 APT.

### Step 3 — third signer approves

Same as Step 2, from a different owner.

### Step 4 — execute (any signer who approved)

Once ≥ 3 signatures are on the tx, any of the signers can trigger
execution:

```bash
aptos multisig execute \
  --multisig-address 0x9df06f93369effe15ab626044bbbcb03e6bf198af909ac4c133719e637771cf4 \
  --profile <any_approved_owner> \
  --max-gas 100000
```

Gas cost for executing the upgrade: ~0.007 APT (same as v0.1.0/v0.1.1
publish cost).

### Step 5 — verify

```bash
aptos move view --profile final \
  --function-id 0x1::code::package_registry_exists \
  --args address:0x9df06f93369effe15ab626044bbbcb03e6bf198af909ac4c133719e637771cf4
```

(Should already return true since v0.1.1 is published.)

Confirm upgrade by testing `execute_virtual_order` on a fresh TWAMM
order. If the tick succeeds when oracle is stale (instead of aborting
E_STALE_ORACLE), the auto-refresh branch is live. Smoke script:

```bash
# Pre-check oracle age
curl -sL "https://fullnode.mainnet.aptoslabs.com/v1/accounts/0x9df06f93...`.../resource/0x9df06f93.../executor::EmaOracle" \
  | python3 -c "import json,sys,time; d=json.load(sys.stdin); print('age', int(time.time())-int(d['data']['last_timestamp']), 's')"

# If age > 300s, create a small order and tick it. The tick succeeding
# (instead of aborting E_STALE_ORACLE / code 5) proves v0.2.0 auto-refresh
# is live.
```

---

## 4. Post-upgrade verification

1. `EmaOracle` struct unchanged → existing oracle state preserved across
   upgrade. No re-init needed.
2. All existing orders remain live. `cancel_order` works as before,
   except now aborts cleanly on double-cancel.
3. Keeper bot can run TWAMM orders with any chunk size — small-chunk
   orders will keep oracle fresh via auto-blend.
4. If oracle does go stale (e.g. no TWAMM activity for 5 min), anyone
   can call `refresh_oracle_from_pool` to reset. No more 3/5 coordination
   needed for stale recovery.

---

## 5. Rollback plan

If post-upgrade smoke reveals an issue, do another compatible upgrade
back to v0.1.1 logic. No storage changes means rollback is trivial —
just rebuild old source, propose + 3-sign + execute.

---

## 6. Artifacts

- **Source diff vs v0.1.1**: `twamm/sources/twamm.move` (add new entry,
  remove MIN_SWAP_FOR_EMA, add events, rename E_ORDER_EXPIRED)
- **Compiled package**: rebuild locally via
  `cd twamm/ && aptos move compile --named-addresses darbitex_twamm=0x9df06f93... --skip-fetch-latest-git-deps`
- **Upgrade payload**: `twamm-v0.2.0-upgrade.json` at repo root (checked
  into git). Any signer can use this exact payload in Step 1.

---

## 7. Contact for questions

Read `docs/TWAMM-DEPLOY-LOG.md` §0 (NORTH STAR) before any change.
V2 candidate roadmap: `docs/darbitex_twamm_v2_candidates.md`.
