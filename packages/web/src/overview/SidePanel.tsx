import type { ReactNode } from "react";

export function SidePanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="side-panel panel" aria-label={title}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}
