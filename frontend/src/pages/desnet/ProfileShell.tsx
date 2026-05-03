import { NavLink, Outlet, useParams } from "react-router-dom";

export function ProfileShell() {
  const { handle } = useParams<{ handle: string }>();
  const safe = (handle ?? "").toLowerCase();
  return (
    <div className="container">
      <h1 className="page-title">@{safe}</h1>
      <div className="subnav">
        <NavLink end to={`/desnet/p/${safe}`}>Profile</NavLink>
        <NavLink to={`/desnet/p/${safe}/post`}>Post</NavLink>
        <NavLink to={`/desnet/p/${safe}/about`}>About</NavLink>
      </div>
      <Outlet />
    </div>
  );
}
