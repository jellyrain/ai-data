import type { ContractErrorCode } from "@ai-data/contracts";

import { ApplicationError } from "../errors/application-error";

/** 查询授权失败时使用的稳定错误。 */
class QueryAuthorizationError extends ApplicationError {
  constructor(message: string, code: ContractErrorCode = "UNAUTHORIZED") {
    super(code, message);
    this.name = "QueryAuthorizationError";
  }
}

export { QueryAuthorizationError };
