"use client";
import { useActionState } from "react";
import { generate, type GenerateState } from "./actions.ts";

/** Calls the `generate` server action and shows the decision. */
export function GenerateForm({ orgs }: { orgs: readonly string[] }) {
  const [state, action, pending] = useActionState<GenerateState, FormData>(generate, null);
  return (
    <form action={action}>
      <select name="org" defaultValue={orgs[0]}>
        {orgs.map((o) => (
          <option key={o}>{o}</option>
        ))}
      </select>{" "}
      <button disabled={pending}>Generate (server action, 1 API call)</button>
      <pre>{state ? JSON.stringify(state, null, 2) : "(submit to consume)"}</pre>
    </form>
  );
}
