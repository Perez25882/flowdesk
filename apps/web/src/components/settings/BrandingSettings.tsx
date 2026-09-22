import { useEffect, useRef, useState } from 'react';
import { ImagePlus, Receipt } from 'lucide-react';
import {
  ACCEPTED_IMAGE_TYPES,
  readFileAsDataUrl,
  useProductImage,
} from '@/hooks/useProducts';
import { useBusiness, useUpdateBusiness } from '@/hooks/useBusiness';
import { useLogo, useUploadLogo } from '@/hooks/useBranding';
import { Button } from '@/components/ui/Button';
import { Panel, PanelHead } from '@/components/ui/Panel';

/**
 * The shop's logo, and whether customers get a receipt.
 *
 * Both live here because they are the same thing from the customer's side: what
 * arrives after they pay. A receipt is the cheapest branding a small shop will
 * ever get, their name and mark, in a message the customer keeps and forwards
 * to whoever asked them to buy it.
 */
export default function BrandingSettings(): React.JSX.Element {
  const fileInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: business } = useBusiness();
  const updateBusiness = useUpdateBusiness();
  const { data: logo } = useLogo();
  const uploadLogo = useUploadLogo();

  // The logo is served through the API like every other private image, so it
  // cannot be an <img src>, the access token lives in memory.
  const { src } = useProductImage(logo?.path ?? null);

  const [receiptsEnabled, setReceiptsEnabled] = useState(true);
  useEffect(() => {
    if (business) setReceiptsEnabled(business.receiptsEnabled ?? true);
  }, [business]);

  async function handleFile(file: File | undefined): Promise<void> {
    if (!file) return;
    setError(null);
    try {
      const data = await readFileAsDataUrl(file);
      await uploadLogo.mutateAsync(data);
    } catch (uploadError: unknown) {
      setError(uploadError instanceof Error ? uploadError.message : 'That logo could not be saved.');
    }
    if (fileInput.current) fileInput.current.value = '';
  }

  return (
    <Panel>
      <PanelHead title="Your brand" meta="What a customer sees after they pay" />

      <div className="flex flex-col gap-5 p-4">
        <div className="flex items-start gap-4">
          <span className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-surface-hover">
            {src ? (
              <img src={src} alt="Your logo" className="h-full w-full object-contain" />
            ) : (
              <ImagePlus className="h-6 w-6 text-text-muted" strokeWidth={1.5} aria-hidden="true" />
            )}
          </span>

          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <span className="text-sm font-medium text-text-primary">Logo</span>
            <p className="text-xs text-text-muted">
              Sent with every receipt. A square image works best. WhatsApp crops anything
              else. JPG, PNG or WebP, under 2 MB.
            </p>
            <div>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => fileInput.current?.click()}
                isLoading={uploadLogo.isPending}
              >
                {logo?.path ? 'Replace logo' : 'Add a logo'}
              </Button>
            </div>
            {error && (
              <p role="alert" className="text-xs text-danger">
                {error}
              </p>
            )}
          </div>
        </div>

        <input
          ref={fileInput}
          type="file"
          accept={ACCEPTED_IMAGE_TYPES}
          className="sr-only"
          onChange={(event) => void handleFile(event.target.files?.[0])}
        />

        <label className="flex items-start gap-3 border-t border-border-subtle pt-4">
          <input
            type="checkbox"
            checked={receiptsEnabled}
            onChange={(e) => {
              setReceiptsEnabled(e.target.checked);
              updateBusiness.mutate({ receiptsEnabled: e.target.checked });
            }}
            className="mt-0.5 h-4 w-4 rounded border-border text-primary focus-visible:ring-2 focus-visible:ring-primary"
          />
          <span className="min-w-0">
            <span className="flex items-center gap-1.5 text-sm font-medium text-text-primary">
              <Receipt className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
              Send a receipt when a payment confirms
            </span>
            <span className="mt-0.5 block text-xs text-text-muted">
              A customer who has just sent money to a shop they found on WhatsApp has
              nothing until this arrives, and &ldquo;did it go through?&rdquo; is the
              message that follows every payment without one.
            </span>
          </span>
        </label>
      </div>
    </Panel>
  );
}
