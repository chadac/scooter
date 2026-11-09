"""The warm Job's pod posture and placement, rendered without a cluster."""

from warm_store_controller.k8s import ControllerK8s


def _render(node=None, **kw):
    k8s = ControllerK8s(namespace="ns", warm_job_image="img:tag", **kw)
    pod = k8s._warm_job_manifest("pool-1", "tag", node).spec.template.spec
    return pod, pod.containers[0].security_context


def test_default_keeps_host_users_and_masked_proc():
    pod, ctx = _render()
    assert pod.host_users is None
    assert ctx.proc_mount is None
    assert ctx.capabilities.add == ["SYS_ADMIN"]
    assert pod.node_selector is None


def test_user_namespace_sets_host_users_false_and_unmasked_proc():
    pod, ctx = _render(user_namespace=True, runtime_class="crun")
    assert pod.host_users is False
    assert ctx.proc_mount == "Unmasked"
    assert pod.runtime_class_name == "crun"


def test_a_node_pins_the_job_and_so_the_pv():
    pod, _ = _render(node="n3")
    assert pod.node_selector == {"kubernetes.io/hostname": "n3"}


def test_imageless_sandbox_gets_its_annotations_class_and_writable_dirs():
    k8s = ControllerK8s(namespace="ns", warm_job_image="img:imageless-abc", runtime_class="crun", imageless_pod={
        "annotations": {"imageless.run/release-v1": "scooter/agent-sandbox-os@sha256:ab"},
        "runtimeClassName": "imageless-crun",
        "writableDirs": [{"name": "imageless-rw-etc", "mountPath": "/etc"}],
    })
    tmpl = k8s._warm_job_manifest("pool-1", "tag").spec.template
    assert tmpl.metadata.annotations == {"imageless.run/release-v1": "scooter/agent-sandbox-os@sha256:ab"}
    assert tmpl.spec.runtime_class_name == "imageless-crun"
    assert "imageless-rw-etc" in [v.name for v in tmpl.spec.volumes]
    assert ("imageless-rw-etc", "/etc") in [(m.name, m.mount_path) for m in tmpl.spec.containers[0].volume_mounts]


def test_registry_sandbox_has_no_annotations():
    pod_tmpl = ControllerK8s(namespace="ns", warm_job_image="img:tag")._warm_job_manifest("p", "tag").spec.template
    assert pod_tmpl.metadata.annotations is None
