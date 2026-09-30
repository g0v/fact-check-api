export type FactCheckInput = { text: string; url?: string };

export type DurableObjectNamespaceLike = {
  idFromName(name: string): unknown;
  get(id: unknown): {
    fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
  };
};

export type ServiceBindingLike = {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
};

export type ApiBindings = {
  PAY_TO?: string;
  X402_NETWORK?: string;
  X402_PRICE?: string;
  FACILITATOR_URL?: string;
  FACILITATOR_AUTH_TOKEN?: string;
  CDP_API_KEY_ID?: string;
  CDP_API_KEY_SECRET?: string;
  RATE_LIMITER?: {
    limit(options: { key: string }): Promise<{ success: boolean }>;
  };
  RATE_LIMIT_WINDOW_MS?: string | number;
  RATE_LIMIT_DO?: DurableObjectNamespaceLike;
  FACT_CHECK_CORE?: ServiceBindingLike;
};

export type ApiEnv = {
  Bindings: ApiBindings;
  Variables: { requestId: string };
};
