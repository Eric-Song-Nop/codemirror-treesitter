import { CreateQuota, ShareRoom, handleRelayRequest } from "@codemirror-treesitter/relay-core";

export type { CreateQuotaReservationResult } from "@codemirror-treesitter/relay-core";

/**
 * One deliberately global, low-throughput coordinator for exact create
 * admission. Edge Rate Limit bindings smooth traffic but cannot enforce a
 * deployment-wide storage budget.
 */
export class GroveCreateQuota extends CreateQuota<Env> {}

/** Grove shared-file room: share lifecycle, sessions, persistence, and relay. */
export class GroveShareRoom extends ShareRoom<Env> {}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRelayRequest(request, {
      allowedOrigins: env.ALLOWED_ORIGINS,
      createQuota: env.GROVE_CREATE_QUOTA,
      createRateLimiter: env.CREATE_SHARE_RATE_LIMITER,
      rooms: env.GROVE_SHARE_ROOMS,
      sessionRateLimiter: env.SHARE_SESSION_RATE_LIMITER,
      websocketRateLimiter: env.SHARE_WEBSOCKET_RATE_LIMITER,
    });
  },
};
