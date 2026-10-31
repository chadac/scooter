// Settings → GitHub: link the user's GitHub account so Scooter acts as them in their private conversations.
import { LinkedAccountTab } from "@/src/contrib/sdk";

export default function GitHubSettingsTab() {
  return (
    <LinkedAccountTab
      contrib="github"
      label="GitHub"
      description={
        <p>
          In your private conversations, Scooter pushes, opens pull requests and comments on GitHub as you, and your
          commits name you as author with Scooter as co-author. Shared conversations still act as the Scooter app.
          Linking through GitHub reaches repositories where the Scooter app is installed. A fine-grained personal
          access token reaches others.
        </p>
      }
      patHint="A fine-grained token with Contents, Pull requests and Issues (read and write) on the repositories you want."
    />
  );
}
