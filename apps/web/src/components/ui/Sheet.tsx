import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import * as React from 'react';

const Sheet = DialogPrimitive.Root;
const SheetTrigger = DialogPrimitive.Trigger;
const SheetClose = DialogPrimitive.Close;
const SheetPortal = DialogPrimitive.Portal;

interface SheetContentProps extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  side?: 'left' | 'right' | 'top' | 'bottom';
}

const SheetContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  SheetContentProps
>(({ side = 'right', children, ...props }, ref) => {
  const sideClasses = {
    left: 'inset-y-0 left-0 h-full w-[300px] data-[state=open]:animate-in data-[state=open]:slide-in-from-left data-[state=closed]:animate-out data-[state=closed]:slide-out-to-left',
    right: 'inset-y-0 right-0 h-full w-[300px] data-[state=open]:animate-in data-[state=open]:slide-in-from-right data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right',
    top: 'inset-x-0 top-0 h-auto data-[state=open]:animate-in data-[state=open]:slide-in-from-top data-[state=closed]:animate-out data-[state=closed]:slide-out-to-top',
    bottom: 'inset-x-0 bottom-0 h-auto data-[state=open]:animate-in data-[state=open]:slide-in-from-bottom data-[state=closed]:animate-out data-[state=closed]:slide-out-to-bottom',
  };

  return (
    <SheetPortal>
      <DialogPrimitive.Overlay
        className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=open]:fade-in data-[state=closed]:animate-out data-[state=closed]:fade-out"
      />
      <DialogPrimitive.Content
        ref={ref}
        className={`fixed z-50 bg-[var(--color-surface)] border-[var(--color-border)] shadow-lg focus:outline-none ${sideClasses[side]}`}
        {...props}
      >
        {children}
        <DialogPrimitive.Close
          className="absolute right-4 top-4 rounded-[var(--radius-sm)] p-1 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors"
        >
          <X className="h-5 w-5" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </SheetPortal>
  );
});

SheetContent.displayName = DialogPrimitive.Content.displayName;

function SheetHeader({ children, className = '' }: { children: React.ReactNode; className?: string }): React.JSX.Element {
  return (
    <div className={`flex flex-col gap-1 p-5 border-b border-[var(--color-border)] ${className}`}>
      {children}
    </div>
  );
}

function SheetTitle({ children, className = '' }: { children: React.ReactNode; className?: string }): React.JSX.Element {
  return (
    <DialogPrimitive.Title className={`text-lg font-medium text-[var(--color-text-primary)] ${className}`}>
      {children}
    </DialogPrimitive.Title>
  );
}

function SheetDescription({ children, className = '' }: { children: React.ReactNode; className?: string }): React.JSX.Element {
  return (
    <DialogPrimitive.Description className={`text-sm text-[var(--color-text-secondary)] ${className}`}>
      {children}
    </DialogPrimitive.Description>
  );
}

function SheetBody({ children, className = '' }: { children: React.ReactNode; className?: string }): React.JSX.Element {
  return (
    <div className={`p-5 ${className}`}>
      {children}
    </div>
  );
}

export { Sheet, SheetTrigger, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetBody, SheetClose };
