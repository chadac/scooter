/**
 * The Services panel's "Add service" dialog: a short form whose answers become a chat
 * message asking Scooter to declare the service, since services are declared in-sandbox.
 */

import { useEffect, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface AddServiceForm {
  name: string;
  description: string;
}

const EMPTY: AddServiceForm = { name: "", description: "" };

/** The service's path segment, as the `webServices.<name>` option takes it. */
const NAME_RE = /^[a-z][a-z0-9-]{0,30}$/;

/** Why the form can't be sent yet, or null when it can. */
export function addServiceError(form: AddServiceForm, existing: readonly string[]): string | null {
  const name = form.name.trim();
  if (name && !NAME_RE.test(name)) return "Use lowercase letters, digits and dashes, starting with a letter.";
  if (existing.includes(name)) return `A service named “${name}” already exists.`;
  return null;
}

/** The chat message that asks Scooter to build the service. */
export function addServicePrompt(form: AddServiceForm): string {
  const name = form.name.trim();
  return [
    "Please add a web service to this sandbox.",
    "",
    `- Name: \`${name}\``,
    `- Description: ${form.description.trim()}`,
    "",
    `Declare it as \`webServices.${name}\` and apply it with \`scooter-rebuild switch\`, then start it and send me the link.`,
  ].join("\n");
}

const field = "rounded-md border border-input bg-background px-2 py-1.5 text-sm";
const label = "text-xs font-medium text-muted-foreground";

export function AddServiceDialog({
  open,
  onOpenChange,
  existing,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Names already declared, which the new one must not reuse. */
  existing: readonly string[];
  /** Sends the built request to the conversation. */
  onSubmit: (prompt: string) => void;
}) {
  const [form, setForm] = useState<AddServiceForm>(EMPTY);
  useEffect(() => {
    if (open) setForm(EMPTY);
  }, [open]);
  const set = <K extends keyof AddServiceForm>(k: K, v: AddServiceForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  const error = addServiceError(form, existing);
  const ready = !error && form.name.trim() !== "" && form.description.trim() !== "";

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    onSubmit(addServicePrompt(form));
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="add-service-dialog" className="sm:max-w-md">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Add a web service</DialogTitle>
            <DialogDescription>Describe it, and Scooter sets it up in this sandbox.</DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-1">
            <label htmlFor="add-service-name" className={label}>Name</label>
            <input
              id="add-service-name"
              data-testid="add-service-name"
              value={form.name}
              onChange={(e) => set("name", e.target.value.toLowerCase())}
              placeholder="dashboard"
              autoComplete="off"
              className={`${field} font-mono`}
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="add-service-description" className={label}>Description</label>
            <textarea
              id="add-service-description"
              data-testid="add-service-description"
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
              placeholder="A Streamlit dashboard for /workspace/app.py"
              rows={3}
              className={field}
            />
          </div>

          {error ? (
            <p data-testid="add-service-error" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" data-testid="add-service-submit" disabled={!ready}>
              Ask Scooter
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
