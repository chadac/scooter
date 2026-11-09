package main

import "testing"

func TestRenderModule(t *testing.T) {
	got := renderModule(Target{Port: 5173, Run: `npm run dev -- --base "$REVIEW_BASE" ${X}`, Cwd: "/workspace/my app",
		Env: map[string]string{"PATH": "/bin:/usr/bin"}})
	want := `# Written by ` + "`review target`; rerun it to change the app, `review target --clear` to stop." + `
{
  webReview.target = {
    port = 5173;
    run = "npm run dev -- --base \"$REVIEW_BASE\" \${X}";
    cwd = "/workspace/my app";
    environment = {
      "PATH" = "/bin:/usr/bin";
    };
  };
}
`
	if got != want {
		t.Errorf("got\n%s\nwant\n%s", got, want)
	}
}

func TestNixString(t *testing.T) {
	for in, want := range map[string]string{
		`a\b`:   `"a\\b"`,
		"x\ny":  `"x\ny"`,
		"$HOME": `"$HOME"`,
		"${a}":  `"\${a}"`,
		`"q"`:   `"\"q\""`,
	} {
		if got := nixString(in); got != want {
			t.Errorf("nixString(%q) = %s, want %s", in, got, want)
		}
	}
}
