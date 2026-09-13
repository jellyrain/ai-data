import type { ContractErrorCode } from "@ai-data/contracts";

/** API 内部的已分类错误；code 用于程序分支，message 必须适合公开，cause 保留排错原因。 */
class ApplicationError extends Error {
  constructor(
    readonly code: ContractErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ApplicationError";
  }
}

export { ApplicationError };
