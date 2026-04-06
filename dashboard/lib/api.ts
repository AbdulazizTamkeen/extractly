const API_BASE =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000";

export interface ApiKey {
  id: string;
  prefix: string;
  name: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface UsageInfo {
  tier: string;
  used: number;
  limit: number | null;
  remaining: number | null;
  periodStart: string;
  periodEnd: string;
}

export interface SubscriptionInfo {
  plan: string;
  used: number;
  limit: number | null;
  nearLimit: boolean;
  periodStart: string;
  subscription: {
    status: string;
    currentPeriodEnd: string;
    cancelAtPeriodEnd: boolean;
  } | null;
  upgradeCta: string | null;
}

async function request<T>(
  path: string,
  options: RequestInit & { token?: string } = {}
): Promise<T> {
  const { token, ...fetchOptions } = options;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(fetchOptions.headers as Record<string, string>),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, {
    ...fetchOptions,
    headers,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || body.message || `HTTP ${res.status}`);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export function login(email: string, password: string) {
  return request<{ token: string; userId: string }>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

export function register(email: string, password: string) {
  return request<{ token: string; userId: string }>("/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

export function listApiKeys(token: string) {
  return request<{ keys: ApiKey[] }>("/auth/keys", { token });
}

export function createApiKey(token: string, name?: string) {
  return request<{ id: string; key: string; prefix: string; name: string | null; createdAt: string }>(
    "/auth/keys",
    { method: "POST", token, body: JSON.stringify({ name: name || undefined }) }
  );
}

export function revokeApiKey(token: string, id: string) {
  return request<undefined>(`/auth/keys/${id}`, { method: "DELETE", token });
}

export function getUsage(token: string) {
  return request<UsageInfo>("/usage", { token });
}

export function getSubscription(token: string) {
  return request<SubscriptionInfo>("/billing/subscription", { token });
}

export function getBillingPortalUrl(token: string, returnUrl: string) {
  return request<{ url: string }>("/billing/portal", {
    method: "POST",
    token,
    body: JSON.stringify({ returnUrl }),
  });
}
