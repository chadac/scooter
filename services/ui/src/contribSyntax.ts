// Contrib remark plugins and components, loaded before first paint.

import type { ComponentType } from "react";

import type { MarkdownSyntax, MarkdownSyntaxElementProps } from "./contrib/sdk.js";
import { contribMarkdownSyntax } from "./contribManifest.js";
import { contribModuleLoader } from "./contribTabs.js";

type Plugins = NonNullable<MarkdownSyntax["remarkPlugins"]>;
type Components = Record<string, ComponentType<MarkdownSyntaxElementProps>>;

export interface LoadedSyntax {
  remarkPlugins: Plugins;
  components: Components;
}

const EMPTY: LoadedSyntax = { remarkPlugins: [], components: {} };
let loaded: LoadedSyntax = EMPTY;

/** A module's default export, keeping only the declared shape. */
export function acceptSyntax(contrib: string, mod: unknown): LoadedSyntax {
  const def = (mod as { default?: unknown } | null)?.default as MarkdownSyntax | undefined;
  if (!def || typeof def !== "object") return EMPTY;
  const remarkPlugins = Array.isArray(def.remarkPlugins) ? def.remarkPlugins : [];
  const components: Components = {};
  for (const [tag, C] of Object.entries(def.components ?? {})) {
    // A contrib draws only its own elements, never links.
    if (tag.startsWith(`${contrib}-`) && typeof C === "function") components[tag] = C;
    else console.warn(`contrib ${contrib}: markdownSyntax component "${tag}" ignored`);
  }
  return { remarkPlugins, components };
}

/** Load every enabled contrib's syntax module. Never throws. */
export async function loadContribSyntax(): Promise<void> {
  const rows = Object.entries(contribMarkdownSyntax());
  const parts = await Promise.all(
    rows.map(async ([contrib, { entry }]) => {
      const load = contribModuleLoader(entry);
      if (!load) {
        console.warn(`contrib ${contrib}: ${entry} is not in this UI build`);
        return EMPTY;
      }
      try {
        return acceptSyntax(contrib, await load());
      } catch (err) {
        console.warn(`contrib ${contrib}: ${entry} failed to load`, err);
        return EMPTY;
      }
    }),
  );
  loaded = {
    remarkPlugins: parts.flatMap((p) => p.remarkPlugins),
    components: Object.assign({}, ...parts.map((p) => p.components)) as Components,
  };
}

/** The loaded plugins and components; empty until loadContribSyntax resolves. */
export function contribSyntax(): LoadedSyntax {
  return loaded;
}
