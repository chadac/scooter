# echo's sample skill provider: one fixed skill, for the provider seam's tests.
cat >/dev/null
cat <<'JSON'
{"skills": [{"name": "echo-provided", "content": "---\nname: echo-provided\ndescription: Use when testing skill providers.\n---\n# echo-provided\n\nMarker: echo-provided-skill-marker. This skill came from a skill provider.\n"}]}
JSON
