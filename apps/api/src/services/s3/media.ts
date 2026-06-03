import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';

const s3Client = new S3Client({
  region: env.AWS_REGION,
  credentials: {
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
  },
});

export interface UploadResult {
  url: string;
  key: string;
}

export async function uploadBufferToS3(
  buffer: Buffer,
  key: string,
  contentType: string,
): Promise<UploadResult> {
  await s3Client.send(
    new PutObjectCommand({
      Bucket: env.AWS_S3_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    }),
  );

  const url = `https://${env.AWS_S3_BUCKET}.s3.${env.AWS_REGION}.amazonaws.com/${key}`;
  logger.info({ key, contentType, size: buffer.length }, 'Uploaded media to S3');
  return { url, key };
}

export async function downloadFromMetaAndUploadToS3(
  mediaId: string,
  businessId: string,
  mimeType: string,
): Promise<UploadResult | null> {
  try {
    const metaUrl = `https://graph.facebook.com/${env.META_API_VERSION}/${mediaId}`;
    const metaResponse = await fetch(metaUrl, {
      headers: {
        Authorization: `Bearer ${env.META_ACCESS_TOKEN}`,
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
        Authorization: `Bearer ${env.META_ACCESS_TOKEN}`,
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
    const extension = mimeType.split('/')[1] ?? 'bin';
    const key = `businesses/${businessId}/media/${Date.now()}-${mediaId}.${extension}`;

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
