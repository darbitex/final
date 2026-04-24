import { NavLink, Outlet } from "react-router-dom";

export function Earn() {
  return (
    <div className="container">
      <h1 className="page-title">Earn</h1>
      <div className="subnav">
        <NavLink end to="/earn/vault">Vault</NavLink>
        <NavLink to="/earn/staking">Staking</NavLink>
      </div>
      <Outlet />
    </div>
  );
}
