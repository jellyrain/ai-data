import { sourceListInputSchema, sourceListSchema } from "@ai-data/contracts";
import type { AuthContext } from "../auth/auth-types";
import type { AuthorizedSourceDependencies } from "./authorized-source-types";

/** 面向普通业务身份发现可查询数据源，每页重新检查当前授权。 */
class AuthorizedSourceService {
  constructor(private readonly dependencies: AuthorizedSourceDependencies) {}
  async list(context: AuthContext, input: unknown) {
    const request = sourceListInputSchema.parse(input);
    const services = await this.dependencies.registry.listHealthyServices();
    const ids = [
      ...new Set(
        services.flatMap((service) =>
          service.sources
            .filter((source) => source.status === "healthy")
            .map((source) => source.source_id),
        ),
      ),
    ].sort();
    const items: { source_id: string }[] = [];
    for (const id of ids) {
      if (request.cursor !== undefined && id <= request.cursor) continue;
      // 读取失败保留实际错误，不能把目录故障解释为当前用户没有授权。
      if ((await this.dependencies.catalog.listAuthorized(context, id)).length)
        items.push({ source_id: id });
      if (items.length > request.limit) break;
    }
    const page = items.slice(0, request.limit);
    return sourceListSchema.parse({
      items: page,
      ...(items.length > request.limit ? { next_cursor: page.at(-1)!.source_id } : {}),
    });
  }
}
export { AuthorizedSourceService };
