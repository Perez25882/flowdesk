import { useEffect, useRef, useState } from 'react';
import { Camera, Check, Truck } from 'lucide-react';
import type { OrderStatus } from '@/types/order';
import {
  useDispatchOrder,
  useMarkDelivered,
  useProofImage,
  useShipment,
  useUploadProof,
} from '@/hooks/useShipment';
import { Button } from '@/components/ui/Button';
import { TextAreaField, TextField } from '@/components/ui/Field';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn } from '@/lib/utils';

/** The API's own ceiling, from services/media/image-file.ts. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ACCEPTED = 'image/jpeg,image/png,image/webp';

function errorMessage(error: unknown): string | null {
  return error instanceof Error ? error.message : null;
}

/**
 * Dispatch, and the photograph that proves it.
 *
 * Courier and tracking are both optional and are presented that way, with no
 * asterisk and no placeholder pretending to be a requirement. Plenty of shops
 * here send an order on a motorbike belonging to someone's cousin, and a form
 * that will not accept that either stops them recording the dispatch at all or
 * teaches them to type "n/a" into a column that then cannot be searched for
 * absence.
 */
export default function DispatchPanel({
  orderId,
  status,
}: {
  orderId: string;
  status: OrderStatus;
}): React.JSX.Element | null {
  const { data: shipment, isLoading } = useShipment(orderId);
  const dispatch = useDispatchOrder(orderId);
  const uploadProof = useUploadProof(orderId);
  const markDelivered = useMarkDelivered(orderId);

  const [courier, setCourier] = useState('');
  const [tracking, setTracking] = useState('');
  const [notes, setNotes] = useState('');
  const [fileError, setFileError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const dispatched = status === 'DISPATCHED';
  const canDispatch = status === 'PROCESSING';
  const settled = status === 'FULFILLED' || status === 'CANCELLED';

  // Nothing to show on an order that has not been packed yet and has no
  // shipment behind it. An empty dispatch form on a PENDING order is an
  // invitation to do the wrong thing.
  if (!canDispatch && !dispatched && !(settled && shipment)) return null;

  if (isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-9 w-full" />
      </div>
    );
  }

  function handleFile(event: React.ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    if (!file) return;

    setFileError(null);

    if (!ACCEPTED.split(',').includes(file.type)) {
      setFileError('Use a JPEG, PNG or WebP photo.');
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setFileError(`That photo is ${(file.size / 1024 / 1024).toFixed(1)}MB. The limit is 5MB.`);
      return;
    }

    const reader = new FileReader();
    reader.onerror = () => setFileError('That file could not be read.');
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === 'string') uploadProof.mutate(result);
    };
    reader.readAsDataURL(file);
  }

  return (
    <div className="space-y-4">
      {canDispatch && (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField
              id="courier"
              label="Courier"
              value={courier}
              onChange={(event) => setCourier(event.target.value)}
              placeholder="Bolt, rider, Speedaf"
            />
            <TextField
              id="trackingNumber"
              label="Tracking number"
              value={tracking}
              onChange={(event) => setTracking(event.target.value)}
              placeholder="If there is one"
            />
          </div>

          <TextAreaField
            id="dispatchNotes"
            label="Note"
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            rows={2}
            placeholder="Anything the rider needs to know"
          />

          <div className="flex flex-wrap items-center gap-3">
            <Button
              onClick={() =>
                dispatch.mutate({
                  ...(courier.trim() ? { courier: courier.trim() } : {}),
                  ...(tracking.trim() ? { trackingNumber: tracking.trim() } : {}),
                  ...(notes.trim() ? { notes: notes.trim() } : {}),
                })
              }
              disabled={dispatch.isPending}
              isLoading={dispatch.isPending}
            >
              <Truck className="mr-1.5 h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
              {dispatch.isPending ? 'Sending' : 'Mark as dispatched'}
            </Button>
            {/* Said before the button is pressed, not after. */}
            <p className="text-xs text-text-muted">
              The customer is messaged straight away, with the courier and tracking if you gave them.
            </p>
          </div>

          {errorMessage(dispatch.error) && (
            <p role="alert" className="text-sm font-medium text-danger">
              {errorMessage(dispatch.error)}
            </p>
          )}
        </>
      )}

      {shipment && (
        <div className="rounded-lg border border-border-subtle bg-surface-sunken p-3.5">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
            {shipment.courier && (
              <>
                <dt className="text-text-muted">Courier</dt>
                <dd className="text-text-primary">{shipment.courier}</dd>
              </>
            )}
            {shipment.trackingNumber && (
              <>
                <dt className="text-text-muted">Tracking</dt>
                <dd className="fd-figure text-text-primary">{shipment.trackingNumber}</dd>
              </>
            )}
            {shipment.notes && (
              <>
                <dt className="text-text-muted">Note</dt>
                <dd className="text-text-secondary">{shipment.notes}</dd>
              </>
            )}
            {!shipment.courier && !shipment.trackingNumber && !shipment.notes && (
              <>
                <dt className="text-text-muted">Sent</dt>
                <dd className="text-text-secondary">No courier recorded</dd>
              </>
            )}
          </dl>

          <ProofOfDispatch
            orderId={orderId}
            hasProof={shipment.hasProof}
            uploading={uploadProof.isPending}
            uploadError={errorMessage(uploadProof.error) ?? fileError}
            onPick={() => fileInput.current?.click()}
            readOnly={settled}
          />

          <input
            ref={fileInput}
            type="file"
            accept={ACCEPTED}
            onChange={handleFile}
            className="hidden"
            // Lets the same photo be chosen twice after a failed upload.
            onClick={(event) => {
              (event.target as HTMLInputElement).value = '';
            }}
          />
        </div>
      )}

      {dispatched && (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="secondary"
            onClick={() => markDelivered.mutate()}
            disabled={markDelivered.isPending}
            isLoading={markDelivered.isPending}
          >
            <Check className="mr-1.5 h-4 w-4" strokeWidth={2} aria-hidden="true" />
            {markDelivered.isPending ? 'Saving' : 'Mark as delivered'}
          </Button>
          {errorMessage(markDelivered.error) && (
            <p role="alert" className="text-sm font-medium text-danger">
              {errorMessage(markDelivered.error)}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function ProofOfDispatch({
  orderId,
  hasProof,
  uploading,
  uploadError,
  onPick,
  readOnly,
}: {
  orderId: string;
  hasProof: boolean;
  uploading: boolean;
  uploadError: string | null;
  onPick: () => void;
  readOnly: boolean;
}): React.JSX.Element {
  const { data: src } = useProofImage(orderId, hasProof);

  // The object URL is owned by this component. Without this every reopen of
  // the drawer leaks another decoded image for as long as the tab lives.
  useEffect(() => {
    return () => {
      if (src) URL.revokeObjectURL(src);
    };
  }, [src]);

  return (
    <div className={cn('mt-3.5 border-t border-border-subtle pt-3.5')}>
      <p className="fd-label mb-2">Proof of dispatch</p>

      {hasProof && src ? (
        <img
          src={src}
          alt="Photograph taken when this order was dispatched"
          className="max-h-56 w-auto rounded-md border border-border-subtle"
        />
      ) : hasProof ? (
        <Skeleton className="h-40 w-full rounded-md" />
      ) : (
        <p className="text-sm text-text-muted">No photo yet.</p>
      )}

      {!readOnly && (
        <Button
          variant="secondary"
          size="sm"
          className="mt-2.5"
          onClick={onPick}
          disabled={uploading}
          isLoading={uploading}
        >
          <Camera className="mr-1.5 h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
          {uploading ? 'Uploading' : hasProof ? 'Replace photo' : 'Add photo'}
        </Button>
      )}

      {uploadError && (
        <p role="alert" className="mt-2 text-sm font-medium text-danger">
          {uploadError}
        </p>
      )}
    </div>
  );
}
