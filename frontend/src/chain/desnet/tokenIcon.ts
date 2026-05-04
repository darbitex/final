import { useEffect, useState } from "react";
import { fetchFaMetadata } from "../balance";
import { TOKENS } from "../../config";

export type TokenView = {
  symbol: string;
  /// Either a bundled relative path (`/tokens/...`) or an on-chain `icon_uri`.
  /// The TokenIcon component falls back to a letter badge if the URL fails to load.
  icon?: string;
};

const APT_TOKEN: TokenView = { symbol: "APT", icon: "/tokens/apt.svg" };

/// Synchronously resolve from the bundled whitelist, so the common case
/// (DESNET, USDC, …) renders with its curated SVG on the very first
/// paint. Returns null when the addr isn't whitelisted (caller falls back
/// to the on-chain metadata fetch).
function whitelistView(metaAddr: string | null): TokenView | null {
  if (!metaAddr) return null;
  const lower = metaAddr.toLowerCase();
  for (const t of Object.values(TOKENS)) {
    if (t.meta.toLowerCase() === lower) {
      return { symbol: t.symbol, icon: t.icon };
    }
  }
  return null;
}

/// Resolve a $TOKEN view from its FA metadata addr. First checks the bundled
/// TOKENS whitelist (so DESNET, DARBITEX, USDC etc. always render their
/// curated SVGs), then falls back to the on-chain `Metadata.icon_uri` set
/// by the token's creator at register_handle time.
export function useTokenView(metaAddr: string | null): TokenView {
  // Whitelist hit is resolved synchronously — same render, no flicker.
  const initial = whitelistView(metaAddr) ?? { symbol: "?" };
  const [view, setView] = useState<TokenView>(initial);

  useEffect(() => {
    let cancelled = false;
    if (!metaAddr) {
      setView({ symbol: "?" });
      return;
    }
    const hit = whitelistView(metaAddr);
    if (hit) {
      setView(hit);
      return;
    }
    // Not whitelisted — fall through to the on-chain metadata fetch (cached).
    fetchFaMetadata(metaAddr).then((m) => {
      if (cancelled || !m) return;
      setView({ symbol: m.symbol, icon: m.iconUri });
    });

    return () => {
      cancelled = true;
    };
  }, [metaAddr]);

  return view;
}

export const APT_VIEW = APT_TOKEN;
