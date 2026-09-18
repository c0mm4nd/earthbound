export function getAppOrigin(requestHeaders: Pick<Headers, "get">) {
  const configuredUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (configuredUrl) {
    return new URL(configuredUrl.includes("://") ? configuredUrl : `https://${configuredUrl}`).origin;
  }

  const host = requestHeaders.get("x-forwarded-host")?.split(",")[0].trim()
    || requestHeaders.get("host")
    || process.env.RAILWAY_PUBLIC_DOMAIN;
  const forwardedProto = requestHeaders.get("x-forwarded-proto")?.split(",")[0].trim();
  const protocol = forwardedProto === "http" || forwardedProto === "https"
    ? forwardedProto
    : process.env.NODE_ENV === "development" ? "http" : "https";
  return host ? `${protocol}://${host}` : "http://localhost:3000";
}
