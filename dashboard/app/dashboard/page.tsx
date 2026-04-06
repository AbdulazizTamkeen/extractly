"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import {
  listApiKeys,
  createApiKey,
  revokeApiKey,
  getUsage,
  getSubscription,
  getBillingPortalUrl,
  type ApiKey,
  type UsageInfo,
  type SubscriptionInfo,
} from "@/lib/api";

const PLAN_LABELS: Record<string, string> = {
  free: "Free",
  pro: "Pro",
  business: "Business",
};

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function DashboardPage() {
  const router = useRouter();

  const [token, setToken] = useState<string | null>(null);
  const [email, setEmail] = useState<string>("");
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [usage, setUsage] = useState<UsageInfo | null>(null);
  const [subscription, setSubscription] = useState<SubscriptionInfo | null>(null);
  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyValue, setNewKeyValue] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loadingPortal, setLoadingPortal] = useState(false);

  const loadData = useCallback(async (tok: string) => {
    try {
      const [keysRes, usageRes, subRes] = await Promise.all([
        listApiKeys(tok),
        getUsage(tok),
        getSubscription(tok),
      ]);
      setKeys(keysRes.keys);
      setUsage(usageRes);
      setSubscription(subRes);
    } catch {
      setError("Failed to load data. Please refresh.");
    }
  }, []);

  useEffect(() => {
    const tok = localStorage.getItem("token");
    const em = localStorage.getItem("email") || "";
    if (!tok) {
      router.replace("/login");
      return;
    }
    setToken(tok);
    setEmail(em);
    loadData(tok);
  }, [router, loadData]);

  function logout() {
    localStorage.removeItem("token");
    localStorage.removeItem("email");
    router.push("/login");
  }

  async function handleCreateKey(e: React.FormEvent) {
    e.preventDefault();
    if (!token) return;
    setCreating(true);
    setError("");
    try {
      const res = await createApiKey(token, newKeyName || undefined);
      setNewKeyValue(res.key);
      setNewKeyName("");
      await loadData(token);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create key");
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(id: string) {
    if (!token) return;
    setRevoking(id);
    setError("");
    try {
      await revokeApiKey(token, id);
      setKeys((prev) => prev.filter((k) => k.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to revoke key");
    } finally {
      setRevoking(null);
    }
  }

  async function handleBillingPortal() {
    if (!token) return;
    setLoadingPortal(true);
    try {
      const { url } = await getBillingPortalUrl(token, window.location.href);
      window.location.href = url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to open billing portal");
      setLoadingPortal(false);
    }
  }

  const usageChartData = usage
    ? [
        { name: "Used", value: usage.used, fill: "#3b82f6" },
        {
          name: "Remaining",
          value: usage.limit === null ? usage.used : Math.max(0, (usage.limit ?? 0) - usage.used),
          fill: "#e5e7eb",
        },
      ]
    : [];

  const usagePct =
    usage && usage.limit !== null
      ? Math.min(100, Math.round((usage.used / usage.limit) * 100))
      : null;

  if (!token) return null;

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-4xl mx-auto px-4 h-14 flex items-center justify-between">
          <span className="font-semibold text-lg">Extractly</span>
          <div className="flex items-center gap-4">
            <span className="text-sm text-gray-500">{email}</span>
            <button
              onClick={logout}
              className="text-sm text-gray-600 hover:text-gray-900"
            >
              Logout
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-8 space-y-6">
        {error && (
          <div className="px-4 py-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded">
            {error}
          </div>
        )}

        {/* New key banner */}
        {newKeyValue && (
          <div className="px-4 py-3 bg-green-50 border border-green-200 rounded">
            <p className="text-sm font-medium text-green-800 mb-1">
              API key created — copy it now, it won&apos;t be shown again.
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 bg-white border border-green-200 px-3 py-1.5 rounded text-sm font-mono break-all">
                {newKeyValue}
              </code>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(newKeyValue);
                }}
                className="shrink-0 px-3 py-1.5 text-xs bg-green-600 text-white rounded hover:bg-green-700"
              >
                Copy
              </button>
              <button
                onClick={() => setNewKeyValue(null)}
                className="shrink-0 text-green-600 hover:text-green-800 text-lg leading-none"
              >
                ×
              </button>
            </div>
          </div>
        )}

        {/* Plan card */}
        <section className="bg-white border border-gray-200 rounded-lg p-6">
          <h2 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-3">
            Plan
          </h2>
          {subscription ? (
            <div className="flex items-start justify-between">
              <div>
                <p className="text-2xl font-semibold">
                  {PLAN_LABELS[subscription.plan] ?? subscription.plan}
                </p>
                <p className="text-sm text-gray-500 mt-0.5">
                  {subscription.limit === null
                    ? "Unlimited extractions"
                    : `${subscription.limit.toLocaleString()} extractions / month`}
                </p>
                {subscription.subscription && (
                  <p className="text-xs text-gray-400 mt-1">
                    Status:{" "}
                    <span className="capitalize">
                      {subscription.subscription.status}
                    </span>
                    {subscription.subscription.cancelAtPeriodEnd && (
                      <span className="ml-2 text-yellow-600">
                        · Cancels{" "}
                        {formatDate(subscription.subscription.currentPeriodEnd)}
                      </span>
                    )}
                  </p>
                )}
              </div>
              <div className="flex gap-2">
                {subscription.plan !== "free" && (
                  <button
                    onClick={handleBillingPortal}
                    disabled={loadingPortal}
                    className="px-3 py-1.5 text-sm border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50"
                  >
                    {loadingPortal ? "Loading…" : "Manage billing"}
                  </button>
                )}
                {subscription.plan === "free" && (
                  <a
                    href="/billing/checkout"
                    className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
                  >
                    Upgrade
                  </a>
                )}
              </div>
            </div>
          ) : (
            <div className="h-12 bg-gray-100 rounded animate-pulse" />
          )}
        </section>

        {/* Usage chart */}
        <section className="bg-white border border-gray-200 rounded-lg p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-medium text-gray-500 uppercase tracking-wide">
              Usage — Current Period
            </h2>
            {usage && (
              <span className="text-xs text-gray-400">
                {formatDate(usage.periodStart)} – {formatDate(usage.periodEnd)}
              </span>
            )}
          </div>

          {usage ? (
            <>
              <div className="flex items-baseline gap-2 mb-4">
                <span className="text-3xl font-semibold">
                  {usage.used.toLocaleString()}
                </span>
                <span className="text-sm text-gray-500">
                  {usage.limit !== null
                    ? `/ ${usage.limit.toLocaleString()} extractions`
                    : "extractions (unlimited)"}
                </span>
                {usagePct !== null && (
                  <span
                    className={`ml-auto text-sm font-medium ${
                      usagePct >= 80 ? "text-yellow-600" : "text-gray-500"
                    }`}
                  >
                    {usagePct}%
                  </span>
                )}
              </div>

              <ResponsiveContainer width="100%" height={120}>
                <BarChart
                  data={usageChartData}
                  margin={{ top: 0, right: 0, left: -20, bottom: 0 }}
                  barSize={48}
                >
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                  <YAxis tick={{ fontSize: 12 }} />
                  <Tooltip
                    formatter={(value: number) =>
                      value.toLocaleString() + " extractions"
                    }
                  />
                  <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                    {usageChartData.map((entry, index) => (
                      <Cell key={index} fill={entry.fill} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </>
          ) : (
            <div className="h-36 bg-gray-100 rounded animate-pulse" />
          )}
        </section>

        {/* API Keys */}
        <section className="bg-white border border-gray-200 rounded-lg p-6">
          <h2 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-4">
            API Keys
          </h2>

          <form onSubmit={handleCreateKey} className="flex gap-2 mb-4">
            <input
              type="text"
              value={newKeyName}
              onChange={(e) => setNewKeyName(e.target.value)}
              placeholder="Key name (optional)"
              className="flex-1 px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              type="submit"
              disabled={creating}
              className="px-4 py-2 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:opacity-50"
            >
              {creating ? "Creating…" : "+ New key"}
            </button>
          </form>

          {keys.length === 0 ? (
            <p className="text-sm text-gray-400 py-4 text-center">
              No API keys yet. Create one above.
            </p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {keys.map((key) => (
                <li key={key.id} className="py-3 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <code className="text-sm font-mono text-gray-700">
                        {key.prefix}••••••••
                      </code>
                      {key.name && (
                        <span className="text-sm text-gray-500">
                          — {key.name}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-gray-400 mt-0.5">
                      Created {formatDate(key.createdAt)}
                      {key.lastUsedAt
                        ? ` · Last used ${formatDate(key.lastUsedAt)}`
                        : " · Never used"}
                    </p>
                  </div>
                  <button
                    onClick={() => handleRevoke(key.id)}
                    disabled={revoking === key.id}
                    className="shrink-0 px-3 py-1 text-xs text-red-600 border border-red-200 rounded hover:bg-red-50 disabled:opacity-50"
                  >
                    {revoking === key.id ? "Revoking…" : "Revoke"}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}
