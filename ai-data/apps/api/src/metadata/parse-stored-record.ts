import { ApplicationError } from "../errors/application-error";

/** 校验数据库读取后的记录或 JSON；保存数据损坏属于内部故障，原始原因保留在 cause。 */
function parseStoredRecord<T>(parse: () => T): T {
  try {
    return parse();
  } catch (cause) {
    throw new ApplicationError("INTERNAL_ERROR", "元数据记录读取失败", { cause });
  }
}

export { parseStoredRecord };
