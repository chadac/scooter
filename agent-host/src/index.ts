/**
 * agent-host entry point.
 *
 * Design stage: wiring sketch only (no implementation). Composes:
 *   AguiServer  <-- browser
 *      |  onPrompt -> SessionManager.prompt
 *      |  onAttach -> replay ConversationStore events
 *   SessionManager
 *      |-- SandboxProvisioner (kube API: cold Sandbox per conversation)
 *      |-- ConversationStore  (conversation-state PVC)
 *      `-- per conversation: SessionBridge( AcpClient(goose) <-> AG-UI, ExecBackend )
 *                                              ExecBackend = agent-sandbox SDK
 */

import { createAguiServer } from "./agui/server.js";
import { createSessionManager } from "./session/manager.js";

export async function main(): Promise<void> {
  // 1. const provisioner = createKubeSandboxProvisioner(...)
  // 2. const store = createPvcConversationStore(...)
  // 3. const sessions = createSessionManager({ provisioner, store })
  // 4. const server = createAguiServer()
  //    server.onPrompt((id, input) => sessions.prompt(id, input.text))
  //    server.onAttach((id, conn) => replay(store, id, conn))
  // 5. await server.listen(PORT)
  void createAguiServer;
  void createSessionManager;
  throw new Error("not implemented (Design stage)");
}
