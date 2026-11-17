import { useEffect, useState } from "react";
import { codeToHtml } from "shiki";

const THEMES = { light: "solarized-light", dark: "solarized-dark" };

/** A fenced block of code, highlighted in both themes. */
export function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [html, setHtml] = useState("");
  useEffect(() => {
    let live = true;
    codeToHtml(code, { lang: lang || "text", themes: THEMES, defaultColor: false })
      .catch(() => codeToHtml(code, { lang: "text", themes: THEMES, defaultColor: false }))
      .then((h) => live && setHtml(h));
    return () => {
      live = false;
    };
  }, [lang, code]);
  if (!html)
    return (
      <pre className="shiki-fallback">
        <code>{code}</code>
      </pre>
    );
  return <div className="not-prose shiki-block" dangerouslySetInnerHTML={{ __html: html }} />;
}
