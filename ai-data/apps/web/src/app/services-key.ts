import type { InjectionKey } from "vue";
import type { AppServices } from "./services-types";
/** 应用服务的运行时注入标识。 */
const servicesKey: InjectionKey<AppServices> = Symbol("app-services");
export { servicesKey };
