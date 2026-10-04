#!/usr/bin/env bash
# Dump everything needed to diagnose a failed e2e FULL run. Best-effort: every
# command is `|| true` so one missing resource can't hide the rest.
#
# Shared by `e2e full shard` and `flake focus full` — a flake check that fails
# with a thinner dump than the job that found the flake is a wasted run.
# The crash census, shared with the always-on CI step so the two cannot drift.
"$(dirname "$0")/k3d-sandbox-census.sh" || true
nix shell nixpkgs#kubectl nixpkgs#jq nixpkgs#docker-client -c bash -c '
  kubectl -n agent-sandbox get pods,deploy,svc,pvc,conversations -o wide || true
  # describe the not-ready workloads so a Pending pod shows its scheduling reason
  # (Insufficient cpu/mem, an unbindable PVC, a taint, …) — a bare `get` hides it.
  # Every platform workload, not just agent-host: a CrashLoopBackOff reports WHY it
  # died only here, as `Last State: Terminated, Reason: …` (OOMKilled, Error, exit
  # code). Without it a SIGKILLed container is indistinguishable from one that threw.
  kubectl -n agent-sandbox describe deploy/agent-host || true
  for app in agent-host conversation-controller conversation-router; do
    kubectl -n agent-sandbox describe pods -l app="$app" || true
  done
  kubectl describe nodes || true
  kubectl -n agent-sandbox get sandboxes.agents.x-k8s.io -o wide || true
  kubectl -n agent-sandbox get events --sort-by=.lastTimestamp | tail -120 || true
  kubectl -n agent-sandbox logs -l app=agent-host --tail=300 || true
  kubectl -n agent-sandbox logs -l app=conversation-controller --tail=150 || true
  kubectl -n agent-sandbox logs -l app=conversation-router --tail=150 || true
  # The RESTARTED containers, one pod at a time. Plain `logs` serves the CURRENT
  # attempt, so for a crash-loop it returns the fresh (still-healthy) process and
  # the fatal output is only ever in --previous. -l cannot be used: `logs -l` has no
  # --previous, so the pods are enumerated by hand.
  for app in agent-host conversation-controller conversation-router; do
    for pod in $(kubectl -n agent-sandbox get pods -l app="$app" -o name 2>/dev/null); do
      restarts=$(kubectl -n agent-sandbox get "$pod" \
        -o jsonpath="{.status.containerStatuses[0].restartCount}" 2>/dev/null || echo 0)
      [ "${restarts:-0}" -gt 0 ] || continue
      echo "===== PREVIOUS container log: $pod (restarts=$restarts) ====="
      kubectl -n agent-sandbox logs "$pod" --previous --tail=200 || true
    done
  done
  # The conv-* sandbox pods. agent-sandbox creates them, so they carry none of the
  # `app` labels every selector above uses — they were invisible in the dump. A
  # sandbox that never goes ready is what the agent-host reports as "ready-pod
  # deadline expired", so ONE broken sandbox reads as a dozen unrelated spec
  # failures. Why: PR #694.
  for pod in $(kubectl -n agent-sandbox get pods -o name 2>/dev/null | grep "^pod/conv-"); do
    ready=$(kubectl -n agent-sandbox get "$pod" \
      -o jsonpath="{.status.containerStatuses[0].ready}" 2>/dev/null || echo unknown)
    restarts=$(kubectl -n agent-sandbox get "$pod" \
      -o jsonpath="{.status.containerStatuses[0].restartCount}" 2>/dev/null || echo 0)
    [ "$ready" = "true" ] && [ "${restarts:-0}" -eq 0 ] && continue
    echo "===== NOT-READY sandbox: $pod (ready=$ready restarts=$restarts) ====="
    kubectl -n agent-sandbox describe "$pod" || true
    kubectl -n agent-sandbox logs "$pod" --tail=200 || true
    name=${pod#pod/}
    # The POD SPEC as applied, and the Sandbox CR that owns it. An instant exit is
    # usually explained by what the pod was actually given (mounts, securityContext,
    # resources) rather than by anything the container printed.
    echo "===== POD YAML: $pod ====="
    kubectl -n agent-sandbox get "$pod" -o yaml || true
    echo "===== SANDBOX CR: $name ====="
    kubectl -n agent-sandbox get sandboxes.agents.x-k8s.io "$name" -o yaml || true
    # Events for THIS object only. The namespace-wide tail above is capped at 120 and
    # a busy run buries the relevant BackOff lines.
    echo "===== EVENTS: $name ====="
    kubectl -n agent-sandbox get events --field-selector involvedObject.name="$name" \
      --sort-by=.lastTimestamp || true
    [ "${restarts:-0}" -gt 0 ] || continue
    echo "===== PREVIOUS container log: $pod (restarts=$restarts) ====="
    # --timestamps so the boot sequence can be lined up against the kubelet/runtime
    # log below: a silent exit is dated only here.
    kubectl -n agent-sandbox logs "$pod" --previous --timestamps --tail=400 || true
  done
  # A HEALTHY sandbox, captured only when a broken one exists. The failure mode is a
  # RACE -- one pod of several dies -- so the broken pod spec means little without a
  # good one from the same cluster to diff it against.
  bad=$(kubectl -n agent-sandbox get pods -o json 2>/dev/null \
    | jq -r ".items[] | select(.metadata.name | startswith(\"conv-\")) | select((.status.containerStatuses[0].ready != true) or ((.status.containerStatuses[0].restartCount // 0) > 0)) | .metadata.name" | head -1)
  if [ -n "${bad:-}" ]; then
    good=$(kubectl -n agent-sandbox get pods -o json 2>/dev/null \
      | jq -r ".items[] | select(.metadata.name | startswith(\"conv-\")) | select(.status.containerStatuses[0].ready == true) | select((.status.containerStatuses[0].restartCount // 0) == 0) | .metadata.name" | head -1)
    if [ -n "${good:-}" ]; then
      echo "===== HEALTHY PEER YAML: pod/$good (diff against pod/$bad) ====="
      kubectl -n agent-sandbox get "pod/$good" -o yaml || true
      echo "===== SPEC DIFF: $good (healthy) vs $bad (broken) ====="
      kubectl -n agent-sandbox get "pod/$good" -o json > /tmp/good.json 2>/dev/null || true
      kubectl -n agent-sandbox get "pod/$bad"  -o json > /tmp/bad.json  2>/dev/null || true
      # Compare only the fields that can make systemd die on boot. Whole-object diff
      # is noise: names, UIDs, IPs and timestamps differ on every pod.
      for f in .spec.containers[0].securityContext .spec.containers[0].resources .spec.containers[0].volumeMounts .spec.volumes .spec.securityContext .spec.nodeName .status.qosClass; do
        echo "--- $f"
        diff <(jq -S "$f" /tmp/good.json 2>/dev/null) <(jq -S "$f" /tmp/bad.json 2>/dev/null) \
          && echo "    (identical)" || true
      done
    fi
  fi
  # The host ring buffer. The k3d nodes are containers on this runner and share its
  # kernel, so cgroup exhaustion or a kernel-side refusal lands HERE -- `dmesg` does
  # not exist inside the node image at all.
  echo "===== KERNEL RING BUFFER (host runner; k3d nodes share this kernel) ====="
  (dmesg --ctime 2>/dev/null || sudo -n dmesg --ctime 2>/dev/null || echo "(dmesg unavailable)") \
    | tail -120 || true
  # THE RUNTIME ERROR. A container that dies in the same second it started, with
  # nothing after "starting systemd...", failed below the kubelet: containerd/runc
  # report it and Kubernetes only ever surfaces the exit code. k3d runs each node as
  # a docker container, so the k3s log inside it carries kubelet + containerd + runc.
  # docker-client comes from the nix shell above, so the CLI always exists; what can
  # still fail is reaching the daemon. Report that LOUDLY -- a silent skip here is
  # how the gh window fetch managed to print "0 runs" while five reports existed.
  if ! docker info >/dev/null 2>&1; then
    echo "===== RUNTIME LOG: UNAVAILABLE -- docker CLI present but daemon unreachable ====="
    docker info 2>&1 | head -5 || true
  else
    for node in $(docker ps --format "{{.Names}}" 2>/dev/null | grep "^k3d-" || true); do
      echo "===== RUNTIME LOG: $node (kubelet/containerd/runc) ====="
      docker logs --tail=4000 "$node" 2>&1 \
        | grep -iE "conv-|runc|exit status|exit code|oci runtime|cgroup|back-?off|StartContainer|CreateContainer|RunPodSandbox|killing container|failed to (create|start|run)|sandbox|no space|device or resource busy|permission denied" \
        | tail -200 || true
      echo "===== CRI VIEW: $node ====="
      # crictl sees the dead container after kubectl has moved on, including the OCI
      # config actually handed to runc. k3s ships crictl; bare crictl may not exist.
      docker exec "$node" sh -c "crictl ps -a 2>/dev/null || k3s crictl ps -a 2>/dev/null" \
        | grep -E "conv-|CONTAINER" | head -40 || true
      for cid in $(docker exec "$node" sh -c "crictl ps -a -q 2>/dev/null || k3s crictl ps -a -q 2>/dev/null" 2>/dev/null | head -40); do
        nm=$(docker exec "$node" sh -c "crictl inspect $cid 2>/dev/null || k3s crictl inspect $cid 2>/dev/null" 2>/dev/null \
          | jq -r ".status.labels[\"io.kubernetes.pod.name\"] // empty" 2>/dev/null)
        case "${nm:-}" in conv-*) ;; *) continue ;; esac
        st=$(docker exec "$node" sh -c "crictl inspect $cid 2>/dev/null || k3s crictl inspect $cid 2>/dev/null" 2>/dev/null \
          | jq -r ".status.state // empty" 2>/dev/null)
        case "${st:-}" in CONTAINER_EXITED) ;; *) continue ;; esac
        echo "===== CRI INSPECT: $nm ($cid) ====="
        docker exec "$node" sh -c "crictl inspect $cid 2>/dev/null || k3s crictl inspect $cid 2>/dev/null" 2>/dev/null \
          | jq "{state:.status.state, exitCode:.status.exitCode, reason:.status.reason, message:.status.message, startedAt:.status.startedAt, finishedAt:.status.finishedAt, logPath:.status.logPath}" || true
      done
    done
  fi
  # The step runs under `bash -e`; a trailing failed test would fail the dump.
  true
'
