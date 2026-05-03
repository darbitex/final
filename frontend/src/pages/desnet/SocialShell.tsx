// SocialShell — DeSNet social section: timeline (own + synced + global) +
// opinion-market list/picker. Sibling to DesnetShell which holds the
// token/protocol primitives (Register, Swap, Liquidity, Portfolio, About).
//
// Top-of-shell pill switcher lets users hop Token ↔ Social without leaving
// the DeSNet area.

import { NavLink, Outlet } from "react-router-dom";

export function DesnetSocialShell() {
  return (
    <div className="container">
      <h1 className="page-title">Social</h1>
      <p className="page-sub">
        On-chain timeline + perpetual opinion markets. Every mint can carry a
        YAY/NAY belief market denominated in the author's own factory token.
      </p>

      {/* Section pill switcher — Token vs Social */}
      <div className="subnav" style={{ marginBottom: 8 }}>
        <NavLink to="/desnet" end style={pillStyle}>
          ← Token
        </NavLink>
        <NavLink to="/desnet/social" end style={{ ...pillStyle, ...activePillStyle }}>
          Social
        </NavLink>
      </div>

      <div className="subnav">
        <NavLink to="/desnet/social/me" end>My Profile</NavLink>
        <NavLink to="/desnet/social/feeds">Feeds</NavLink>
        <NavLink to="/desnet/social/opinion">Opinion</NavLink>
      </div>
      <Outlet />
    </div>
  );
}

const pillStyle: React.CSSProperties = {
  padding: "4px 12px",
  borderRadius: 12,
  border: "1px solid #444",
  textDecoration: "none",
  fontSize: "0.85em",
};

const activePillStyle: React.CSSProperties = {
  background: "#1a4480",
  color: "#fff",
  borderColor: "#1a4480",
};
