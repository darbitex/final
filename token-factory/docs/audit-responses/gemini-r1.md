# Gemini 2.5 Pro — Token Factory R1 audit response

**Date:** 2026-04-16
**Verdict:** 🟢 **GREEN**
**Severity counts:** 0 HIGH / 1 MEDIUM (byte-vs-char fee tier) / 1 LOW / 1 INFO

**NOTE:** First response was the one above from Grok (mislabeled as Gemini). Actual Gemini response is below.

---

## Findings

### MEDIUM-1: Fee tier bypass via multi-byte UTF-8 encoding

**Location:** `token.move:113` (`creation_fee` + line 65)

**Description:** `vector::length(&symbol)` counts BYTES, not UTF-8 characters. A visually 1-character emoji like `🔥` is 4 bytes → charged 1 APT instead of 1000 APT. Bypasses the premium pricing for short visual symbols.

**Impact:** Economic model bypass for non-ASCII symbols. Squatting premium visual symbols at lower tiers.

**Recommended fix:** Restrict symbols to ASCII range (where 1 byte = 1 character), or implement UTF-8 code point counting.

### LOW-1: Misleading error code — E_NOT_INIT used for deployer auth check

**Location:** `token.move:45`

### INFORMATIONAL-1: Symbol spoofing via homoglyphs / leading spaces

**Location:** `token.move:69` — byte-level uniqueness means `"APT"` vs `" APT"` vs Cyrillic-P variants are all different symbols. Permissionless factory = off-chain responsibility to flag.

## Design questions — all 5 confirmed

- D-1 MintRef drop: **provably permanent**
- D-2 BurnCap isolation: **highly isolated**
- D-3 Fee refund on abort: **confirmed** (atomic rollback)
- D-4 Tiered pricing: **mathematically sound BUT byte-based** (see MEDIUM-1)
- D-5 No token count: **acceptable** (anti-pattern to track on-chain)

## Verdict: 🟢 GREEN (conditional on addressing byte-vs-char pricing)
