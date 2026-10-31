// Settings → GitLab: link the user's GitLab account so Scooter acts as them in their private conversations.
import { LinkedAccountTab } from "@/src/contrib/sdk";

export default function GitLabSettingsTab() {
  return (
    <LinkedAccountTab
      contrib="gitlab"
      label="GitLab"
      description={
        <p>
          In your private conversations, Scooter pushes, opens merge requests and comments on GitLab as you, and your
          commits name you as author with Scooter as co-author. Shared conversations still use Scooter&apos;s own
          GitLab account.
        </p>
      }
      patHint="A personal access token with the api scope."
    />
  );
}
