/** 分别说明传输协议与浏览器安全上下文，供用户区展示当前连接环境。 */
function connectionContext(protocol: string, secure: boolean, hostname = "") {
  if (protocol === "https:" && secure)
    return {
      label: "HTTPS 已加密",
      kind: "secure" as const,
      description: "当前连接使用 HTTPS 加密，浏览器将此页面视为安全上下文。",
    };
  if (protocol === "http:" && secure) {
    const local =
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      /^127(?:\.\d{1,3}){3}$/.test(hostname) ||
      hostname === "[::1]";
    return {
      label: local ? "本机 HTTP" : "HTTP 可信来源",
      kind: "local" as const,
      description: "浏览器将此 HTTP 来源视为可信上下文，但连接未使用 HTTPS 加密。",
    };
  }
  return {
    label: protocol === "http:" ? "HTTP 未加密" : "受限连接环境",
    kind: "warning" as const,
    description:
      protocol === "http:"
        ? "当前连接使用 HTTP，传输未加密，浏览器将此页面视为非安全上下文。建议通过 HTTPS 访问。"
        : "浏览器将此页面视为非安全上下文。请在独立窗口通过可信的 HTTPS 地址访问。",
  };
}

export { connectionContext };
