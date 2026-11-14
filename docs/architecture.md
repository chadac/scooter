# Architecture

Scooter runs the agent **outside** its sandbox. The agent-host runs the agent process
(Goose over ACP, by default) and carries out each tool call by exec'ing into the
conversation's sandbox pod through the Kubernetes API. The sandbox is a plain NixOS
machine with no agent inside it. Everything it reaches outside the cluster goes through
the broker, which holds the credentials.

```mermaid
flowchart LR
    user(["User"])
    ext(["GitHub · GitLab<br/>Slack · Jira"])

    ui["UI"]
    webhooks["webhooks"]
    sched["scheduler"]
    router["conversation-<br/>router"]

    subgraph hosts["agent-host replicas"]
        host1["agent-host 1"]
        host2["agent-host 2"]
    end

    subgraph sandboxes["sandbox per conversation"]
        sb1["sandbox A"]
        sb2["sandbox B"]
        sb3["sandbox C"]
        sb4["sandbox D"]
    end

    broker["broker"]
    world(["External<br/>connections"])

    user --> ui --> router
    ext --> webhooks --> router
    sched --> router
    router --> host1 & host2
    host1 -->|agent A| sb1
    host1 -->|agent B| sb2
    host2 -->|agent C| sb3
    host2 -->|agent D| sb4
    sandboxes --> broker
    hosts --> broker
    broker --> world
```

## Components

The first five components do the core work: running the agent, isolating it and
holding its credentials. The rest support them.

### Sandbox

Each conversation gets its own sandbox: a `Sandbox` object from
[agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) running a plain NixOS
machine. The agent's shell commands and file edits all run here.

- It has its own ServiceAccount, `sandbox-<id>`, which is its identity to the broker.
- Its workspace lives on a persistent volume, so files and installed tools survive.
- An idle sandbox is suspended and resumed on the next message, with its workspace intact.
- It holds no credentials. Anything outside the cluster is reached through the broker.

### broker

The broker is the only component that holds credentials. Every call a sandbox makes to
an outside service goes through it.

- It authenticates each sandbox by its ServiceAccount token, checked with a TokenReview.
- It applies the deployment's permission rules, and asks the user to approve a request
  when a rule says so.
- It either vends a short-lived credential or makes the request itself.
- Forge traffic (`git`, `gh`) goes through its forge proxy, which adds the token on the
  way out, so the sandbox never sees it.
- Contribs add their own routes and agent tools to it.

### webhooks

The webhooks service lets outside events start or steer conversations.

- It receives events from GitHub, GitLab, Slack and Jira.
- It turns each event into a prompt and sends it to the right conversation, creating a
  new one if needed.
- Each contrib registers the handlers for its own provider.

### agent-host

The agent-host runs the agent. It is a fleet of replicas, and each one runs many
conversations.

- It runs one agent session per live conversation and bridges ACP to AG-UI for the browser.
- It runs each tool call by exec'ing into the conversation's sandbox through the
  Kubernetes API.
- It provisions, suspends, resumes and deletes sandboxes.
- It stores each conversation's event history, so a reconnecting browser can replay it.

### conversation-router

The router sits in front of every agent-host, so a request can reach whichever replica
owns its conversation.

- It finds the conversation's owning pod and proxies the request there, whether HTTP,
  SSE or WebSocket.
- If the conversation has no pod yet, it claims one.
- It checks who the caller is and whether they may see the conversation, since private
  conversations admit only their owner.
- It serves each conversation's web services, such as the terminal or VS Code, from
  their own origin on `*.sandboxDomain`.
- It has a separate listener where a sandbox can call its own conversation's API,
  authenticated by its ServiceAccount token.

### Supporting services

- **UI:** serves the chat app. Its nginx proxies the API to the router and contribs'
  public paths to the broker.
- **conversation-controller:** assigns each conversation to the least-loaded ready
  agent-host pod, and reassigns it when that pod goes away, so any replica can pick up any
  conversation. It also scales the agent-host fleet to demand. It is leader-elected, so
  only one replica acts at a time.
- **scheduler:** stores scheduled tasks and fires each one when it is due, as a new
  conversation or a prompt to an existing one.
- **byoc-controller** (optional): holds the WebSocket from each
  [bring-your-own-Claude](features/byoc.md) container, so any agent-host can drive it.
- **warm-store-controller** (optional): keeps a pool of pre-filled `/nix/store` volumes so
  new sandboxes start faster.

## Network boundaries

When the CNI enforces NetworkPolicy, Scooter's policies mean that:

- sandboxes reach only the broker, its forge proxy, the router's self-access listener, DNS and the internet, and never each other;
- only the agent-host and the router reach a sandbox, and only the agent-host reaches its MCP servers (ports 9700-9799);
- only the router and the conversation-controller reach agent-host pods.
