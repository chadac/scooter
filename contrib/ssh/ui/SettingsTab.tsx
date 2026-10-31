// Settings → SSH key: the user's public key, for adding to servers and forges, and rotation.
//
// Calls go through contribFetch, relayed to /ssh/user/<path> as the signed-in user.
import { useCallback, useEffect, useState } from "react";
import { Button, contribFetch, ErrorState, Spinner, monoInputClass } from "@/src/contrib/sdk";

interface Key {
  public_key: string;
  fingerprint: string;
  created_at: string;
}

async function api(path: string, init?: RequestInit): Promise<Key> {
  const res = await contribFetch("ssh", path, init);
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return (await res.json()) as Key;
}

export default function SshKeySettingsTab() {
  const [key, setKey] = useState<Key | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [rotating, setRotating] = useState(false);

  const load = useCallback(async () => {
    try {
      setKey(await api("key"));
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <ErrorState title="Couldn't load your SSH key" error={error} />;
  if (!key) return <Spinner />;

  const copy = async () => {
    await navigator.clipboard.writeText(key.public_key);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const rotate = async () => {
    if (!window.confirm("Replace your SSH key? Servers that trust the current key will stop accepting Scooter.")) return;
    setRotating(true);
    try {
      setKey(await api("rotate", { method: "POST" }));
    } catch (e) {
      setError(String(e));
    } finally {
      setRotating(false);
    }
  };

  return (
    <div className="space-y-4" data-testid="ssh-settings-tab">
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">SSH key</h2>
        <p className="text-sm text-muted-foreground">
          In your private conversations, Scooter authenticates over SSH with this key: git over ssh:// and SSH to
          your own hosts. Scooter holds the private key and never puts it in a sandbox. Shared conversations don't
          use it. Add the public key below to any server you want Scooter to reach.
        </p>
      </section>
      <section className="space-y-2">
        <textarea
          aria-label="Public key"
          data-testid="ssh-public-key"
          className={`${monoInputClass} h-20 w-full resize-none break-all`}
          readOnly
          value={key.public_key}
          onFocus={(e) => e.currentTarget.select()}
        />
        <p className="text-xs text-muted-foreground">
          {key.fingerprint} · created {new Date(key.created_at).toLocaleString()}
        </p>
        <div className="flex gap-2">
          <Button size="sm" onClick={copy}>{copied ? "Copied" : "Copy public key"}</Button>
          <Button size="sm" variant="outline" onClick={rotate} disabled={rotating}>
            {rotating ? "Rotating…" : "Rotate"}
          </Button>
        </div>
      </section>
    </div>
  );
}
