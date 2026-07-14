"""Sandbox lifecycle — the broker as the sandbox control plane.

The broker owns per-conversation Sandbox provisioning (SA/PVC/CR), the size spec,
and the lifecycle API the agent-host calls. See todo/CONTROL_PLANE_REDESIGN.md.
"""
