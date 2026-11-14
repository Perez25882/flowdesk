-- Apply to an isolated synthetic database at 65a6410.
BEGIN;
INSERT INTO businesses (id, name, "ownerName", "waPhoneNumberId", "updatedAt")
VALUES ('g106-upgrade-owner', 'Synthetic shop', 'Synthetic owner', 'g106-upgrade-phone', now());
INSERT INTO customers (id, "businessId", "waNumber", "updatedAt")
VALUES ('g106-upgrade-customer', 'g106-upgrade-owner', '233200000006', now());
INSERT INTO messages (id, "businessId", "customerId", "waMessageId", direction, type, body, processed)
VALUES ('g106-upgrade-echo', 'g106-upgrade-owner', 'g106-upgrade-customer', 'g106-upgrade-echo-provider',
        'OUTBOUND', 'TEXT', 'Synthetic historical outbound row', true);
INSERT INTO whatsapp_text_receipts
  (id, "phoneNumberId", "waMessageId", "businessId", sender, body, "sentAt", "nextAttemptAt")
VALUES
  ('g106-upgrade-pending', 'g106-upgrade-phone', 'g106-upgrade-pending-provider',
   'g106-upgrade-owner', '233200000006', 'Synthetic pending text', now(), now());
COMMIT;
