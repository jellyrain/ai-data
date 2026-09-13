import { z } from "zod";

/** 对外对象及 HTTP 虚拟表标识符的字符白名单；实际对象映射由目录与规划层确认。 */
const identifierSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.]*$/, "必须是安全标识符");

export { identifierSchema };
