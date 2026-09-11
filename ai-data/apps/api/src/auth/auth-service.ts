import { createHash, randomBytes } from "node:crypto";

import type {
  AuthContext,
  AuthRepository,
  AuthSession,
  AuthUser,
  UserAdminRepository,
  UserStatus,
} from "./auth-types";
import { AuthContextCache } from "./auth-context-cache";
import type { JwtService } from "./jwt-service";
import { verifyPassword } from "./password";

/** 登录或刷新成功后返回给浏览器的令牌和用户摘要。 */
type LoginResult = {
  /** 短时有效的 API Access JWT。 */
  accessToken: string;
  /** 服务端可轮换的 Refresh Token 明文。 */
  refreshToken: string;
  /** Access JWT 有效期，单位为秒。 */
  expiresIn: number;
  /** 不含密码和权限细节的当前用户资料。 */
  user: Pick<AuthUser, "id" | "organizationId" | "username" | "displayName">;
};

/** 构造认证服务所需的基础设施依赖。 */
type AuthServiceDependencies = {
  /** 本地认证、会话和授权数据仓储。 */
  repository: AuthRepository;
  /** API 自有 Access JWT 签发与校验服务。 */
  jwt: JwtService;
  /** 可选的进程内身份上下文缓存。 */
  contextCache?: AuthContextCache;
};

/** 以固定摘要保存 Refresh Token，避免服务端持久化令牌明文。 */
function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** 生成 Refresh Token 中不含会话主键的随机部分。 */
function createRefreshToken(): string {
  return randomBytes(32).toString("base64url");
}

/** 本地账号认证、Refresh Token 轮换和当前身份装载服务。 */
class AuthService {
  constructor(private readonly dependencies: AuthServiceDependencies) {}

  /** 校验本地账号并创建 API 自己的会话与令牌。 */
  async login(username: string, password: string): Promise<LoginResult> {
    const user = await this.dependencies.repository.findUserByUsername(username);
    if (
      !user ||
      user.status !== "active" ||
      !user.passwordHash ||
      !(await verifyPassword(password, user.passwordHash))
    ) {
      throw new Error("账号或密码错误");
    }

    const refreshToken = `${crypto.randomUUID()}.${createRefreshToken()}`;
    const session: AuthSession = {
      id: refreshToken.split(".")[0],
      userId: user.id,
      refreshTokenHash: hashRefreshToken(refreshToken),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      revokedAt: null,
    };
    await this.dependencies.repository.createSession(session);
    const accessToken = await this.dependencies.jwt.signAccessToken({
      userId: user.id,
      sessionId: session.id,
      organizationId: user.organizationId,
      authorizationVersion: user.authorizationVersion,
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: this.dependencies.jwt.accessTokenTtlSeconds,
      user: {
        id: user.id,
        organizationId: user.organizationId,
        username: user.username,
        displayName: user.displayName,
      },
    };
  }

  /** 轮换 Refresh Token 并签发新的短时 Access JWT。 */
  async refresh(refreshToken: string): Promise<LoginResult> {
    const sessionId = refreshToken.split(".")[0];
    const session = await this.dependencies.repository.findSessionById(sessionId);
    if (
      !session ||
      session.revokedAt ||
      session.expiresAt.getTime() <= Date.now() ||
      session.refreshTokenHash !== hashRefreshToken(refreshToken)
    ) {
      throw new Error("刷新令牌无效或已过期");
    }

    const user = await this.dependencies.repository.findUserById(session.userId);
    if (!user || user.status !== "active") throw new Error("用户不可用");
    const nextRefreshToken = `${session.id}.${createRefreshToken()}`;
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await this.dependencies.repository.rotateSession(
      session.id,
      hashRefreshToken(nextRefreshToken),
      expiresAt,
    );
    const accessToken = await this.dependencies.jwt.signAccessToken({
      userId: user.id,
      sessionId: session.id,
      organizationId: user.organizationId,
      authorizationVersion: user.authorizationVersion,
    });

    return {
      accessToken,
      refreshToken: nextRefreshToken,
      expiresIn: this.dependencies.jwt.accessTokenTtlSeconds,
      user: {
        id: user.id,
        organizationId: user.organizationId,
        username: user.username,
        displayName: user.displayName,
      },
    };
  }

  /** 撤销当前会话。 */
  async logout(sessionId: string): Promise<void> {
    await this.dependencies.repository.revokeSession(sessionId);
    this.dependencies.contextCache?.delete(sessionId);
  }

  /** 校验 JWT 对应的本地用户和会话并生成请求身份上下文。 */
  async loadContext(token: string): Promise<AuthContext> {
    const claims = await this.dependencies.jwt.verifyAccessToken(token);
    const cached = this.dependencies.contextCache?.get(claims.sid);
    if (cached && cached.userId === claims.sub && cached.organizationId === claims.org_id)
      return cached;
    const [user, session] = await Promise.all([
      this.dependencies.repository.findUserById(claims.sub),
      this.dependencies.repository.findSessionById(claims.sid),
    ]);
    if (
      !user ||
      user.status !== "active" ||
      user.authorizationVersion !== claims.authz_version ||
      !session ||
      session.revokedAt
    ) {
      throw new Error("登录会话无效");
    }
    const authorization = await this.dependencies.repository.loadAuthorization(user.id);
    const context: AuthContext = {
      userId: user.id,
      organizationId: user.organizationId,
      sessionId: session.id,
      ...authorization,
    };
    this.dependencies.contextCache?.set(session.id, context);
    return context;
  }

  /** 创建管理员维护的本地用户，调用方必须已完成权限校验。 */
  async createManagedUser(
    input: Parameters<UserAdminRepository["createUser"]>[0],
  ): Promise<AuthUser> {
    return this.adminRepository().createUser(input);
  }

  /** 查询指定组织的用户列表。 */
  async listManagedUsers(organizationId: string): Promise<AuthUser[]> {
    return this.adminRepository().listUsers(organizationId);
  }

  /** 按用户标识读取用户资料，路由层负责组织隔离校验。 */
  async findManagedUser(userId: string): Promise<AuthUser | null> {
    return this.dependencies.repository.findUserById(userId);
  }

  /** 更新用户启用状态并失效该用户的身份上下文缓存。 */
  async updateManagedUserStatus(
    userId: string,
    organizationId: string,
    status: UserStatus,
  ): Promise<boolean> {
    const updated = await this.adminRepository().updateUserStatus(userId, organizationId, status);
    if (updated) this.dependencies.contextCache?.deleteUser(userId);
    return updated;
  }

  /** 执行默认管理员的幂等初始化。 */
  async bootstrapAdmin(
    input: Parameters<UserAdminRepository["ensureBootstrapAdmin"]>[0],
  ): Promise<void> {
    await this.adminRepository().ensureBootstrapAdmin(input);
  }

  /** 将认证仓储解析为包含管理能力的仓储实现。 */
  private adminRepository(): UserAdminRepository {
    const repository = this.dependencies.repository as Partial<UserAdminRepository>;
    if (
      !repository.createUser ||
      !repository.listUsers ||
      !repository.updateUserStatus ||
      !repository.ensureBootstrapAdmin
    )
      throw new Error("用户管理仓储未配置");
    return repository as UserAdminRepository;
  }
}

export { AuthService, hashRefreshToken };
export type { AuthServiceDependencies, LoginResult };
