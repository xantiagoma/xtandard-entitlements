/**
 * A thin wrapper over TanStack `useMutation` for the admin's control-plane
 * actions: success / error toasts, and cache invalidation of everything a
 * customer mutation can change (the customer, lists, overview, activity).
 *
 * @module
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { errorMessage } from "../types.ts";
import { keys } from "./queries.ts";
import { useToast } from "@xtandard/kit/ui";

/** Options for {@link useCustomerAction}. */
export interface CustomerActionOptions<V, R> {
  /** Toast on success (string, or built from the variables / result). */
  success: string | ((vars: V, result: R) => string);
  /** Toast title on failure; the server's message is the detail. */
  error: string;
  /** Runs after the caches are invalidated (close a dialog, navigate…). */
  onSuccess?: (result: R, vars: V) => void;
}

/** A customer-scoped mutation with toasts and cache invalidation. */
export function useCustomerAction<V, R = unknown>(
  customer: string,
  fn: (vars: V) => Promise<R>,
  options: CustomerActionOptions<V, R>,
) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: fn,
    onSuccess: async (result, vars) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: keys.customer(customer) }),
        qc.invalidateQueries({ queryKey: keys.customers }),
        qc.invalidateQueries({ queryKey: keys.overview }),
        qc.invalidateQueries({ queryKey: keys.activity }),
        qc.invalidateQueries({ queryKey: ["portal"] }),
      ]);
      toast.add(
        "success",
        typeof options.success === "function" ? options.success(vars, result) : options.success,
      );
      options.onSuccess?.(result, vars);
    },
    onError: (error) => toast.add("error", options.error, errorMessage(error)),
  });
}
