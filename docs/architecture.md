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

The sandbox is the agent's compute environment. Each conversation gets its own: a NixOS
machine that works like a virtual machine the agent has full control over. The agent
can install packages, run services, change its own system configuration and resize its
CPU and memory. Its workspace persists, and an idle sandbox is suspended and picks up
where it left off on the next message. It holds no credentials, so whatever the agent
does there can't leak a secret.

### Broker

The broker gives the agent secretless access to privileged services, under a permission
model the infrastructure owner defines. The sandbox never holds a credential. It
authenticates to the broker with its ServiceAccount token, and the broker checks each
request against the deployment's permission rules, asks the user to approve it when a
rule says so, and then makes the call or vends a short-lived credential.

On top of that, the broker offers a few conveniences:

- **Forge proxy:** CLI tools like `git`, `gh`, `glab` and `jira` work in the sandbox with
  no configuration, because the proxy injects the token on the way out.
- **MCP tools:** typed tools the agent can call for common tasks on each service.
- **REST interface:** plain HTTP routes for each service, which contribs declare.

### Webhooks

The webhooks service lets outside events start or steer conversations.

- It receives events from GitHub, GitLab, Slack and Jira.
- It turns each event into a prompt and sends it to the right conversation, creating a
  new one if needed.
- Each contrib registers the handlers for its own provider.

### Agent-host and conversation-router

The agent-host is a horizontally scalable service that runs the agents. Each replica runs
the agent sessions for many conversations, and carries out their tool calls by exec'ing
into each conversation's sandbox through the Kubernetes API. It also creates, suspends
and resumes those sandboxes.

The agent is kept out of its sandbox on purpose. Secrets the agent process needs, such as
its model credentials, stay in the agent-host and never enter the sandbox, where the
agent runs arbitrary code. And because the sandbox holds no agent state, it can be resized
or restarted without interrupting the agent's session.

The conversation-router sits in front of the agent-host replicas. Each conversation is
owned by one replica, and the router sends every request for it there, whether HTTP, SSE
or WebSocket. It also checks who the caller is and whether they may see the conversation,
and it serves each conversation's web services from their own origin on
`*.sandboxDomain`.

### Supporting services

- **UI:** serves the chat app. Its nginx proxies the API to the router and contribs'
  public paths to the broker.
- **Conversation-controller:** assigns each conversation to the least-loaded ready
  agent-host pod, and reassigns it when that pod goes away, so any replica can pick up any
  conversation. It also scales the agent-host fleet to demand. It is leader-elected, so
  only one replica acts at a time.
- **Scheduler:** stores scheduled tasks and fires each one when it is due, as a new
  conversation or a prompt to an existing one.
- **BYOC-controller** (optional): holds the WebSocket from each
  [bring-your-own-Claude](features/byoc.md) container, so any agent-host can drive it.
- **Warm-store-controller** (optional): keeps a pool of pre-filled `/nix/store` volumes so
  new sandboxes start faster.

## Network boundaries

When the CNI enforces NetworkPolicy, Scooter's policies mean that:

- sandboxes reach only the broker, its forge proxy, the router's self-access listener, DNS and the internet, and never each other;
- only the agent-host and the router reach a sandbox, and only the agent-host reaches its MCP servers (ports 9700-9799);
- only the router and the conversation-controller reach agent-host pods.
