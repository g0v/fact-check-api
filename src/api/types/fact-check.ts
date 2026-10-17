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
  PAYMENT_CLAIM_DO?: DurableObjectNamespaceLike;
  // MPP（Machine Payments Protocol）經 Stripe 收款；兩把 secret 同時設定才啟用。
  MPP_SECRET_KEY?: string;
  STRIPE_SECRET_KEY?: string;
  // 選填：固定的 Stripe Tempo 存款地址；未設定時以 Stripe API 查詢或建立。
  MPP_TEMPO_DEPOSIT_ADDRESS?: string;
  MPP_STORE_DO?: DurableObjectNamespaceLike;
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
