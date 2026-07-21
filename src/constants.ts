// Shared constants for the extension.
//
// The built-in proxy is the upstream, publicly hosted gtr-proxy instance.
// It is convenient for a quick start, but since it is a shared instance,
// anyone who discovers its URL can use it for their own transloads unless
// it is configured with an auth token. See the README for guidance on
// running and securing a private instance.
export const BUILT_IN_PROXY_BASE = "https://gtr-proxy.677472.xyz";

// Query parameter used to carry an optional pre-shared auth token to a
// gtr-proxy instance. The proxy is expected to reject requests missing a
// valid token when it has been configured to require one, and to strip the
// parameter before forwarding the request upstream.
export const PROXY_TOKEN_PARAM = "gtr_token";
