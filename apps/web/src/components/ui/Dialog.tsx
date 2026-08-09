import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Modal dialog.
 *
 * Motion notes:
 *   - Enters from scale(0.96), never scale(0). Nothing in the physical world
 *     appears out of nothing, and a zoom from zero reads as a pop-up ad.
 *   - transform-origin stays centred. Origin-aware scaling is right for
 *     popovers anchored to a trigger; a modal is anchored to the viewport.
 *   - Exit is faster than entry. The user has already decided to leave.
 */

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogClose = DialogPrimitive.Close;
const DialogPortal = DialogPrimitive.Portal;

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      'fixed inset-0 z-overlay bg-[rgba(17,26,21,0.4)] backdrop-blur-[2px]',
      'data-[state=open]:animate-in data-[state=open]:fade-in data-[state=open]:duration-base',
      'data-[state=closed]:animate-out data-[state=closed]:fade-out data-[state=closed]:duration-fast',
      'ease-out',
      className,
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        'fixed left-1/2 top-1/2 z-dialog w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2',
        'fd-overlay-scroll max-h-[calc(100dvh-3rem)] overflow-y-auto',
        'rounded-lg border border-border bg-surface shadow-xl focus:outline-none',
        'data-[state=open]:animate-in data-[state=open]:fade-in data-[state=open]:zoom-in-95 data-[state=open]:duration-base',
        'data-[state=closed]:animate-out data-[state=closed]:fade-out data-[state=closed]:zoom-out-95 data-[state=closed]:duration-fast',
        'ease-out',
        className,
      )}
      {...props}
    >
      {children}
      <DialogPrimitive.Close
        className={cn(
          'absolute right-2 top-2 flex h-11 w-11 items-center justify-center rounded-md sm:right-3 sm:top-3 sm:h-8 sm:w-8',
          'text-text-muted transition-colors duration-fast ease-out',
          'hover:bg-surface-hover hover:text-text-primary',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
        )}
      >
        <X className="h-4 w-4" strokeWidth={2} />
        <span className="sr-only">Close</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPortal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

function DialogHeader({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <div className={cn('flex flex-col gap-1 border-b border-border-subtle px-5 py-4 pr-12', className)}>
      {children}
    </div>
  );
}

/** Sticky action row. Keeps Save reachable when a long form scrolls. */
function DialogFooter({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex items-center justify-end gap-2 border-t border-border-subtle bg-surface px-5 py-3.5',
        className,
      )}
    >
      {children}
    </div>
  );
}

function DialogBody({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return <div className={cn('px-5 py-4', className)}>{children}</div>;
}

function DialogTitle({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <DialogPrimitive.Title
      className={cn('text-lg font-extrabold tracking-tight text-text-primary', className)}
    >
      {children}
    </DialogPrimitive.Title>
  );
}

function DialogDescription({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <DialogPrimitive.Description className={cn('text-sm text-text-secondary', className)}>
      {children}
    </DialogPrimitive.Description>
  );
}

export {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogBody,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  DialogClose,
};
