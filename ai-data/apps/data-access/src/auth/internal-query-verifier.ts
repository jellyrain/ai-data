import { createVerify } from "node:crypto";
import { importSPKI, jwtVerify } from "jose";
import { stableStringify, type DataAccessQueryRequest } from "@ai-data/contracts";

/** API 与 DAS 约定的内部查询令牌来源和受众。 */
const INTERNAL_QUERY_ISSUER = "ai-data-api:internal";
const INTERNAL_QUERY_AUDIENCE = "ai-data-api:das";

/** DAS 验证 API 内部查询令牌与请求签名。 */
class InternalQueryVerifier {
  private constructor(
    private readonly publicKey: Awaited<ReturnType<typeof importSPKI>>,
    private readonly publicPem: string,
    private readonly issuer: string,
    private readonly audience: string,
  ) {}

  static async create(publicPem: string): Promise<InternalQueryVerifier> {
    const publicKey = await importSPKI(publicPem, "RS256");
    return new InternalQueryVerifier(
      publicKey,
      publicPem,
      INTERNAL_QUERY_ISSUER,
      INTERNAL_QUERY_AUDIENCE,
    );
  }

  async verify(request: DataAccessQueryRequest, token: string): Promise<void> {
    await jwtVerify(token, this.publicKey, {
      issuer: this.issuer,
      audience: this.audience,
      algorithms: ["RS256"],
    });
    const verifier = createVerify("RSA-SHA256");
    verifier.update(stableStringify({ access: request.access, query: request.query }));
    verifier.end();
    if (!verifier.verify(this.publicPem, request.signature, "base64url"))
      throw new Error("查询请求签名无效");
  }
}

export { InternalQueryVerifier };
