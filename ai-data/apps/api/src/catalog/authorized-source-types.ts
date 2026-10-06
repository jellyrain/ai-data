import type { AuthContext } from "../auth/auth-types";
import type { DataAccessServiceRegistry } from "../data-access/data-access-types";
/** 源发现复用健康实例和当前对象授权；仅需要判断授权目录是否为空。 */
type AuthorizedSourceDependencies = {
  registry: Pick<DataAccessServiceRegistry, "listHealthyServices">;
  catalog: { listAuthorized(context: AuthContext, sourceId: string): Promise<readonly unknown[]> };
};
export type { AuthorizedSourceDependencies };
