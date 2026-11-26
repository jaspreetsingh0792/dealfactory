// Site settings for whoever hosts this copy of DealFactory. Nothing here is secret.
export const CONFIG = {
  callbackPath: "oauth.html",
  // Google Cloud OAuth client (type "Web application") for read-only Gmail import.
  // Add this site's address under "Authorized JavaScript origins" and <site>/oauth.html under
  // "Authorized redirect URIs". Leave empty to hide Gmail import. See docs/connections.md.
  googleClientId: "",

  // Public URL of the Claude.ai connector (connector/ in the repo, deployed to Cloudflare Workers).
  // Leave empty until it's deployed.
  connectorUrl: "",
};
