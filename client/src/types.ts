export interface SSOAuthOptions {
	startUrl: string
	region: string
	proxyUrl?: string
}

export interface StartAuthOptions {
	signal?: AbortSignal
}

export interface ClientRegistration {
	clientId: string
	clientSecret: string
	expiresAt: number
}

export interface DeviceAuth {
	deviceCode: string
	userCode: string
	verificationUri: string
	verificationUriComplete: string
	expiresIn: number
	interval: number
}

export interface TokenData {
	accessToken: string
	expiresAt: number
	refreshToken?: string
}

export interface SSOAccount {
	accountId: string
	accountName: string
	emailAddress: string
}

export interface SSORole {
	roleName: string
	accountId: string
}

export interface SSOCredentials {
	accessKeyId: string
	secretAccessKey: string
	sessionToken: string
	expiration: number
}

export interface GetCredentialsOptions {
	accountId: string
	roleName: string
}

export type SSOAuthEventType =
	| "deviceCodeReady"
	| "tokenAcquired"
	| "tokenExpired"
	| "error"

export type SSOAuthEvent =
	| { type: "deviceCodeReady"; deviceAuth: DeviceAuth }
	| { type: "tokenAcquired"; token: TokenData }
	| { type: "tokenExpired" }
	| { type: "error"; error: Error }

export type SSOAuthEventListener = (event: SSOAuthEvent) => void
