import {
  Archive,
  BookOpen,
  Bot,
  Briefcase,
  Bug,
  Calendar,
  ChartColumn,
  Cloud,
  Code,
  Database,
  FlaskConical,
  Folder as FolderIcon,
  Globe,
  Heart,
  House,
  Lightbulb,
  Lock,
  NotebookPen,
  Palette,
  Rocket,
  Server,
  Star,
  Terminal,
  Users,
  Wrench,
  Zap,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";

/** Folder icons, keyed by the Lucide name the router stores. */
export const FOLDER_ICONS: Record<string, LucideIcon> = {
  briefcase: Briefcase,
  house: House,
  "chart-column": ChartColumn,
  "flask-conical": FlaskConical,
  bug: Bug,
  rocket: Rocket,
  wrench: Wrench,
  "book-open": BookOpen,
  lightbulb: Lightbulb,
  palette: Palette,
  lock: Lock,
  cloud: Cloud,
  bot: Bot,
  "notebook-pen": NotebookPen,
  code: Code,
  terminal: Terminal,
  server: Server,
  database: Database,
  globe: Globe,
  users: Users,
  calendar: Calendar,
  heart: Heart,
  zap: Zap,
  archive: Archive,
};

/** A folder's icon: Starred's star, its chosen icon, else the folder glyph. */
export function FolderGlyph({ starred, icon, className }: { starred: boolean; icon?: string; className?: string }) {
  if (starred) return <Star fill="currentColor" className={cn("size-3.5 shrink-0 text-warning", className)} aria-hidden />;
  // Unknown names, say from a newer UI, get the folder.
  const Icon = (icon && FOLDER_ICONS[icon]) || FolderIcon;
  return <Icon data-testid="folder-icon" data-icon={icon} className={cn("size-3.5 shrink-0", className)} aria-hidden />;
}

/** The grid of folder icons, plus a way back to the plain folder. */
export function IconPicker({ current, onPick }: { current?: string; onPick: (icon: string) => void }) {
  return (
    <div data-testid="folder-icon-picker" className="w-[13.5rem]">
      <div role="group" aria-label="Folder icons" className="grid grid-cols-8 gap-0.5">
        {Object.entries(FOLDER_ICONS).map(([name, Icon]) => (
          <button
            key={name}
            type="button"
            title={name}
            aria-label={`Use the ${name} icon`}
            aria-pressed={name === current}
            onClick={() => onPick(name)}
            className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground aria-pressed:bg-accent aria-pressed:text-foreground"
          >
            <Icon className="size-3.5" aria-hidden />
          </button>
        ))}
      </div>
      {current && (
        <button
          type="button"
          onClick={() => onPick("")}
          className="mt-1.5 flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-start text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <FolderIcon className="size-3.5" aria-hidden /> Use the plain folder
        </button>
      )}
    </div>
  );
}
