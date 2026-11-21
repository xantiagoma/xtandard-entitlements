import * as React from "react";
import { Dialog } from "@base-ui-components/react/dialog";
import { cn } from "../lib/utils.ts";
import { portalContainerRef } from "../lib/portal-container.ts";
import { Button } from "./ui-bits.tsx";

/* ─── Field ─────────────────────────────────────────────────────────────────── */

/**
 * A labelled form control with an optional hint and a validation error. The
 * error is announced (`role="alert"`) and wired to the control through
 * `aria-describedby` by the caller via {@link fieldIds}.
 */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
  className,
}: {
  label: React.ReactNode;
  htmlFor: string;
  hint?: React.ReactNode;
  error?: string | null;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={htmlFor} className="text-[12px] font-medium text-foreground">
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${htmlFor}-error`} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : hint ? (
        <p id={`${htmlFor}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** `aria-*` props connecting a control to its {@link Field} error / hint. */
export function fieldIds(id: string, error?: string | null): React.AriaAttributes {
  return error
    ? { "aria-invalid": true, "aria-describedby": `${id}-error` }
    : { "aria-describedby": `${id}-hint` };
}

/* ─── NativeSelect ──────────────────────────────────────────────────────────── */

/** A styled native `<select>` (keyboard- and form-friendly; used inside dialogs). */
export const NativeSelect = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(function NativeSelect({ className, children, ...props }, ref) {
  return (
    <select
      ref={ref}
      className={cn(
        "h-9 w-full rounded-md border border-input bg-secondary/40 px-2.5 text-[13px] text-foreground outline-none transition-colors",
        "hover:bg-secondary/60 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      {children}
    </select>
  );
});

/* ─── Checkbox ──────────────────────────────────────────────────────────────── */

export function CheckboxField({
  id,
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  id: string;
  label: React.ReactNode;
  description?: React.ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label htmlFor={id} className="flex cursor-pointer items-start gap-2.5">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-4 shrink-0 accent-[var(--accent)]"
      />
      <span className="flex flex-col">
        <span className="text-[13px] font-medium text-foreground">{label}</span>
        {description ? <span className="text-xs text-muted-foreground">{description}</span> : null}
      </span>
    </label>
  );
}

/* ─── FormDialog ────────────────────────────────────────────────────────────── */

/**
 * A modal whose body and footer live in one `<form>`: Enter submits, the
 * submit button shows a spinner while `loading`, and the dialog stays open on
 * a failed submit (the caller toasts the error).
 */
export function FormDialog({
  open,
  onClose,
  title,
  description,
  submitLabel,
  onSubmit,
  loading,
  danger,
  wide,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  submitLabel: string;
  onSubmit: () => void;
  loading?: boolean;
  danger?: boolean;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal container={portalContainerRef()}>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />
        <Dialog.Popup
          className={cn(
            "fixed left-1/2 top-1/2 z-50 flex max-h-[88vh] w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-border bg-card shadow-2xl outline-none",
            wide ? "max-w-2xl" : "max-w-md",
          )}
        >
          <form
            noValidate
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={(e) => {
              e.preventDefault();
              if (!loading) onSubmit();
            }}
          >
            <div className="border-b border-border px-5 py-4">
              <Dialog.Title className="text-[15px] font-semibold text-foreground">
                {title}
              </Dialog.Title>
              {description ? (
                <Dialog.Description className="mt-1 text-xs text-muted-foreground">
                  {description}
                </Dialog.Description>
              ) : null}
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-5">
              {children}
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
              <Button type="button" variant="secondary" onClick={onClose} disabled={loading}>
                Cancel
              </Button>
              <Button type="submit" variant={danger ? "danger" : "primary"} loading={loading}>
                {submitLabel}
              </Button>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
