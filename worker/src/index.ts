const REGION_RE = /^(us|eu|ap|ca|sa|me|af|il|cn|us-gov)-(north|south|east|west|central|northeast|northwest|southeast|southwest)-\d+$/

const CORS_HEADERS: Record<string, string> = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type, Authorization, x-amz-sso_bearer_token",
	"Access-Control-Expose-Headers": "*",
	"Access-Control-Max-Age": "86400",
}

function corsResponse(status: number, body?: string): Response {
	return new Response(body, { status, headers: CORS_HEADERS })
}

function parseTarget(url: URL): { host: string; path: string } | null {
	// URL path format: /<aws-host>/<rest-of-path>
	// e.g. /oidc.us-east-1.amazonaws.com/client/register
	const match = url.pathname.match(/^\/([^/]+)(\/.*)?$/)
	if (!match) return null
	return { host: match[1], path: match[2] || "/" }
}

function isAllowedHost(host: string): boolean {
	// oidc.{region}.amazonaws.com
	const oidcMatch = host.match(/^oidc\.(.+)\.amazonaws\.com$/)
	if (oidcMatch) return REGION_RE.test(oidcMatch[1])

	// portal.sso.{region}.amazonaws.com
	const portalMatch = host.match(/^portal\.sso\.(.+)\.amazonaws\.com$/)
	if (portalMatch) return REGION_RE.test(portalMatch[1])

	return false
}

export default {
	async fetch(request: Request): Promise<Response> {
		if (request.method === "OPTIONS") {
			return corsResponse(204)
		}

		const url = new URL(request.url)
		const target = parseTarget(url)
		if (!target) return corsResponse(400, "Invalid request path")
		if (!isAllowedHost(target.host)) return corsResponse(403, `Host not allowed: ${target.host}`)

		const targetUrl = `https://${target.host}${target.path}${url.search}`
		const headers = new Headers(request.headers)
		headers.set("Host", target.host)
		headers.delete("Origin")

		const response = await fetch(targetUrl, {
			method: request.method,
			headers,
			body: request.body,
		})

		const responseHeaders = new Headers(response.headers)
		for (const [key, value] of Object.entries(CORS_HEADERS)) {
			responseHeaders.set(key, value)
		}

		return new Response(response.body, {
			status: response.status,
			headers: responseHeaders,
		})
	},
} satisfies ExportedHandler
