import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Slide-over panel.
 *
 * Used instead of a modal wherever the user needs to keep the list behind it
 * in view, order detail, navigation, secondary menus. Modals interrupt;
 * sheets sit alongside.
 *
 * Enters on the drawer curve (the iOS easing from Ionic), which decelerates
 * hard at the end and gives the panel a sense of weight. Exit is quicker and
 * on the standard out-curve.
 */

const Sheet = DialogPrimitive.Root;
const SheetTrigger = DialogPrimitive.Trigger;
const SheetClose = DialogPrimitive.Close;
const SheetPortal = DialogPrimitive.Portal;

interface SheetContentProps extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  side?: 'left' | 'right' | 'top' | 'bottom';
}

const SIDE_CLASSES: Record<NonNullable<SheetContentProps['side']>, string> = {
  left: 'inset-y-0 left-0 h-full w-[min(88vw,300px)] border-r data-[state=open]:slide-in-from-left data-[state=closed]:slide-out-to-left',
  right:
    'inset-y-0 right-0 h-full w-[min(92vw,460px)] border-l data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right',
  top: 'inset-x-0 top-0 h-auto border-b data-[state=open]:slide-in-from-top data-[state=closed]:slide-out-to-top',
  bottom:
    'inset-x-0 bottom-0 h-auto max-h-[85dvh] rounded-t-xl border-t pb-[env(safe-area-inset-bottom)] data-[state=open]:slide-in-from-bottom data-[state=closed]:slide-out-to-bottom',
};

const SheetContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  SheetContentProps
>(({ side = 'right', children, className, ...props }, ref) => (
  <SheetPortal>
    <DialogPrimitive.Overlay
      className={cn(
        'fixed inset-0 z-overlay bg-[rgba(17,26,21,0.4)] backdrop-blur-[2px]',
        'data-[state=open]:animate-in data-[state=open]:fade-in data-[state=open]:duration-slow',
        'data-[state=closed]:animate-out data-[state=closed]:fade-out data-[state=closed]:duration-base',
        'ease-out',
      )}
    />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        'fixed z-drawer flex flex-col border-border bg-surface shadow-xl focus:outline-none',
        'data-[state=open]:animate-in data-[state=open]:duration-slow data-[state=open]:ease-drawer',
        'data-[state=closed]:animate-out data-[state=closed]:duration-base data-[state=closed]:ease-out',
        SIDE_CLASSES[side],
        className,
      )}
      {...props}
    >
      {/* A grab handle on the bottom sheet, because that is the sheet a thumb
          actually meets. */}
      {side === 'bottom' ? (
        <div className="flex justify-center pt-2.5" aria-hidden="true">
          <span className="h-1 w-9 rounded-full bg-border-strong" />
        </div>
      ) : null}

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
  </SheetPortal>
));

SheetContent.displayName = DialogPrimitive.Content.displayName;

function SheetHeader({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex shrink-0 flex-col gap-1 border-b border-border-subtle px-5 py-4 pr-12',
        className,
      )}
    >
      {children}
    </div>
  );
}

function SheetTitle({
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

function SheetDescription({
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

function SheetBody({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <div className={cn('fd-overlay-scroll min-h-0 flex-1 overflow-y-auto p-5', className)}>
      {children}
    </div>
  );
}

/** Sticky action row for sheets that end in a decision. */
function SheetFooter({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex shrink-0 items-center gap-2 border-t border-border-subtle bg-surface px-5 py-3.5',
        className,
      )}
    >
      {children}
    </div>
  );
}

export {
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetBody,
  SheetFooter,
  SheetClose,
};
