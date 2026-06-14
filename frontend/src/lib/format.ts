export const fmtInr = (n: number | null | undefined): string => {
  if (n == null) return "—";
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(n);
};

export const fmtNum = (n: number | null | undefined): string => {
  if (n == null) return "—";
  return new Intl.NumberFormat("en-IN").format(n);
};

export const fmtPct = (n: number | null | undefined, digits = 1): string => {
  if (n == null) return "—";
  return `${(n * 100).toFixed(digits)}%`;
};

export const fmtRelative = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const dt = new Date(iso);
  const diffMs = Date.now() - dt.getTime();
  const day = 86400 * 1000;
  const days = Math.floor(diffMs / day);
  if (days < 1) return "today";
  if (days === 1) return "1d ago";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
};

export const fmtDate = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
};

export const sourceColor = (s: string): string => {
  if (s === "pos") return "amber";
  if (s === "ecommerce") return "emerald";
  if (s === "loyalty") return "sky";
  return "neutral";
};

export const sourceLabel = (s: string): string => {
  if (s === "pos") return "POS";
  if (s === "ecommerce") return "Shopify";
  if (s === "loyalty") return "Loyalty";
  return s;
};
