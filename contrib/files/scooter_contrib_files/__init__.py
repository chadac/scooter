"""The files contrib: a sandbox viewer over the workspace, and the store its review surface syncs to.

Three parts, and the annotations are the last two:

  viewer/            the sandbox-side web service (sandbox.nix); stdlib only, not packaged
  store.py           the `annotations` table in this contrib's own `contrib_files` database
  annotations_transport.py + broker_provider.py   the broker routes the viewer pushes to

An annotation is a comment or an answer a human anchored to a location in a file.
Only the viewer talks to the broker side: it owns the working copy and can resolve
an anchor against live content, which the broker cannot do because it never sees
the file. So the broker side is a dumb, correct store, mounted as a provider like
any other integration — the broker core learns nothing about annotations, and
`ctx.contrib_store_config` (its own database) plus `authed` (the caller's identity) are
the only general capabilities it supplies.

This module is import-light on purpose: it imports NEITHER broker nor webhooks, so
the sandbox image can vendor the tree without either service's surface.
Design doc: chadac-me/scooter#768.
"""
