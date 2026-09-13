import type { ContractErrorCode } from "@ai-data/contracts";

/** DAS 查询边界已经分类并可公开的错误，不携带底层查询或传输对象。 */
class QueryRequestError extends Error {
  constructor(
    readonly code: ContractErrorCode,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "QueryRequestError";
  }
}

export { QueryRequestError };
