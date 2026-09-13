import {
  dataAccessQueryRequestSchema,
  type QueryAccessContext,
  type QueryDsl,
} from "@ai-data/contracts";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";

import type { AuthContext } from "../auth/auth-types";
import type {
  BusinessCatalogService,
  AuthorizedDataset,
} from "../catalog/business-catalog-service";
import type { JwtService } from "../auth/jwt-service";
import { authorizeRelationalQuery } from "./relational-authorization";
import { QueryAuthorizationError } from "./query-authorization-error";
import type { AuthorizedQuery, QueryRelation, RelationalQuery } from "./query-authorization-types";
import { authorizeParameterizedQuery } from "./parameterized-authorization";

// 授权截止时间统一按东八区签发，避免依赖服务所在机器的时区。
dayjs.extend(utc);

/** 根据业务目录校验查询引用，转换关系查询的行条件和脱敏规则，生成 DAS 访问上下文。 */
class QueryAuthorizationService {
  constructor(
    private readonly catalog: BusinessCatalogService,
    private readonly jwt: JwtService,
    private readonly policyVersion = 1,
  ) {}

  /** 按查询类型执行当前校验分支，将转换后的 DSL 与访问上下文一起签名。 */
  async authorize(
    input: unknown,
    context: AuthContext,
    analysisRunId = crypto.randomUUID(),
  ): Promise<AuthorizedQuery> {
    const parsed = dataAccessQueryRequestSchema.shape.query.safeParse(input);
    if (!parsed.success) throw new QueryAuthorizationError("查询 DSL 格式无效", "INVALID_INPUT");
    const query = parsed.data;
    const datasets = await this.catalog.listAuthorized(context, query.source_id);
    const from = datasets.find((item) => item.dataset.object_id === query.from.object_id);
    if (!from) throw new QueryAuthorizationError("主数据对象无权访问", "UNAUTHORIZED_OBJECT");

    let authorizedQuery: QueryDsl;
    let outputMasks: QueryAccessContext["output_masks"];
    if (query.type === "relational_query") {
      const relations = await this.resolveRelations(query, datasets, context);
      const result = authorizeRelationalQuery(query, relations, context);
      authorizedQuery = result.query;
      outputMasks = result.outputMasks;
    } else {
      const config = await this.catalog.getAuthorizedConfig(
        context,
        query.source_id,
        query.from.object_id,
      );
      const result = authorizeParameterizedQuery(query, from, config, context);
      authorizedQuery = result.query;
      outputMasks = result.outputMasks;
    }

    const access: QueryAccessContext = {
      user_id: context.userId,
      organization_id: context.organizationId,
      analysis_run_id: analysisRunId,
      policy_version: this.policyVersion,
      // 请求比 60 秒内部 JWT 提前 5 秒过期，为传输和验签留出时间差。
      expires_at: dayjs().utcOffset(8).add(55, "second").format("YYYY-MM-DD HH:mm:ss"),
      output_masks: outputMasks,
    };
    const token = await this.jwt.signInternalQueryToken({
      userId: context.userId,
      organizationId: context.organizationId,
      analysisRunId,
      policyVersion: this.policyVersion,
    });
    return {
      request: {
        access,
        query: authorizedQuery,
        signature: this.jwt.signQueryRequest(access, authorizedQuery),
      },
      token,
    };
  }

  /** 按别名收集当前可见对象及业务配置，拒绝重复别名和不可见的关联对象。 */
  private async resolveRelations(
    query: RelationalQuery,
    datasets: AuthorizedDataset[],
    context: AuthContext,
  ): Promise<Map<string, QueryRelation>> {
    const refs = [
      query.from,
      ...query.joins.map((join) => ({ object_id: join.object_id, alias: join.alias })),
    ];
    const result = new Map<string, QueryRelation>();
    for (const ref of refs) {
      if (result.has(ref.alias))
        throw new QueryAuthorizationError("查询别名不能重复", "INVALID_INPUT");
      const authorized = datasets.find((item) => item.dataset.object_id === ref.object_id);
      if (!authorized)
        throw new QueryAuthorizationError("Join 数据对象无权访问", "UNAUTHORIZED_OBJECT");
      result.set(ref.alias, {
        authorized,
        config: await this.catalog.getAuthorizedConfig(context, query.source_id, ref.object_id),
      });
    }
    return result;
  }
}

export { QueryAuthorizationError, QueryAuthorizationService };
export type { AuthorizedQuery };
