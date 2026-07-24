/**
 * Shared agent-host connection config for the plain-fetch API clients (settings
 * page, etc). The streaming runtime builds its own from the same VITE var; this
 * is the non-streaming counterpart so components don't each re-read the env.
 */

import type { AgentHostConfig } from "./client.js";

const BASE_URL = (import.meta.env.VITE_AGENT_HOST_URL ?? "").replace(/\/$/, "");

export const agentHostConfig: AgentHostConfig = { baseUrl: BASE_URL };
