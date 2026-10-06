import { stableStringify } from "@ai-data/contracts";
import { ZodError } from "zod";
import { ApiError } from "../http/api-error";
import type { PublicationOptions, PublicationResult } from "./management-types";
/** 发布前读取最新头，丢失回执后只读核对，不递增版本或自动重试写入。 */
async function publishVersion<T extends { version: number }>(
  options: PublicationOptions<T>,
): Promise<PublicationResult<T>> {
  const { request, path, id, input, schema, secret } = options;
  const detailPath = `${path}/${encodeURIComponent(id)}`;
  const read = async (version?: number) => {
    try {
      return schema.parse(await request(`${detailPath}${version ? `?version=${version}` : ""}`));
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  };
  const latest = await read();
  if (input.version !== (latest?.version ?? 0) + 1) return { status: "conflict", current: latest };
  try {
    return {
      status: "saved",
      current: schema.parse(await request(path, { method: "POST", body: input })),
    };
  } catch (error) {
    if (
      !(error instanceof ApiError || error instanceof ZodError) ||
      (error instanceof ApiError &&
        ([401, 403].includes(error.status) || error.code === "CANCELLED"))
    )
      throw error;
    if (error instanceof ApiError && error.status === 409)
      return { status: "conflict", current: await read() };
    if (error instanceof ApiError && error.status !== 0 && error.status < 500) throw error;
    let current: T | null = null;
    try {
      current = await read(input.version);
    } catch (readError) {
      if (
        readError instanceof ApiError &&
        ([401, 403].includes(readError.status) || readError.code === "CANCELLED")
      )
        throw readError;
    }
    const matches =
      current &&
      Object.entries(input).every(
        ([key, value]) =>
          stableStringify(value) === stableStringify((current as Record<string, unknown>)[key]),
      );
    return { status: !secret && matches ? "saved" : "uncertain", current };
  }
}
export { publishVersion };
