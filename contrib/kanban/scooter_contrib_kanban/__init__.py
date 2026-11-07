"""Kanban boards: a folder shown as a board, with each conversation a card.

  store.py             the card table in this contrib's own `contrib_kanban` database
  transport.py         the /kanban routes for the sandbox's hooks and the board
  mcp_tools.py         kanban_set_status / kanban_get_status for the agent
  broker_provider.py   wires them into the broker

This module imports neither broker nor webhooks.
"""
