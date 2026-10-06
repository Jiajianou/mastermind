import { NavLink } from "react-router";
import { useLive } from "../store/hooks.js";
import { PauseButton } from "./PauseButton.js";
import { RunStatusLink } from "./RunStatusLink.js";

const screens = [
  { path: "/", label: "Chat" },
  { path: "/overview", label: "Overview" },
  { path: "/tasks", label: "Tasks" },
  { path: "/sessions", label: "Sessions" },
  { path: "/review", label: "Review" },
];

export function TopBar() {
  const project = useLive((state) => state.instance?.project ?? null);

  return (
    <header className="top-bar">
      <span className="project-name">{project ?? "mastermind"}</span>
      <nav aria-label="Screens" className="tabs">
        {screens.map(({ path, label }) => (
          <NavLink key={path} to={path} end className="tab">
            {label}
          </NavLink>
        ))}
      </nav>
      <div className="top-bar-end">
        <RunStatusLink />
        <PauseButton />
      </div>
    </header>
  );
}
