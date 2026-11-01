import { CreateQuota, ShareRoom, handleRelayRequest } from "@codemirror-treesitter/relay-core";

/** Global create-admission budget for demo share rooms. */
export class CollabCreateQuota extends CreateQuota<Env> {}

/**
 * Demo share room. It reuses the relay-core share room, so creation is
 * rate-limited and quota-admitted, sessions are authenticated, sockets are
 * size- and rate-limited, and alarms expire and clean up every room.
 */
export class CollabRoom extends ShareRoom<Env> {}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRelayRequest(request, {
      allowedOrigins: env.ALLOWED_ORIGINS,
      createQuota: env.COLLAB_CREATE_QUOTA,
      createRateLimiter: env.CREATE_SHARE_RATE_LIMITER,
      rooms: env.COLLAB_ROOMS,
      sessionRateLimiter: env.SHARE_SESSION_RATE_LIMITER,
      websocketRateLimiter: env.SHARE_WEBSOCKET_RATE_LIMITER,
    });
  },
};
