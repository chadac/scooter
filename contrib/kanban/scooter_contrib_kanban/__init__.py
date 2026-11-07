"""Kanban boards: a locked folder shown as a board, its stages folders inside it.

  store.py             boards, stages and cards in this contrib's own `contrib_kanban` database
  folders.py           the router's folder routes, called as the broker for the user
  boards.py            boards and stages kept in step across the two
  transport.py         the /kanban routes for the sandbox's hooks and the board
  mcp_tools.py         kanban_set_status / kanban_get_status for the agent
  broker_provider.py   wires them into the broker

This module imports neither broker nor webhooks.
"""
