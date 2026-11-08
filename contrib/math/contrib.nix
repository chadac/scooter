# TeX in messages, drawn with KaTeX. UI-only and opt-in.
{ lib, ... }:
{
  contribs.math = {
    src = ./.;
    enable = lib.mkDefault false;
    skills."scooter-math.md" = ./skills/scooter-math.md;
    ui.markdownSyntax.entry = "ui/MathSyntax.tsx";
  };
}
