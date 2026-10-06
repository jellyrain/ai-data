import { createHash, randomBytes } from "node:crypto";
import dayjs from "dayjs";
import { ApplicationError } from "../errors/application-error";

import type {
  AuthContext,
  AuthSession,
  AuthUser,
  UserAdminRepository,
  UserStatus,
} from "./auth-types";
import { type AuthContextCache } from "./auth-context-cache";
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
  /** 同时提供认证、会话、授权读取和管理员用户维护能力的仓储。 */
  repository: UserAdminRepository;
  /** API 自有 Access JWT 签发与校验服务。 */
  jwt: JwtService;
  /** 省略时每次请求从仓储加载身份；提供时按会话缓存上下文。 */
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

/** 本地账号认证、会话轮换与管理员用户维护服务。 */
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
      throw new ApplicationError("AUTHENTICATION_FAILED", "账号或密码错误");
    }

    // 令牌以前缀定位会话；数据库保存整个令牌的摘要，随机部分只在登录响应中返回。
    const refreshToken = `${crypto.randomUUID()}.${createRefreshToken()}`;
    const session: AuthSession = {
      id: refreshToken.split(".")[0],
      userId: user.id,
      refreshTokenHash: hashRefreshToken(refreshToken),
      expiresAt: dayjs()
        .add(7 * 24, "hour")
        .toDate(),
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

  /** 校验会话状态、有效期和令牌摘要后轮换 Refresh Token，重新签发 Access JWT。 */
  async refresh(refreshToken: string): Promise<LoginResult> {
    const sessionId = refreshToken.split(".")[0];
    const session = await this.dependencies.repository.findSessionById(sessionId);
    if (
      !session ||
      session.revokedAt ||
      !dayjs(session.expiresAt).isAfter(dayjs()) ||
      session.refreshTokenHash !== hashRefreshToken(refreshToken)
    ) {
      throw new ApplicationError("AUTHENTICATION_FAILED", "刷新令牌无效或已过期");
    }

    const user = await this.dependencies.repository.findUserById(session.userId);
    if (!user || user.status !== "active")
      throw new ApplicationError("AUTHENTICATION_FAILED", "用户不可用");
    const nextRefreshToken = `${session.id}.${createRefreshToken()}`;
    const expiresAt = dayjs()
      .add(7 * 24, "hour")
      .toDate();
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

  /** 验证 JWT 后优先读取缓存；缓存未命中时校验用户状态、授权版本和会话撤销状态。 */
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
      throw new ApplicationError("AUTHENTICATION_FAILED", "登录会话无效");
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

  /** 长运行从数据库重新核对会话和授权，避免继续使用请求开始时的身份快照。 */
  async refreshContext(context: AuthContext): Promise<AuthContext> {
    const [user, session] = await Promise.all([
      this.dependencies.repository.findUserById(context.userId),
      this.dependencies.repository.findSessionById(context.sessionId),
    ]);
    if (
      !user ||
      user.status !== "active" ||
      user.organizationId !== context.organizationId ||
      !session ||
      session.userId !== user.id ||
      session.revokedAt ||
      !dayjs(session.expiresAt).isAfter(dayjs())
    )
      throw new ApplicationError("AUTHENTICATION_FAILED", "登录会话无效");
    return {
      userId: user.id,
      organizationId: user.organizationId,
      sessionId: session.id,
      ...(await this.dependencies.repository.loadAuthorization(user.id)),
    };
  }

  /** 创建管理员维护的本地用户，调用方必须已完成权限校验。 */
  async createManagedUser(
    input: Parameters<UserAdminRepository["createUser"]>[0],
  ): Promise<AuthUser> {
    return this.dependencies.repository.createUser(input);
  }

  /** 查询指定组织的用户列表。 */
  async listManagedUsers(organizationId: string): Promise<AuthUser[]> {
    return this.dependencies.repository.listUsers(organizationId);
  }

  /** 按用户标识读取用户资料，路由层负责组织隔离校验。 */
  async findManagedUser(userId: string): Promise<AuthUser | null> {
    return this.dependencies.repository.findUserById(userId);
  }

  /** 更新用户状态，成功后清除本实例内该用户的全部身份缓存。 */
  async updateManagedUserStatus(
    userId: string,
    organizationId: string,
    status: UserStatus,
  ): Promise<boolean> {
    const updated = await this.dependencies.repository.updateUserStatus(
      userId,
      organizationId,
      status,
    );
    if (updated) this.dependencies.contextCache?.deleteUser(userId);
    return updated;
  }

  /** 管理员更新部门授权后让该用户的身份快照立即失效。 */
  async updateManagedUserDepartments(
    userId: string,
    organizationId: string,
    departmentIds: string[],
    expectedAuthorizationVersion?: number,
  ): Promise<boolean> {
    const updated = await this.dependencies.repository.updateUserDepartments(
      userId,
      organizationId,
      departmentIds,
      expectedAuthorizationVersion,
    );
    if (updated) this.dependencies.contextCache?.deleteUser(userId);
    return updated;
  }

  /** 执行默认管理员的幂等初始化。 */
  async bootstrapAdmin(
    input: Parameters<UserAdminRepository["ensureBootstrapAdmin"]>[0],
  ): Promise<void> {
    await this.dependencies.repository.ensureBootstrapAdmin(input);
  }
}

export { AuthService, hashRefreshToken };
export type { AuthServiceDependencies, LoginResult };
