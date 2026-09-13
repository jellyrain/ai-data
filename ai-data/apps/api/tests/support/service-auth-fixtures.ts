import { generateKeyPairSync } from "node:crypto";
import { JwtService } from "../../src/auth/jwt-service";
import { config } from "./api-fixtures";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();

/** 使用临时密钥创建真实 API 签发与验证服务。 */
function createServiceJwt() {
  return JwtService.create({
    ...config,
    jwt: {
      ...config.jwt,
      signing_private_key_pem: privatePem,
      verification_public_key_pem: publicPem,
    },
  });
}

export { createServiceJwt, privatePem, publicPem };
