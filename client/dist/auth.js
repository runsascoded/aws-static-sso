const DEFAULT_PROXY_URL = "https://aws-static-sso.rbw.sh";
const STORAGE_KEYS = {
    client: (region) => `aws-sso:client:${region}`,
    token: (region) => `aws-sso:token:${region}`,
    startUrl: "aws-sso:startUrl",
    region: "aws-sso:region",
};
export class SSOError extends Error {
    constructor(message, status, body) {
        super(message);
        this.status = status;
        this.body = body;
        this.name = "SSOError";
    }
}
export class SSOAuth {
    constructor(options) {
        this.listeners = [];
        this.startUrl = options.startUrl;
        this.region = options.region;
        this.proxyUrl = (options.proxyUrl || DEFAULT_PROXY_URL).replace(/\/$/, "");
    }
    on(listener) {
        this.listeners.push(listener);
    }
    off(listener) {
        this.listeners = this.listeners.filter(l => l !== listener);
    }
    emit(event) {
        for (const listener of this.listeners) {
            listener(event);
        }
    }
    async request(host, path, body) {
        const url = `${this.proxyUrl}/${host}${path}`;
        const response = await fetch(url, {
            method: body ? "POST" : "GET",
            headers: body ? { "Content-Type": "application/json" } : undefined,
            body: body ? JSON.stringify(body) : undefined,
        });
        if (!response.ok) {
            const text = await response.text();
            throw new SSOError(`AWS SSO request failed: ${response.status}`, response.status, text);
        }
        return response;
    }
    oidcHost() {
        return `oidc.${this.region}.amazonaws.com`;
    }
    portalHost() {
        return `portal.sso.${this.region}.amazonaws.com`;
    }
    loadClient() {
        const raw = localStorage.getItem(STORAGE_KEYS.client(this.region));
        if (!raw)
            return null;
        const client = JSON.parse(raw);
        if (Date.now() >= client.expiresAt) {
            localStorage.removeItem(STORAGE_KEYS.client(this.region));
            return null;
        }
        return client;
    }
    saveClient(client) {
        localStorage.setItem(STORAGE_KEYS.client(this.region), JSON.stringify(client));
    }
    loadToken() {
        const raw = localStorage.getItem(STORAGE_KEYS.token(this.region));
        if (!raw)
            return null;
        const token = JSON.parse(raw);
        if (Date.now() >= token.expiresAt) {
            localStorage.removeItem(STORAGE_KEYS.token(this.region));
            this.emit({ type: "tokenExpired" });
            return null;
        }
        return token;
    }
    saveToken(token) {
        localStorage.setItem(STORAGE_KEYS.token(this.region), JSON.stringify(token));
        localStorage.setItem(STORAGE_KEYS.startUrl, this.startUrl);
        localStorage.setItem(STORAGE_KEYS.region, this.region);
    }
    async registerClient() {
        const existing = this.loadClient();
        if (existing)
            return existing;
        const response = await this.request(this.oidcHost(), "/client/register", {
            clientName: "aws-static-sso",
            clientType: "public",
        });
        const data = await response.json();
        const client = {
            clientId: data.clientId,
            clientSecret: data.clientSecret,
            expiresAt: data.clientSecretExpiresAt * 1000,
        };
        this.saveClient(client);
        return client;
    }
    async startAuth(options) {
        const client = await this.registerClient();
        const response = await this.request(this.oidcHost(), "/device_authorization", {
            clientId: client.clientId,
            clientSecret: client.clientSecret,
            startUrl: this.startUrl,
        });
        const data = await response.json();
        const deviceAuth = {
            deviceCode: data.deviceCode,
            userCode: data.userCode,
            verificationUri: data.verificationUri,
            verificationUriComplete: data.verificationUriComplete,
            expiresIn: data.expiresIn,
            interval: data.interval,
        };
        this.emit({ type: "deviceCodeReady", deviceAuth });
        return deviceAuth;
    }
    async pollForToken(deviceAuth, signal) {
        const client = this.loadClient();
        if (!client)
            throw new Error("No registered client; call startAuth() first");
        let interval = deviceAuth.interval * 1000;
        const deadline = Date.now() + deviceAuth.expiresIn * 1000;
        while (Date.now() < deadline) {
            if (signal?.aborted)
                throw new DOMException("Aborted", "AbortError");
            await new Promise((resolve, reject) => {
                const timer = setTimeout(resolve, interval);
                signal?.addEventListener("abort", () => {
                    clearTimeout(timer);
                    reject(new DOMException("Aborted", "AbortError"));
                }, { once: true });
            });
            try {
                const response = await this.request(this.oidcHost(), "/token", {
                    clientId: client.clientId,
                    clientSecret: client.clientSecret,
                    deviceCode: deviceAuth.deviceCode,
                    grantType: "urn:ietf:params:oauth:grant-type:device_code",
                });
                const data = await response.json();
                const token = {
                    accessToken: data.accessToken,
                    expiresAt: Date.now() + data.expiresIn * 1000,
                    refreshToken: data.refreshToken,
                };
                this.saveToken(token);
                this.emit({ type: "tokenAcquired", token });
                return token;
            }
            catch (err) {
                if (err instanceof SSOError && err.body) {
                    let parsed;
                    try {
                        parsed = JSON.parse(err.body);
                    }
                    catch {
                        throw err;
                    }
                    if (parsed.error === "authorization_pending")
                        continue;
                    if (parsed.error === "slow_down") {
                        interval += 5000;
                        continue;
                    }
                    if (parsed.error === "expired_token") {
                        throw new Error("Device code expired; restart auth flow");
                    }
                }
                throw err;
            }
        }
        throw new Error("Device code expired; restart auth flow");
    }
    getSession() {
        const token = this.loadToken();
        if (!token)
            return null;
        return new SSOSession(token, this.proxyUrl, this.region, this);
    }
    clearStorage() {
        localStorage.removeItem(STORAGE_KEYS.client(this.region));
        localStorage.removeItem(STORAGE_KEYS.token(this.region));
        localStorage.removeItem(STORAGE_KEYS.startUrl);
        localStorage.removeItem(STORAGE_KEYS.region);
    }
}
export class SSOSession {
    constructor(token, proxyUrl, region, auth) {
        this.token = token;
        this.proxyUrl = proxyUrl;
        this.region = region;
        this.auth = auth;
        this.refreshTimer = null;
        this.scheduleRefresh();
    }
    scheduleRefresh() {
        const msUntilExpiry = this.token.expiresAt - Date.now();
        // Refresh 5 minutes before expiry
        const refreshIn = Math.max(0, msUntilExpiry - 5 * 60 * 1000);
        this.refreshTimer = setTimeout(() => {
            this.token = null;
            this.auth["emit"]({ type: "tokenExpired" });
        }, refreshIn);
    }
    portalHost() {
        return `portal.sso.${this.region}.amazonaws.com`;
    }
    async request(path, headers) {
        const url = `${this.proxyUrl}/${this.portalHost()}${path}`;
        const response = await fetch(url, {
            headers: {
                "x-amz-sso_bearer_token": this.token.accessToken,
                ...headers,
            },
        });
        if (!response.ok) {
            const text = await response.text();
            throw new SSOError(`AWS SSO request failed: ${response.status}`, response.status, text);
        }
        return response;
    }
    async listAccounts() {
        const response = await this.request("/assignment/accounts");
        const data = await response.json();
        return data.accountList.map(a => ({
            accountId: a.accountId,
            accountName: a.accountName,
            emailAddress: a.emailAddress,
        }));
    }
    async listAccountRoles(accountId) {
        const response = await this.request(`/assignment/roles?account_id=${encodeURIComponent(accountId)}`);
        const data = await response.json();
        return data.roleList.map(r => ({
            roleName: r.roleName,
            accountId: r.accountId,
        }));
    }
    async getCredentials(options) {
        const params = new URLSearchParams({
            role_name: options.roleName,
            account_id: options.accountId,
        });
        const response = await this.request(`/federation/credentials?${params}`);
        const data = await response.json();
        return {
            accessKeyId: data.roleCredentials.accessKeyId,
            secretAccessKey: data.roleCredentials.secretAccessKey,
            sessionToken: data.roleCredentials.sessionToken,
            expiration: data.roleCredentials.expiration,
        };
    }
    dispose() {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = null;
        }
    }
}
