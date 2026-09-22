import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { success, created } from '../../utils/response.js';
import { CreateProductSchema, UpdateProductSchema, StockAdjustmentSchema, ListProductsQuerySchema } from './products.schema.js';
import { UploadProductImageSchema, ReorderProductImagesSchema } from './product-images.schema.js';
import { z } from 'zod';
import { IMPORT_TEMPLATE_CSV } from './catalogue-import.js';
import * as catalogueImport from './catalogue-import.service.js';
import { MAX_IMAGE_BYTES } from '../../services/media/image-file.js';
import { requireCapability } from '../../middleware/role.middleware.js';
import * as service from './products.service.js';
import * as images from './product-images.service.js';

/**
 * Body limit for a photo upload.
 *
 * Only this one route gets it. The global limit stays where it is, because the
 * rest of the API accepts nothing bigger than an order, and raising it
 * everywhere to accommodate images would mean every other endpoint would
 * happily buffer several megabytes before Zod ever sees the request. The number
 * is the 5 MB cap plus base64's 4/3 inflation plus room for the JSON around it.
 */
const IMAGE_UPLOAD_BODY_LIMIT = Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4096;

/**
 * A catalogue file is text, and 2000 rows of it is comfortably under a
 * megabyte — but the global body limit is smaller than that, and a shop with a
 * real catalogue would hit it on their first attempt.
 */
const IMPORT_BODY_LIMIT = 4 * 1024 * 1024;

const ImportCatalogueSchema = z.object({
  /** The file's text, as read by the browser. */
  csv: z.string().min(1).max(IMPORT_BODY_LIMIT),
  /**
   * Whether a name that already exists is updated or skipped.
   *
   * Defaults to updating, because re-importing a corrected price list is what
   * an owner means by "import" the second time, and the alternative silently
   * ignores the very rows they came back to fix.
   */
  updateExisting: z.boolean().default(true),
});

export default async function productRoutes(app: FastifyInstance): Promise<void> {
  const canRead = { preHandler: requireCapability('products.read') };
  const canWrite = { preHandler: requireCapability('products.write') };

  app.post('/products', canWrite, async (request: FastifyRequest, reply: FastifyReply) => {
    const data = CreateProductSchema.parse(request.body);
    const product = await service.createProduct(data, request.business!.id);
    return created(reply, product);
  });

  app.get('/products', canRead, async (request: FastifyRequest, reply: FastifyReply) => {
    const query = ListProductsQuerySchema.parse(request.query);
    const products = await service.listProducts(request.business!.id, query);
    return success(reply, await images.attachImages(products, request.business!.id));
  });

  app.get('/products/low-stock', canRead, async (request: FastifyRequest, reply: FastifyReply) => {
    const products = await service.getLowStockProducts(request.business!.id);
    return success(reply, products);
  });

  app.get('/products/:id', canRead, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const product = await service.findProductById(id, request.business!.id);
    if (!product) return reply.status(404).send({ success: false, error: 'Product not found', code: 'NOT_FOUND' });
    const [withImages] = await images.attachImages([product], request.business!.id);
    return success(reply, withImages);
  });

  app.patch('/products/:id', canWrite, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const data = UpdateProductSchema.parse(request.body);
    const product = await service.updateProduct(id, request.business!.id, data);
    return success(reply, product);
  });

  app.delete(
    '/products/:id',
    { preHandler: requireCapability('products.delete') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      await service.deleteProduct(id, request.business!.id);
      return reply.status(204).send();
    },
  );

  // ── Catalogue import ──────────────────────────────────────────────────────

  app.get('/products/import/template', canRead, async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', 'attachment; filename="flowdesk-products.csv"')
      .send(IMPORT_TEMPLATE_CSV);
  });

  // Preview is a POST because it carries the file, not because it changes
  // anything — it writes nothing, and is safe to call as many times as the
  // owner wants to look before committing.
  app.post(
    '/products/import/preview',
    { ...canWrite, bodyLimit: IMPORT_BODY_LIMIT },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { csv } = ImportCatalogueSchema.parse(request.body);
      return success(reply, await catalogueImport.previewImport(request.business!.id, csv));
    },
  );

  app.post(
    '/products/import',
    { ...canWrite, bodyLimit: IMPORT_BODY_LIMIT },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { csv, updateExisting } = ImportCatalogueSchema.parse(request.body);
      const result = await catalogueImport.commitImport(request.business!.id, csv, {
        updateExisting,
      });
      return created(reply, result);
    },
  );

  // ── Photos ────────────────────────────────────────────────────────────────

  app.get('/products/:id/images', canRead, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    return success(reply, await images.listImages(id, request.business!.id));
  });

  app.post(
    '/products/:id/images',
    { ...canWrite, bodyLimit: IMAGE_UPLOAD_BODY_LIMIT },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const { data } = UploadProductImageSchema.parse(request.body);
      const image = await images.addImage(id, request.business!.id, data);
      return created(reply, image);
    },
  );

  app.patch(
    '/products/:id/images/order',
    canWrite,
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const { imageIds } = ReorderProductImagesSchema.parse(request.body);
      return success(reply, await images.reorderImages(id, request.business!.id, imageIds));
    },
  );

  app.delete(
    '/products/:id/images/:imageId',
    canWrite,
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id, imageId } = request.params as { id: string; imageId: string };
      await images.removeImage(id, imageId, request.business!.id);
      return reply.status(204).send();
    },
  );

  app.get(
    '/products/:id/images/:imageId/file',
    canRead,
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id, imageId } = request.params as { id: string; imageId: string };
      const media = await images.readImageFile(id, imageId, request.business!.id);

      // A product photo belongs to one shop's catalogue, so it is cacheable by
      // the browser that asked and by nothing in between. An immutable key
      // means a long max-age is safe: the bytes behind an image id never
      // change — replacing a photo creates a new one.
      // `inline` states the intent explicitly rather than leaving it to the
      // browser's default. Defence in depth only: the type here is always one
      // of the three the uploader established by reading the file's magic
      // bytes, helmet already sends `X-Content-Type-Options: nosniff`, and this
      // route needs an Authorization header — so no ambient credential can
      // reach it from a foreign page. It costs nothing to say so anyway.
      return reply
        .header('Content-Type', media.contentType)
        .header('Content-Disposition', 'inline')
        .header('Cache-Control', 'private, max-age=86400, immutable')
        .send(media.body);
    },
  );

  app.post('/products/:id/stock', canWrite, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const data = StockAdjustmentSchema.parse(request.body);
    const product = await service.adjustStock(
      id,
      request.business!.id,
      data,
      request.user?.staffId ?? null,
    );
    return success(reply, product);
  });
}
