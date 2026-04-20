# Antigravity / Darbitex Final — Operator Skill Guide

This document is the operational playbook for any AI (or human) operator
working on the Antigravity repo (`/home/rera/antigravity/final/`).
Read this *before* you touch Move code, frontend, or Walrus.

It encodes the hard-won SOPs from Darbitex Beta + Final across ~40 mainnet
deploys. Deviations are allowed only with an explicit, stated reason —
not out of convenience.

---

## 0. Repo orientation (2 minutes)

```
final/
├── sources/              Core Move package (pool, pool_factory, arbitrage)
├── flashbot/             Satellite — user-facing flash-arb (Thala/Hyperion/Cellana)
├── twamm/                Satellite — TWAMM executor + internal MEV bridge
├── lp-locker/            Satellite — LP lock/claim/redeem
├── staking/              Satellite — agnostic LP staking factory
├── token-factory/        Satellite — FROZEN, 1 token issued (DARBITEX)
├── token-vault/          Satellite — V2, FROZEN
├── testnet-fixture/      Throwaway Move package for testnet runs only
├── frontend/             React/Vite/ts-sdk v6 dApp → darbitex.wal.app
├── docs/                 Audits, deployments, versions, this file
└── Move.toml             Core package manifest
```

Every satellite has its own `Move.toml`, its own multisig, its own version,
its own `VERSIONS.md` entry. Do not mix them.

**Package boundary note.** `twamm/` publishes **two** modules: `bridge` and
`executor`. Bridge is `public(friend)`-restricted to executor — Aptos Move
requires friend modules to live at the same address, so the MEV composer
cannot be hosted in the flashbot package even though the logic is
flash-arb shaped. The standalone `flashbot::run_arb*` functions remain in
the flashbot package; they are unrelated user-facing arb primitives and
do not share code with `bridge`.

**Canonical registry:** `docs/DEPLOYMENTS.md` — single source of truth
for every package address + multisig. Always consult this first before
researching any address.

---

## 1. Cardinal rules (non-negotiable)

1. **Never hot-wallet deploy to mainnet.** Publisher must be a multisig.
2. **Always use profile `final` (hot wallet `0x0047a3e1...`) as the proposer**
   for new multisigs. Swap `0x85d1e4...` out of the owner set where
   possible (wallet separation from Treasury).
3. **Features go in satellites, not in core.** Core upgrades are reserved
   for security and compatibility fixes only.
4. **Every Move deploy is preceded by a structured self-audit.**
   Compile-green is not enough. See §3.
5. **Every upgrade bumps `Move.toml` version, appends `docs/VERSIONS.md`,
   and creates a git tag `vX.Y.Z`.** No exceptions.
6. **Frontend deploy uses `site-builder update`, never `publish`.**
   The SuiNS record `darbitex.sui` is bound to one specific site object.
7. **No AI-attribution, version markers, audit-trail comments, or
   historical annotations in source.** Source stays clean; history lives
   in git + `VERSIONS.md`.
8. **Always verify token decimals on-chain before computing pool math.**
   Fetching `CoinInfo` / `fungible_asset::decimals` once costs nothing
   and prevents six-figure-decimal errors.

---

## 2. Account profiles

```
profile    address                                                              role
final      0x0047a3e13465172e10661e20b7b618235e9c7e62a365d315e91cf1ef647321c9   NEW deploys proposer
beta       0x85d1e4047bde5c02b1915e5677b44ff5a6ba13452184d794da4658a4814efd30   LEGACY — migrating out
```

`aptos config show-profiles` to list. `aptos init --profile <name>` to add.
Mainnet RPC in every profile: `https://api.mainnet.aptoslabs.com/v1`.
Testnet RPC: `https://api.testnet.aptoslabs.com/v1`.

---

## 3. Move satellite deploy — mainnet SOP

This is the *only* approved path to mainnet. Follow all 10 steps in order.

### Phase A — Pre-publish (local)

**Step 1. Structured self-audit.**
For the package you are about to publish, write a checklist-driven
self-audit covering:

- **ABI**: every `public` / `public(friend)` / `entry` signature —
  are parameter types primitive-friendly for the TS SDK? (see §6)
- **Args**: all `assert!`s at function entry; are error codes unique
  and documented?
- **Math**: overflow paths, rounding direction, u64→u128→u256 casts,
  division-by-zero, integer-division precision loss (multiply *before*
  divide when possible).
- **Reentrancy**: any external call between state-read and state-write?
  Move's type system catches most of this, but check cross-package
  `friend` calls.
- **Edge cases**: zero amounts, identical in/out tokens, expired
  deadlines, stale oracles, empty vectors, duplicate resources.
- **Interactions**: every `public(friend)` / `friend`-declared caller —
  is the trust boundary correct?
- **Errors**: every assert has a unique `E_*` constant, no dead constants.
- **Events**: every user-visible state change emits an event. No PII
  in event payloads.

Save this as `docs/audit_report_<satellite>_<round>.md`. Example of good
format: `docs/audit_report.md`, `docs/audit_report_r3.md`.

**Step 2. External audit pass.**
At minimum one additional AI auditor should review the self-audit +
diff. Document fix rounds as `docs/audit_report_<satellite>_r<N>.md`.
Do not ship on a single auditor's sign-off.

**Step 3. Compile clean.**

```bash
aptos move compile --package-dir <satellite>/ --named-addresses <addr_alias>=<placeholder>
```

Zero warnings. Zero `unused` warnings. Zero deprecation warnings.

**Step 4. Unit tests + testnet smoke.**

```bash
aptos move test --package-dir <satellite>/
```

Then deploy to testnet (§4) and run an integration test with heterogeneous
decimals (6-dec + 8-dec minimum) at something close to market rate.
Unit tests with same-decimal synthetic tokens will miss design-level
blockers. This is mandatory — do not skip it.

**Step 5. Version bump + changelog.**

- Edit the satellite's `Move.toml`: `version = "X.Y.Z"`.
- Append a block to `docs/VERSIONS.md` with: date, package, version,
  sha256 of `build/<pkg>/package-metadata.bcs`, commit hash.
- `git tag v<X.Y.Z>-<satellite>` after the publish tx lands.

### Phase B — Publish (mainnet)

**Step 6. Bootstrap publish from a 1/5 multisig.**

The publisher must be a 1/5 multisig owned *by your proposer only*
(profile `final`). Do not publish from a hot wallet; a hot-wallet
`publish` creates an orphan package that cannot be migrated to a
multisig later. See the orphan Disperse case in `DEPLOYMENTS.md:147`.

```bash
aptos multisig create --additional-owners <addr1,...> --num-signatures-required 1 \
  --profile final
```

Then build package metadata + propose publish:

```bash
aptos move build-publish-payload --json-output-file payload.json \
  --package-dir <satellite>/ --named-addresses <addr_alias>=<multisig_addr>

aptos multisig create-transaction --multisig-address <multisig_addr> \
  --json-file payload.json --profile final
aptos multisig execute --multisig-address <multisig_addr> --profile final
```

**Step 7. Smoke-test with real params on mainnet.**

Before doing anything else, run the golden-path integration with a
real heterogeneous-decimal token pair and market-rate amounts.
Verify all events emitted, balances correct, profit paths functioning.

If smoke fails, do not attempt an upgrade to "hide" the bug — redeploy
from scratch at a fresh address and deprecate the broken one.

**Step 8. Raise multisig to 3/5.**

Add the remaining 4 owners, flip `num_signatures_required` to 3.
This is the production threshold for all Darbitex core + satellite
multisigs. Five canonical owners: see `DEPLOYMENTS.md:22-29`.

**Step 9. (Optional, conditional) Freeze to immutable.**

If the satellite is feature-complete and you want to burn future upgrade
rights for trust reasons (e.g., token-factory, token-vault-v2), propose
a `set_upgrade_policy` to `immutable` through the 3/5 multisig.

**Warning**: immutable is forever. Do not freeze a satellite with a
known outstanding bug or a pending audit finding. Once frozen, a bug
fix requires a full redeploy at a new address + migration.

**Step 10. Update `docs/DEPLOYMENTS.md`.**

Add the new satellite with: package address, threshold, upgrade policy,
module list, owners if new set. Commit + push.

---

## 4. Move satellite deploy — testnet SOP

Testnet is a throwaway playground. Rules are relaxed.

- Use the hot wallet as publisher (`profile final`). No multisig needed.
- Use `testnet-fixture/` for throwaway modules that should not pollute
  the main package tree.
- **Do not** reuse mainnet addresses as named-address placeholders —
  use `_` or a fresh testnet-only address. An address leak between
  environments has ended worse than the original bug it was hiding.
- Drop test fixtures from the tree before mainnet publish.

Typical flow:

```bash
aptos init --profile testnet --network testnet
aptos account fund-with-faucet --profile testnet
aptos move publish --package-dir <satellite>/ \
  --named-addresses <addr_alias>=<testnet_addr> \
  --profile testnet
```

---

## 5. Upgrade SOP (existing package)

When a compatible upgrade is actually safe:

1. Bump `Move.toml` version.
2. Run the full Phase A checklist (§3 steps 1–5) on the diff.
3. Build payload, propose via the existing 3/5 multisig, gather 3 signatures.
4. Execute.
5. Smoke-test the upgraded path on mainnet with small amounts.
6. Append to `docs/VERSIONS.md`, git tag, push.

**Prefer lean upgrades**: when a package is compat-locked and a feature
cannot be added without breaking the storage layout, do *not* redeploy
the package at a new address. Instead, deprecate the target function's
body (abort with `E_DEPRECATED(999)`) and ship a new sibling module
in the same package. This preserves the package address and its
callers' imports. See the `disperse` orphan neutering pattern
(`DEPLOYMENTS.md:147`) for reference.

---

## 6. Satellite design rules

- **Aave flash loan is the standard arb pattern.**
  Every arb satellite follows:
  `flash_borrow → swap → swap → repay → profit split`.
  Aave is 0-fee on Aptos — no exceptions, no cheaper alternatives.
- **Every new user-swap venue after the fourth (Cellana) ships in its
  own satellite**, not in the aggregator. The monolithic aggregator
  is frozen at 4 venues (Darbitex, Hyperion, Cellana, Thala-via-adapter).
  LiquidSwap + future venues live in their own satellites.
- **Pure-frontend venues are a liability.** The TS SDK validator
  rejects `Option<T>`, generics, and non-primitive struct parameters
  at signing time, even when the on-chain function accepts them.
  For any venue whose entry function takes anything beyond
  `address/u64/bool/vector<u8>`, wrap it in a thin adapter satellite
  (`<venue>_adapter::adapter::swap(...)`) that exposes a primitive-only
  signature to the frontend. See `darbitex_thala_adapter`.
- **3rd-party Move dependencies must be cross-checked.**
  Upstream GitHub source routinely omits struct getters and
  post-launch variants that do exist on-chain. Before vendoring an
  interface package, diff the GitHub source against the live on-chain
  ABI (`aptos account list --query modules`) and patch locally.

---

## 7. Frontend update SOP

Frontend lives in `final/frontend/` (React 18 + Vite + `@aptos-labs/ts-sdk`
v6). Live at `https://darbitex.wal.app`. Walrus-hosted, SuiNS-resolved.

### Pre-deploy checklist

1. `cd final/frontend`
2. Update deploy-state if you changed it:
   - `src/config/addresses.ts` — package addresses must match
     `docs/DEPLOYMENTS.md` exactly.
   - `src/config/tokens.ts` — any new FA must have symbol, decimals,
     icon URL, address. Always re-verify decimals via `CoinInfo` first.
3. RPC wiring: default to **Geomi** (Aptos Labs dev portal) for
   frontend calls. Geomi supports origin-domain-restricted API keys,
   so keys can ship in the frontend bundle safely. $10/mo free credit
   ≈ 8M calls. Do not use the public `api.mainnet.aptoslabs.com` RPC
   as the primary — per-IP rate limits will tank the site.
4. `npm run build` — fix any type errors. Do not ship with `--skipLibCheck`
   as a permanent mitigation.
5. Open `dist/index.html` in a browser (`npx serve dist`) and smoke-test
   every user-visible page, including wallet connect + one real
   transaction on each feature page.

### Walrus deploy

See `frontend/docs/walrus-quilts.md` for the canonical per-deploy recipe.
Summary of the mandatory steps:

```bash
# 1. Build (already done above, but re-run if anything changed)
npm run build

# 2. UPDATE the existing site object — never publish a new one
#    Site ID is bound to the SuiNS darbitex.sui record; a new publish
#    would orphan the domain.
site-builder update --epochs 5 dist \
  0x55103b69b54462f9efc7f58c3c6d134702662a7112e3e4e418bea13cf08163b4

# 3. Verify new resource → blob mapping
site-builder sitemap 0x55103b69b54462f9efc7f58c3c6d134702662a7112e3e4e418bea13cf08163b4

# 4. Find any newly-created OWNED blobs
walrus --context mainnet list-blobs

# 5. Share EACH new owned blob
walrus --context mainnet share --blob-obj-id <id>

# 6. Verify the owned-blob list is empty
walrus --context mainnet list-blobs

# 7. Record in frontend/docs/walrus-quilts.md:
#    - New shared object ID + blob ID + size + expiration epoch
#    - Mark superseded quilts as orphaned (leave to expire, do not burn)

# 8. git commit + push — the quilts table on main must match chain state
```

### Walrus — hard rules

- **`--epochs 5`** is the default while frontend is iterating.
  Longer leases waste WAL on blobs that will be orphaned within days.
- **Never `site-builder destroy`.** It burns every blob the site
  references, including shared blobs owned by nobody — which means
  other sites sharing them lose their data too. Verify this risk,
  then destroy individually via `walrus burn-blobs` only for orphans
  that never reached `share`.
- **Shared blobs cannot be burned.** They must be left to expire.
  This is by design; the alternative (burnable shared blobs) would
  allow a malicious co-owner to rug other sites.
- **Always dry-run SuiNS `set_user_data` calls.** Cost is minimal
  (~0.0016 SUI) but an arg error can repoint `darbitex.sui` to a
  stale or malicious object.
- **Fund + extend is a two-step flow for shared blobs.**
  `walrus fund-shared-blob <id> <amount>` deposits WAL into the
  blob's pool. `walrus extend --shared --blob-obj-id <id> --epochs N`
  consumes from the pool to extend. They are permissionless (anyone
  can fund; anyone can extend once funded).

### SuiNS recovery

If `darbitex.sui` ever points at a stale or wrong object, the recovery
recipe is in `frontend/docs/walrus-quilts.md:75-99`. The SuiNS
registration NFT `0x1700cba4...9d719` is held by the operational wallet
`0x6915bc38...3304`. Losing either would break the recovery path —
back them up separately.

---

## 8. Pitfalls to not rediscover

Every entry below has already cost hours or dollars.

- **Fake spread from aggregators**: GeckoTerminal / DexScreener routinely
  inflate spreads for dormant pools. Verify on-chain reserves directly
  before trusting a quoted arb opportunity.
- **`drain` is a loaded word**: do not use it for a user withdrawing
  their own assets — reserve it for adversarial scenarios only.
- **Memory records go stale**: if a memory says "package X is
  permissionless", re-simulate the call before acting on it. Module
  scan + activity scan + live sim; all three must agree.
- **Walrus destroy burns shared blobs**: see above. The destructive
  blast radius here is worse than `rm -rf` on a shared filesystem.
- **`-uall` on `git status`**: causes memory issues on large repos.
  Use plain `git status`.
- **`git push --force` to main**: never, even for your own branch.
  Ask first.
- **Publishing as hot wallet instead of multisig**: creates an orphan
  package that cannot become a multisig publisher afterwards. Only
  redeploy + deprecate-old is possible. See `DEPLOYMENTS.md:147`.
- **Same-decimal unit tests passing, mainnet failing**: unit tests
  use synthetic tokens with identical decimals; real pairs have
  6-dec USDC and 8-dec SUI/APT. Mandatory smoke test at §3 step 4
  catches this.
- **Treating a memory-stated address as current**: a memory that names
  a path/function/flag is a claim it existed *when written*. It may
  have been renamed, removed, or never merged. Verify with `grep`
  or an explorer before recommending it.

---

## 9. Quick-reference commands

### Move

```bash
# Compile
aptos move compile --package-dir <sat>/ --named-addresses <alias>=<addr>

# Test
aptos move test --package-dir <sat>/

# Build payload for multisig publish
aptos move build-publish-payload --json-output-file payload.json \
  --package-dir <sat>/ --named-addresses <alias>=<multisig_addr>

# Propose
aptos multisig create-transaction --multisig-address <ms> \
  --json-file payload.json --profile final

# Execute
aptos multisig execute --multisig-address <ms> --profile final

# View fn call (read-only, no gas)
aptos move view --function-id <addr>::<mod>::<fn> --args <args>

# View on-chain ABI
aptos account list --query modules --account <addr>
```

### Frontend / Walrus

```bash
# Build
cd frontend && npm run build

# Deploy update
site-builder update --epochs 5 dist 0x55103b69b54462f9efc7f58c3c6d134702662a7112e3e4e418bea13cf08163b4

# Verify
site-builder sitemap 0x55103b69b54462f9efc7f58c3c6d134702662a7112e3e4e418bea13cf08163b4
walrus --context mainnet list-blobs

# Share newly-owned blobs
walrus --context mainnet share --blob-obj-id <id>

# Extend expiring shared blob
walrus --context mainnet fund-shared-blob <id> <amount_wal>
walrus --context mainnet extend --shared --blob-obj-id <id> --epochs <N>
```

---

## 10. When in doubt

- Check `docs/DEPLOYMENTS.md` first for addresses.
- Check `docs/VERSIONS.md` for what version is live.
- Check `frontend/docs/walrus-quilts.md` for what blob backs the live site.
- Check the most recent `docs/audit_report*.md` for what's been reviewed.
- Do not guess addresses, upgrade policies, or multisig thresholds.
- Do not take an action whose blast radius you cannot undo.
- Ask before: force-pushing, deleting on-chain resources, freezing a
  package to immutable, transferring the SuiNS NFT, calling
  `site-builder destroy`, dropping a mainnet multisig threshold.

Everything else — editing Move source, running tests, publishing to
testnet, updating the frontend bundle on Walrus — is reversible and
does not need a confirmation round.
