// Mockup only: every icon the UI uses, as drawn by each candidate set.
import { createRoot } from "react-dom/client";
import type { ComponentType } from "react";
import * as L from "./lucide.js";
import * as P from "./phosphor.js";
import * as T from "./tabler.js";
import "../../src/globals.css";
import type { ReactNode } from "react";
import { FiUser, FiZap } from "react-icons/fi";
import { SiGithub } from "react-icons/si";
import { FaSlack, FaTerminal } from "react-icons/fa";

const NOW: Record<string, ReactNode> = {
  Menu: "☰", PictureInPicture2: "⧉", PanelRight: "⚑", Settings: "⚙", ScooterMark: "🛴", Star: "☆", StarFilled: "★",
  Lock: "🔒", LockOpen: "🔓", Pencil: "✎", Trash2: "🗑", TriangleAlert: "⚠", X: "× ✕", RotateCw: "↻",
  ChevronDown: "▾ ▼", ChevronUp: "▲", ChevronRight: "▸ ›", ChevronLeft: "‹", ExternalLink: "↗", ArrowLeft: "←",
  Check: "✓", Link: "🔗", CornerDownRight: "↳", Plus: "＋", User: <FiUser />, Zap: <FiZap />,
  GithubMark: <SiGithub />, SlackMark: <FaSlack color="#E01E5A" />, SquareTerminal: <FaTerminal />, Bot: "▸",
};
const names = [...Object.keys(NOW), ...Object.keys(L).filter((k) => k in P && k in T && !(k in NOW))]
  .filter((k, i, a) => a.indexOf(k) === i && k in P && k in T);
const sets = { Lucide: L, Phosphor: P, Tabler: T } as Record<string, Record<string, unknown>>;

function Cell({ Icon }: { Icon: unknown }) {
  const C = Icon as ComponentType<{ className?: string; size?: number }>;
  return <td className="px-4 py-1.5 text-center"><span className="inline-flex"><C size={22} className="size-[22px]" /></span></td>;
}

function Gallery({ subset }: { subset: string[] }) {
  return (
    <table className="text-sm">
      <thead><tr className="text-muted-foreground"><th className="px-3 text-left">name</th><th className="px-4">today</th>{Object.keys(sets).map((s) => <th key={s} className="px-4">{s}</th>)}</tr></thead>
      <tbody>
        {subset.map((n) => (
          <tr key={n} className="border-t">
            <td className="px-3 font-mono text-xs">{n}</td>
            <td className="px-4 text-center text-lg"><span className="inline-flex">{NOW[n] ?? <span className="text-xs text-muted-foreground">lucide</span>}</span></td>
            {Object.values(sets).map((s, i) => <Cell key={i} Icon={s[n]} />)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const replaced = names.filter((n) => n in NOW);
const rest = names.filter((n) => !(n in NOW));
const mode = new URLSearchParams(location.search).get("part");
createRoot(document.getElementById("root")!).render(
  <div className="bg-background p-6 text-foreground">
    <h1 className="mb-1 text-lg font-semibold">{mode === "rest" ? "Already-Lucide icons, redrawn" : "Emoji / glyph / react-icons replacements"}</h1>
    <Gallery subset={mode === "rest" ? rest : replaced} />
  </div>,
);
