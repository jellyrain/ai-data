import type { DataPolicy } from "./authorization-types";

/** API 内部用户状态。 */
type UserStatus = "active" | "disabled" | "pending";

/** API 登录用户的最小本地资料。 */
type AuthUser = {
  /** 用户主键。 */
  id: string;
  /** 所属组织主键。 */
  organizationId: string;
  /** 登录名。 */
  username: string;
  /** 展示名称。 */
  displayName: string;
  /** 本地密码派生哈希；SSO 用户为空。 */
  passwordHash: string | null;
  /** 账号状态。 */
  status: UserStatus;
  /** 签发令牌时记录的授权版本；加载未缓存身份时与当前版本比较。 */
  authorizationVersion: number;
};

/** 当前请求使用的本地角色、功能权限和数据策略。 */
type AuthContext = {
  /** 当前用户主键。 */
  userId: string;
  /** 当前组织主键。 */
  organizationId: string;
  /** 当前会话主键。 */
  sessionId: string;
  /** 当前有效角色编码。 */
  roles: string[];
  /** 当前有效角色主键，供角色授权配置精确匹配。 */
  roleIds?: string[];
  /** 当前有效功能权限编码。 */
  permissions: string[];
  /** 当前有效数据行策略。 */
  dataPolicies: DataPolicy[];
  /** 由 API 本地授权来源提供的范围白名单；浏览器和模型不能提供这些值。 */
  permissionContext?: {
    /** 当前可信部门标识范围，未配置时相关上下文策略拒绝执行。 */
    department_ids?: string[];
  };
};

/** 登录后创建的服务端会话。 */
type AuthSession = {
  /** 会话主键。 */
  id: string;
  /** 会话所属用户主键。 */
  userId: string;
  /** Refresh Token 的 SHA-256 哈希。 */
  refreshTokenHash: string;
  /** 会话过期时间。 */
  expiresAt: Date;
  /** 撤销时间；未撤销时为空。 */
  revokedAt: Date | null;
};

/** 认证仓储需要的用户和会话读写能力。 */
interface AuthRepository {
  /** 按登录名读取用户；该查询入口未接收组织标识。 */
  findUserByUsername(username: string): Promise<AuthUser | null>;
  /** 按用户主键读取本地用户。 */
  findUserById(userId: string): Promise<AuthUser | null>;
  /** 按会话主键读取服务端会话。 */
  findSessionById(sessionId: string): Promise<AuthSession | null>;
  /** 持久化新建的 Refresh Token 会话。 */
  createSession(session: AuthSession): Promise<void>;
  /** 更新未撤销会话的令牌哈希和有效期，再读取当前会话。 */
  rotateSession(
    sessionId: string,
    refreshTokenHash: string,
    expiresAt: Date,
  ): Promise<AuthSession | null>;
  /** 撤销指定服务端会话。 */
  revokeSession(sessionId: string): Promise<void>;
  /** 汇总用户通过角色和个人例外获得的当前授权。 */
  loadAuthorization(
    userId: string,
  ): Promise<
    Pick<AuthContext, "roles" | "roleIds" | "permissions" | "dataPolicies" | "permissionContext">
  >;
}

/** 管理员创建用户时交给仓储的资料与初始授权绑定。 */
type CreateUserInput = {
  /** 新用户稳定标识。 */
  id: string;
  /** 新用户所属组织，由当前管理员上下文确定。 */
  organizationId: string;
  /** 组织内唯一登录名。 */
  username: string;
  /** 用户展示名称。 */
  displayName: string;
  /** 使用 scrypt 派生后的密码哈希。 */
  passwordHash: string;
  /** 初始化绑定的角色标识列表。 */
  roleIds: string[];
  /** 仅用于个别例外的数据范围标识列表。 */
  exceptionDataScopeIds: string[];
};

/** 管理员用户管理所需的仓储能力。 */
interface UserAdminRepository extends AuthRepository {
  /** 幂等创建默认组织、管理员角色、管理权限和管理员账号。 */
  ensureBootstrapAdmin(input: {
    /** 默认管理员用户标识。 */
    userId: string;
    /** 默认组织标识。 */
    organizationId: string;
    /** 默认组织编码。 */
    organizationCode: string;
    /** 默认组织名称。 */
    organizationName: string;
    /** 管理员登录名。 */
    username: string;
    /** 管理员展示名称。 */
    displayName: string;
    /** 管理员密码派生哈希。 */
    passwordHash: string;
  }): Promise<void>;
  /** 在指定组织创建用户并绑定角色和个别例外范围。 */
  createUser(input: CreateUserInput): Promise<AuthUser>;
  /** 按组织列出内部用户资料；路由负责选取可公开字段。 */
  listUsers(organizationId: string): Promise<AuthUser[]>;
  /** 更新组织内用户状态并递增授权版本。 */
  updateUserStatus(userId: string, organizationId: string, status: UserStatus): Promise<boolean>;
  /** 在用户所属组织内原子替换部门集合并递增授权版本。 */
  updateUserDepartments(
    userId: string,
    organizationId: string,
    departmentIds: string[],
  ): Promise<boolean>;
}

export type {
  AuthContext,
  AuthRepository,
  AuthSession,
  AuthUser,
  CreateUserInput,
  UserAdminRepository,
  UserStatus,
};
