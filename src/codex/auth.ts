import { CodexRpcError, type CodexClient } from "./client";

export type CodexAccountClient = Pick<CodexClient, "initialize" | "accountRead" | "startDeviceLogin" | "startBrowserLogin" | "logout" | "onNotification" | "generateIssue"> & Partial<Pick<CodexClient, "generateIssueWithUsage" | "generateProjectContext">>;

export type CodexAccountStatus =
  | { state: "connected"; email?: string; plan?: string }
  | { state: "authorization_required" }
  | { state: "unavailable" };

export type DeviceLogin = { verificationUrl: string; userCode: string };
export type BrowserLogin = { authUrl: string; loginId: string };
export type CodexDiagnostic = { phase: "start" | "initialize" | "account_read" | "login_start" | "login_notification" | "logout"; errorCode: string };
export type CodexLoginCompletionNotifier = () => Promise<void>;

export class CodexAuthError extends Error {
  constructor(public readonly code: "CODEX_LOGIN_DISABLED" | "authorization_required", message: string) {
    super(message);
    this.name = "CodexAuthError";
  }
}

export class CodexAuthService {
  private client?: CodexAccountClient;
  private starting?: Promise<CodexAccountClient>;
  private loginCompleted = false;
  private readonly completedLoginIds = new Set<string>();
  private readonly notifiedLoginAttempts = new Set<string>();
  private currentLoginAttempt?: { key: string; loginId?: string };
  private deviceLoginAttempt = 0;

  constructor(
    private readonly startClient: () => Promise<CodexAccountClient>,
    private readonly onDiagnostic?: (event: CodexDiagnostic) => void,
    private readonly notifyLoginCompleted?: CodexLoginCompletionNotifier,
  ) {}

  async readStatus(): Promise<CodexAccountStatus> {
    let client: CodexAccountClient;
    try {
      client = await this.getClient();
    } catch (error) {
      return { state: "unavailable" };
    }
    try {
      return accountStatus(await client.accountRead());
    } catch (error) {
      this.report("account_read", error);
      if (isAuthorizationError(error)) return { state: "authorization_required" };
      return { state: "unavailable" };
    }
  }

  async startDeviceLogin(): Promise<DeviceLogin> {
    const client = await this.getClient();
    try {
      const login = deviceLogin(await client.startDeviceLogin());
      this.currentLoginAttempt = { key: `device:${++this.deviceLoginAttempt}` };
      return login;
    } catch (error) {
      this.report("login_start", error);
      if (isLoginDisabled(error)) throw new CodexAuthError("CODEX_LOGIN_DISABLED", "Codex device-code login is disabled by this app-server.");
      if (isAuthorizationError(error)) throw new CodexAuthError("authorization_required", "Codex requires authorization before device login can start.");
      throw error;
    }
  }

  async startBrowserLogin(): Promise<BrowserLogin> {
    const client = await this.getClient();
    try {
      const login = browserLogin(await client.startBrowserLogin());
      this.currentLoginAttempt = { key: `login:${login.loginId}`, loginId: login.loginId };
      return login;
    } catch (error) {
      this.report("login_start", error);
      if (isLoginDisabled(error)) throw new CodexAuthError("CODEX_LOGIN_DISABLED", "Codex browser login is disabled by this app-server.");
      throw error;
    }
  }

  isLoginComplete(loginId: string): boolean {
    return this.completedLoginIds.has(loginId);
  }

  async logout(): Promise<void> {
    try {
      await (await this.getClient()).logout();
      this.loginCompleted = false;
    } catch (error) {
      this.report("logout", error);
      if (isAuthorizationError(error)) return;
      throw error;
    }
  }

  async generateIssue(input: Parameters<CodexClient["generateIssue"]>[0]): Promise<ReturnType<CodexClient["generateIssue"]>> {
    const client = await this.getClient();
    const status = accountStatus(await client.accountRead().catch((error: unknown) => { throw authorizationError(error); }));
    if (status.state !== "connected") throw new CodexAuthError("authorization_required", "Codex authorization is required.");
    try {
      return await client.generateIssue(input);
    } catch (error) {
      throw authorizationError(error);
    }
  }

  async generateIssueWithUsage(input: Parameters<CodexClient["generateIssueWithUsage"]>[0]): Promise<Awaited<ReturnType<CodexClient["generateIssueWithUsage"]>>> {
    const client = await this.getClient();
    const status = accountStatus(await client.accountRead().catch((error: unknown) => { throw authorizationError(error); }));
    if (status.state !== "connected") throw new CodexAuthError("authorization_required", "Codex authorization is required.");
    try {
      return client.generateIssueWithUsage ? await client.generateIssueWithUsage(input) : { issue: await client.generateIssue(input) };
    } catch (error) {
      throw authorizationError(error);
    }
  }

  async generateProjectContext(input: Parameters<CodexClient["generateProjectContext"]>[0]): Promise<ReturnType<CodexClient["generateProjectContext"]>> {
    const client = await this.getClient();
    const status = accountStatus(await client.accountRead().catch((error: unknown) => { throw authorizationError(error); }));
    if (status.state !== "connected") throw new CodexAuthError("authorization_required", "Codex authorization is required.");
    if (!client.generateProjectContext) throw new Error("Codex project context generation is unavailable");
    return client.generateProjectContext(input).catch((error: unknown) => { throw authorizationError(error); });
  }

  wasLoginCompleted(): boolean {
    return this.loginCompleted;
  }

  private async getClient(): Promise<CodexAccountClient> {
    if (this.client) return this.client;
    if (!this.starting) {
      this.starting = this.startClient().catch((error: unknown) => {
        this.report("start", error);
        throw error;
      }).then(async (client) => {
        try {
          await client.initialize();
        } catch (error) {
          this.report("initialize", error);
          throw error;
        }
        client.onNotification(({ method, params }) => {
          if (method !== "account/login/completed") return;
          this.handleLoginCompleted(params);
        });
        this.client = client;
        return client;
      }).finally(() => { this.starting = undefined; });
    }
    return this.starting;
  }

  private report(phase: CodexDiagnostic["phase"], error: unknown): void {
    this.onDiagnostic?.({ phase, errorCode: diagnosticCode(error) });
  }

  private handleLoginCompleted(params: unknown): void {
    this.loginCompleted = true;
    const loginId = stringValue(asRecord(params)?.loginId) ?? this.currentLoginAttempt?.loginId;
    if (loginId) this.completedLoginIds.add(loginId);
    const attempt = stringValue(asRecord(params)?.loginId) ?? this.currentLoginAttempt?.key ?? "current-session";
    if (this.notifiedLoginAttempts.has(attempt)) return;
    this.notifiedLoginAttempts.add(attempt);
    if (!this.notifyLoginCompleted) return;
    void this.notifyLoginCompleted().catch((error: unknown) => this.report("login_notification", error));
  }
}

export function maskAccount(status: CodexAccountStatus): string {
  if (status.state !== "connected") return status.state.replace("_", " ");
  return `connected${status.email ? ` (${maskEmail(status.email)}` : ""}${status.plan ? `${status.email ? ", " : " ("}${maskPlan(status.plan)})` : status.email ? ")" : ""}`;
}

function accountStatus(value: unknown): CodexAccountStatus {
  const record = asRecord(value);
  const account = asRecord(record?.account) ?? record;
  const email = stringValue(account?.email);
  const plan = stringValue(account?.plan) ?? stringValue(account?.planType);
  if (email || plan || account?.loggedIn === true || account?.authenticated === true) return { state: "connected", email, plan };
  return { state: "authorization_required" };
}

function deviceLogin(value: unknown): DeviceLogin {
  const record = asRecord(value);
  const verificationUrl = stringValue(record?.verificationUrl) ?? stringValue(record?.verification_url);
  const userCode = stringValue(record?.userCode) ?? stringValue(record?.user_code);
  if (!verificationUrl || !userCode) throw new Error("Codex device login did not return a verification URL and user code.");
  return { verificationUrl, userCode };
}

function browserLogin(value: unknown): BrowserLogin {
  const record = asRecord(value);
  const authUrl = stringValue(record?.authUrl);
  const loginId = stringValue(record?.loginId);
  if (!authUrl || !loginId || record?.type !== "chatgpt") throw new Error("Codex app-server does not support browser login.");
  return { authUrl, loginId };
}

function authorizationError(error: unknown): Error {
  if (isAuthorizationError(error)) return new CodexAuthError("authorization_required", "Codex authorization is required.");
  return error instanceof Error ? error : new Error(String(error));
}

function isAuthorizationError(error: unknown): boolean {
  return error instanceof CodexAuthError || error instanceof CodexRpcError && /authori[sz]|login required/i.test(error.message);
}

function isLoginDisabled(error: unknown): boolean {
  return error instanceof CodexRpcError && /disabled|not supported/i.test(error.message);
}

function diagnosticCode(error: unknown): string {
  if (error instanceof CodexRpcError) return `CODEX_RPC_${error.rpcError.code}`;
  if (error instanceof Error && /timed out/i.test(error.message)) return "CODEX_RPC_TIMEOUT";
  if (error instanceof Error && /closed|exited/i.test(error.message)) return "CODEX_PROCESS_CLOSED";
  return "CODEX_RUNTIME_FAILURE";
}

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  return domain ? `${local.slice(0, 1)}***@${domain}` : "***";
}

function maskPlan(plan: string): string {
  return plan.length <= 2 ? "**" : `${plan.slice(0, 2)}***`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
