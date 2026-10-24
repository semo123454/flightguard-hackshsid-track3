import type { FastifyRequest, FastifyReply } from 'fastify';
import { hash, type Repository } from '../db/repositories.js';

const inflightByRepository = new WeakMap<Repository, Map<string, { requestHash: string; promise: Promise<{ statusCode: number; response: unknown }> }>>();

export async function withIdempotency(request: FastifyRequest, reply: FastifyReply, repository: Repository, route: string, body: unknown, work: () => Promise<{ statusCode: number; response: unknown }> | { statusCode: number; response: unknown }) {
  const raw = request.headers['idempotency-key'];
  const key = Array.isArray(raw) ? raw[0] : raw;
  if (!key) return work();
  if (key.length > 200) return { statusCode: 400, response: { error: 'Idempotency-Key 过长' } };
  const requestHash = hash(body);
  const inflight = inflightByRepository.get(repository) ?? new Map();
  inflightByRepository.set(repository, inflight);
  const inflightKey = `${route}:${key}`;
  const pending = inflight.get(inflightKey);
  if (pending) {
    if (pending.requestHash !== requestHash) return { statusCode: 409, response: { error: '相同 Idempotency-Key 对应了不同请求体' } };
    reply.header('Idempotency-Replayed', 'true');
    return pending.promise;
  }
  const stored = repository.getIdempotent(key, route, body);
  if (stored?.conflict) return { statusCode: 409, response: { error: '相同 Idempotency-Key 对应了不同请求体' } };
  if (stored && !stored.conflict) {
    reply.header('Idempotency-Replayed', 'true');
    return { statusCode: stored.statusCode, response: stored.response };
  }
  const promise = Promise.resolve().then(work);
  inflight.set(inflightKey, { requestHash, promise });
  try {
    const result = await promise;
    repository.saveIdempotent(key, route, body, result.statusCode, result.response);
    reply.header('Idempotency-Replayed', 'false');
    return result;
  } finally {
    inflight.delete(inflightKey);
  }
}
