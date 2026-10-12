import { AsyncLocalStorage } from "node:async_hooks";
import { stableStringify } from "@ai-data/contracts";

import type { AuthContext } from "../auth/auth-types";
import type { AuthorizedDataset, BusinessCatalogService } from "./business-catalog-service";

/** 同一读取或事务校验批次内复用，服务实例区分仓储及事务，完整身份区分授权结果。 */
const catalogReads = new AsyncLocalStorage<
  WeakMap<BusinessCatalogService, Map<string, Promise<AuthorizedDataset[]>>>
>();

/** 嵌套服务沿用当前批次；顶层调用与其他并发请求分别读取目录和权限。 */
function withCatalogReadScope<T>(read: () => Promise<T>): Promise<T> {
  if (catalogReads.getStore()) return read();
  return withFreshCatalogReadScope(read);
}

/** 事件回放、文字交付和执行后的复核显式开启新批次，不能沿用先前授权。 */
function withFreshCatalogReadScope<T>(read: () => Promise<T>): Promise<T> {
  return catalogReads.run(new WeakMap(), read);
}

/** 相同服务、完整授权上下文与数据源复用在途读取；调用方取得独立副本。 */
async function readCatalogInScope(
  service: BusinessCatalogService,
  context: AuthContext,
  sourceId: string,
  read: () => Promise<AuthorizedDataset[]>,
): Promise<AuthorizedDataset[]> {
  const scope = catalogReads.getStore();
  if (!scope) return read();
  let entries = scope.get(service);
  if (!entries) {
    entries = new Map();
    scope.set(service, entries);
  }
  const key = stableStringify({ context, sourceId });
  let pending = entries.get(key);
  if (!pending) {
    const cache = entries;
    pending = read().catch((error: unknown) => {
      cache.delete(key);
      throw error;
    });
    entries.set(key, pending);
  }
  return structuredClone(await pending);
}

export { withCatalogReadScope, withFreshCatalogReadScope, readCatalogInScope };
