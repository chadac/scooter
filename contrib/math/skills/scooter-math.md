---
name: scooter-math
description: >-
  Writing math in chat. Scooter's chat renders TeX with KaTeX: use $$…$$ or \(…\)
  inline, and $$ or \[ \] on their own lines (or a ```math fence) for display math.
  A single $ is a literal dollar sign. Read it before writing equations, formulas
  or any math notation in a reply.
---

# Writing math in chat

The chat renders TeX (KaTeX's subset of LaTeX math) in your replies.

| You write | It renders as |
|---|---|
| `$$e^{i\pi} + 1 = 0$$` inside a sentence | inline math |
| `\(O(n \log n)\)` inside a sentence | inline math |
| `$$` on its own line, the TeX, `$$` on its own line | display math |
| `\[` … `\]` on their own lines | display math |
| a ` ```math ` fenced block | display math |

For example:

```markdown
The sort runs in \(O(n \log n)\) time, and the sum is

$$
\sum_{i=1}^{n} i = \frac{n(n+1)}{2}
$$
```

- **A single `$` is never math.** `$5`, `$PATH` and `$x$` stay as typed, so
  write inline math as `$$x$$` or `\(x\)`, not `$x$`.
- **Math inside code is not rendered.** Don't wrap TeX in backticks unless you
  want the source shown.
- **Only math mode.** Use KaTeX-supported commands (`\frac`, `\sum`,
  `\begin{aligned}`, `\mathbb`, …). Document commands (`\section`,
  `\usepackage`), links (`\href`, `\url`) and images are not supported and show
  as an error.
- **Other places don't render it.** Slack messages, commit messages and most
  plain-text outputs show TeX as source, so write math there in plain text
  (`O(n log n)`, `sum of i for i = 1..n`). GitHub markdown renders `$…$`,
  `$$…$$` and ` ```math `.
