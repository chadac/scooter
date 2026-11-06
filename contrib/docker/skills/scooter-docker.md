---
name: scooter-docker
description: >-
  Docker and k3d (local Kubernetes) in this sandbox. `docker`, `k3d` and `kubectl`
  work as usual against a nested dockerd that starts on first use. Run anything that
  must reach a container's published port or a k3d API server through
  `docker-netns`, e.g. `docker-netns kubectl get nodes`. Use it whenever a task
  needs containers, docker compose, an image build, or a Kubernetes cluster.
---

# Docker and k3d in Scooter

Your sandbox runs a real `dockerd` inside its own user, network and mount
namespace. It starts the first time something connects to `/run/docker.sock`
(`DOCKER_HOST` points there), so it costs nothing until you use it. Privileged
containers work, which is what k3d's nodes need.

If `docker` reports that it cannot connect and `journalctl -u scooter-docker`
says `/proc/sys is read-only`, this deployment does not run sandboxes in a user
namespace. Docker cannot work in that sandbox. Tell the user rather than
working around it.

## Before a cluster: scale up

A 3-node k3d cluster idles at about 1 GiB of process memory plus page cache, and
`dockerd` alone uses a few hundred MiB. Before creating a cluster, set at least
8Gi with `set_sandbox_resources` and restart (see the scooter-compute-scaling
skill). Plain `docker run` fits in the default size.

## Docker

```bash
docker run --rm alpine echo hi      # pulls go through the sandbox's proxy
docker build -t myapp .             # RUN steps need the proxy; see Limits
```

Images and volumes live in `/workspace/.scooter/docker`, so they survive suspend
and count against the workspace disk. `docker system prune` frees it.

## k3d

```bash
k3d cluster create dev --agents 2   # ~40s; images pull live
docker-netns kubectl get nodes      # k3d wrote ~/.kube/config
```

`k3d cluster create` here adds what a cluster needs in this sandbox: a
`/dev/kmsg` stand-in and a proxy for the nodes' image pulls. Clusters come back
by themselves after a sandbox restart.

## `docker-netns`: reaching ports

dockerd's network is not the pod's. Published ports (`-p 8080:80`) and the k3d
API server listen inside it, so `curl localhost:8080` from your shell fails. Run
the client there instead:

```bash
docker-netns curl -s localhost:8080
docker-netns kubectl apply -f deploy.yaml
docker-netns just test-cluster      # a whole test suite, if it needs the cluster
```

It keeps your proxy settings, so commands inside still reach the internet.

## Limits

- **No egress except HTTP(S) through the proxy.** Containers and pods get no
  DNS for outside names and no raw TCP out. Image pulls are already wired; for
  anything else, pass the proxy explicitly. It isn't injected by default, since
  that would also proxy containers calling each other by name:

  ```bash
  P=$SCOOTER_CONTAINER_PROXY   # http://192.0.2.1:3128, reachable from every network
  docker build --build-arg http_proxy=$P --build-arg https_proxy=$P .
  docker run -e http_proxy=$P -e https_proxy=$P -e HTTP_PROXY=$P -e HTTPS_PROXY=$P …
  ```
- **Web services can't point at a container directly.** To show the user a
  container's port, run a forwarder in the pod, e.g.
  `socat TCP-LISTEN:8000,fork EXEC:"docker-netns socat STDIO TCP\:127.0.0.1\:8080"`.
- **Logs:** `journalctl -u scooter-docker` for the daemon.
