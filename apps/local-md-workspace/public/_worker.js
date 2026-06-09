const ROOT_HOST = "grovemd.net";
const APP_ORIGIN = "https://app.grovemd.net";

export default {
  async fetch(request, env) {
    let url = new URL(request.url);

    if (url.hostname.toLowerCase() == ROOT_HOST) {
      let target = new URL(url.pathname + url.search, APP_ORIGIN);
      return Response.redirect(target.href, 301);
    }

    let response = await env.ASSETS.fetch(request);
    if (response.status != 404 || !isNavigationRequest(request)) return response;

    let indexUrl = new URL(request.url);
    indexUrl.pathname = "/index.html";
    indexUrl.search = "";
    return env.ASSETS.fetch(new Request(indexUrl, request));
  },
};

function isNavigationRequest(request) {
  if (request.method != "GET" && request.method != "HEAD") return false;
  if (request.headers.get("Sec-Fetch-Mode") == "navigate") return true;
  return request.headers.get("Accept")?.includes("text/html") ?? false;
}
