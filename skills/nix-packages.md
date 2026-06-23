---
name: nix-packages
type: knowledge
version: 1.0.0
triggers:
- install
- uninstall
- package
- apt
- apt-get
- brew
- yum
- dnf
- pacman
- apk
- upgrade
- nix
---

# Package Management in This Environment

This sandbox uses **Nix**. Traditional package managers (`apt`, `apt-get`,
`brew`, `yum`, `dnf`, `pacman`, `apk`) are **not available**. Use Nix instead.

## Installing packages

```bash
nix search nixpkgs <query>          # find a package
nix profile install nixpkgs#<pkg>   # install it
# e.g. nix profile install nixpkgs#ripgrep nixpkgs#nodejs_22 nixpkgs#go
```

## Listing / removing / upgrading

```bash
nix profile list
nix profile remove <index>
nix profile upgrade '.*'
```

## Tips

- nixpkgs names may differ from apt/brew; use `nix search nixpkgs <query>`.
- Installs are isolated and immutable — they never break existing packages.
- For language deps prefer the language's own tool inside a project (pip in a
  venv, npm for project deps); use Nix for runtimes and system tools.
