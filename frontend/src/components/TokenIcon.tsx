import { useState } from "react";
import type { TokenConfig } from "../config";

type TokenLike = Pick<TokenConfig, "symbol"> & { icon?: string };

/**
 * Token icon renderer with a letter-badge fallback.
 *
 * - Whitelisted tokens ship bundled SVGs via `token.icon = /tokens/*.svg`
 * - Custom FAs pasted by users can pass in a raw URL (from on-chain
 *   `Metadata.icon_uri`) — not guaranteed reachable, so we handle
 *   image-load errors by falling through to the letter badge
 * - Any token without an icon renders a colored dot with the first
 *   one or two letters of the symbol — matches the surrounding
 *   color palette so the UI stays cohesive
 */
export function TokenIcon({
  token,
  size = 18,
  className = "",
}: {
  token: TokenLike;
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const showFallback = !token.icon || failed;

  if (showFallback) {
    const letter = token.symbol.replace(/[^a-zA-Z]/g, "").slice(0, 2).toUpperCase() || "?";
    return (
      <span
        className={`token-icon token-icon-fallback ${className}`}
        style={{
          width: size,
          height: size,
          fontSize: Math.round(size * 0.48),
          lineHeight: `${size}px`,
        }}
        title={token.symbol}
      >
        {letter}
      </span>
    );
  }

  return (
    <img
      className={`token-icon ${className}`}
      src={token.icon}
      alt={token.symbol}
      title={token.symbol}
      width={size}
      height={size}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}
