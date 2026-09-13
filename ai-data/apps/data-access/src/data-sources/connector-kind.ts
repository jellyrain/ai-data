import { z } from "zod";

/** DAS 运行时可选择的连接器类型；枚举值必须与连接器工厂支持的类型一致。 */
const connectorKindSchema = z.enum(["sqlserver", "mysql", "postgresql", "oracle", "http_api"]);

export { connectorKindSchema };
