import { DeviceAuth, GetCredentialsOptions, SSOAccount, SSOAuthEventListener, SSOAuthOptions, SSOCredentials, SSORole, StartAuthOptions, TokenData } from "./types.js";
export declare class SSOError extends Error {
    status: number;
    body?: string | undefined;
    constructor(message: string, status: number, body?: string | undefined);
}
export declare class SSOAuth {
    private startUrl;
    private region;
    private proxyUrl;
    private listeners;
    constructor(options: SSOAuthOptions);
    on(listener: SSOAuthEventListener): void;
    off(listener: SSOAuthEventListener): void;
    private emit;
    private request;
    private oidcHost;
    private portalHost;
    private loadClient;
    private saveClient;
    private loadToken;
    private saveToken;
    private registerClient;
    startAuth(options?: StartAuthOptions): Promise<DeviceAuth>;
    pollForToken(deviceAuth: DeviceAuth, signal?: AbortSignal): Promise<TokenData>;
    getSession(): SSOSession | null;
    clearStorage(): void;
}
export declare class SSOSession {
    private token;
    private proxyUrl;
    private region;
    private auth;
    private refreshTimer;
    constructor(token: TokenData, proxyUrl: string, region: string, auth: SSOAuth);
    private scheduleRefresh;
    private portalHost;
    private request;
    listAccounts(): Promise<SSOAccount[]>;
    listAccountRoles(accountId: string): Promise<SSORole[]>;
    getCredentials(options: GetCredentialsOptions): Promise<SSOCredentials>;
    dispose(): void;
}
