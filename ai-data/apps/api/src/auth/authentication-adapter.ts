/** 外部认证来源确认后的标准身份。 */
type AuthenticatedIdentity = {
  /** 外部身份来源编码，例如 oidc、cas 或 ldap。 */
  provider: string;
  /** 外部身份来源内稳定且唯一的主体标识。 */
  subject: string;
  /** 用于匹配本地用户的登录名。 */
  username: string;
  /** 身份来源提供的展示名称。 */
  displayName: string;
  /** 可选的已验证邮箱地址。 */
  email?: string;
};

/** 本地账号、OIDC、CAS 或 LDAP 认证适配器的统一边界。 */
interface AuthenticationAdapter {
  /** 校验外部认证输入并转换为标准身份。 */
  authenticate(input: unknown): Promise<AuthenticatedIdentity>;
}

export type { AuthenticatedIdentity, AuthenticationAdapter };
