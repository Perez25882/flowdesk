import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { env, features } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { loadTenantCredentials } from '../whatsapp/client.js';

// Constructed lazily so the process boots without AWS credentials. When media
// storage is unconfigured (local development), inbound media is still recorded
// on the Message row but not archived — see `downloadFromMetaAndUploadToS3`.
let s3ClientInstance: S3Client | null = null;

function getS3Client(): S3Client {
  if (!features.mediaStorage) {
    throw new Error('Media storage is not configured (AWS_* environment variables missing)');
  }

  s3ClientInstance ??= new S3Client({
    region: env.AWS_REGION,
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID as string,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY as string,
    },
  });

  return s3ClientInstance;
}

export interface UploadResult {
  url: string;
  key: string;
}

export async function uploadBufferToS3(
  buffer: Buffer,
  key: string,
  contentType: string,
): Promise<UploadResult> {
  const bucket = env.AWS_S3_BUCKET as string;

  await getS3Client().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    }),
  );

  const url = `https://${bucket}.s3.${env.AWS_REGION}.amazonaws.com/${key}`;
  logger.info({ key, contentType, size: buffer.length }, 'Uploaded media to S3');
  return { url, key };
}

/**
 * Fetches inbound media from Meta with the owning business's own credentials
 * and archives it to S3. Meta's media URLs expire in about five minutes, so
 * this has to happen while the message is being processed.
 */
export async function downloadFromMetaAndUploadToS3(
  mediaId: string,
  businessId: string,
  mimeType: string,
): Promise<UploadResult | null> {
  if (!features.mediaStorage) {
    logger.warn(
      { mediaId, businessId },
      'Media storage not configured — inbound media recorded but not archived',
    );
    return null;
  }

  // Media is fetched with the credentials of the business the message belongs
  // to, matching how outbound sending works (`whatsapp/client.ts`). This used
  // to use the single global `META_ACCESS_TOKEN`, which broke tenant isolation
  // — every business's inbound media travelled on one shared credential — and
  // also meant a deployment with only per-tenant tokens archived nothing,
  // because `features.whatsapp` is false without the global var.
  const credentials = await loadTenantCredentials(businessId);

  if (!credentials) {
    logger.warn(
      { mediaId, businessId },
      'Business has no connected WhatsApp number — cannot fetch media from Meta',
    );
    return null;
  }

  try {
    const metaUrl = `https://graph.facebook.com/${env.META_API_VERSION}/${mediaId}`;
    const metaResponse = await fetch(metaUrl, {
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
      },
    });

    if (!metaResponse.ok) {
      logger.error(
        { status: metaResponse.status, mediaId },
        'Failed to fetch media URL from Meta API',
      );
      return null;
    }

    const metaData = (await metaResponse.json()) as { url: string };
    const downloadUrl = metaData.url;

    if (!downloadUrl) {
      logger.error({ mediaId }, 'Meta API did not return download URL');
      return null;
    }

    const downloadResponse = await fetch(downloadUrl, {
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
      },
    });

    if (!downloadResponse.ok) {
      logger.error(
        { status: downloadResponse.status, mediaId },
        'Failed to download media from Meta',
      );
      return null;
    }

    const arrayBuffer = await downloadResponse.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    // mediaId and mimeType come from the webhook payload. S3 keys are a flat
    // namespace so `..` does not traverse, but the components are still
    // restricted to a safe charset as defence in depth against a crafted id
    // steering the key outside the business's own prefix.
    const safeMediaId = mediaId.replace(/[^a-zA-Z0-9_-]/g, '');
    const extension = (mimeType.split('/')[1] ?? 'bin').replace(/[^a-zA-Z0-9]/g, '');
    const key = `businesses/${businessId}/media/${Date.now()}-${safeMediaId}.${extension}`;

    return uploadBufferToS3(buffer, key, mimeType);
  } catch (error: unknown) {
    logger.error({ error, mediaId }, 'Error downloading/uploading media');
    return null;
  }
}

export function isLikelyMoMoScreenshot(
  mimeType: string,
  caption?: string | null,
): boolean {
  if (!mimeType.startsWith('image/')) return false;

  const paymentKeywords = ['momo', 'mtn', 'vodafone', 'airteltigo', 'payment', 'screenshot', 'receipt', 'transfer', 'paid'];
  if (caption) {
    const lowerCaption = caption.toLowerCase();
    if (paymentKeywords.some((kw) => lowerCaption.includes(kw))) {
      return true;
    }
  }

  return false;
}
