package main

import (
	"fmt"
	"sort"
	"strings"
)

// targetModule is the module `review target` writes under /etc/scooter/modules.
const targetModule = "web-review-target.nix"

// renderModule renders t as a NixOS module setting webReview.target.
func renderModule(t Target) string {
	var b strings.Builder
	b.WriteString("# Written by `review target`; rerun it to change the app, `review target --clear` to stop.\n")
	b.WriteString("{\n  webReview.target = {\n")
	fmt.Fprintf(&b, "    port = %d;\n", t.Port)
	for _, f := range [][2]string{{"run", t.Run}, {"cwd", t.Cwd}, {"unit", t.Unit}} {
		if f[1] != "" {
			fmt.Fprintf(&b, "    %s = %s;\n", f[0], nixString(f[1]))
		}
	}
	if len(t.Env) > 0 {
		keys := make([]string, 0, len(t.Env))
		for k := range t.Env {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		b.WriteString("    environment = {\n")
		for _, k := range keys {
			fmt.Fprintf(&b, "      %s = %s;\n", nixString(k), nixString(t.Env[k]))
		}
		b.WriteString("    };\n")
	}
	b.WriteString("  };\n}\n")
	return b.String()
}

// nixString quotes s as a Nix string literal.
func nixString(s string) string {
	r := strings.NewReplacer(`\`, `\\`, `"`, `\"`, "${", `\${`, "\n", `\n`, "\r", `\r`, "\t", `\t`)
	return `"` + r.Replace(s) + `"`
}
