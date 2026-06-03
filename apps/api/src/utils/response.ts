import type { FastifyReply } from 'fastify';

export interface ApiSuccess<T> {
  success: true;
  data: T;
  meta?: Record<string, unknown>;
}

export interface ApiError {
  success: false;
  error: string;
  code: string;
}

export interface PaginationMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export function success<T>(
  reply: FastifyReply,
  data: T,
  statusCode = 200,
  meta?: Record<string, unknown>,
): FastifyReply {
  const payload: ApiSuccess<T> = meta ? { success: true, data, meta } : { success: true, data };

  return reply.status(statusCode).send(payload);
}

export function created<T>(reply: FastifyReply, data: T): FastifyReply {
  return success(reply, data, 201);
}

export function paginated<T>(
  reply: FastifyReply,
  data: T[],
  paginationMeta: PaginationMeta,
): FastifyReply {
  return success(reply, data, 200, { pagination: paginationMeta });
}

export function noContent(reply: FastifyReply): FastifyReply {
  return reply.status(204).send();
}
