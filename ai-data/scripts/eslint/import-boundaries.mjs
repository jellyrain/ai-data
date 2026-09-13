import { readFileSync, readdirSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";

const workspace = fileURLToPath(new URL("../../", import.meta.url));

/** 从工作区清单读取包名和公开入口，规则不依赖执行 lint 时的目录。 */
const members = ["apps", "packages"].flatMap((group) =>
  readdirSync(resolve(workspace, group), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const directory = resolve(workspace, group, entry.name);
      let manifest;
      try {
        manifest = JSON.parse(readFileSync(resolve(directory, "package.json"), "utf8"));
      } catch (error) {
        if (error.code === "ENOENT") return [];
        throw error;
      }
      const exports = manifest.exports;
      const publicEntries = exports
        ? typeof exports === "object" && Object.keys(exports).some((key) => key.startsWith("."))
          ? Object.keys(exports).filter((key) => exports[key] !== null)
          : ["."]
        : [];
      return [{ name: manifest.name, directory, group, publicEntries }];
    }),
);

/** 路径必须位于成员目录内，避免 api 与 api-extra 一类前缀相近的目录混淆。 */
function ownerOf(filename) {
  return members.find((member) => {
    const path = relative(member.directory, filename);
    return (
      path === "" ||
      (path !== ".." && !path.startsWith("../") && !path.startsWith("..\\") && !isAbsolute(path))
    );
  });
}

/** 检查跨工作区成员的依赖；同一成员内的源码与测试可继续使用相对路径。 */
const importBoundaries = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      application: "应用源码由各自应用维护；共享代码应通过 packages 的公开入口提供。",
      publicEntry: "引用工作区包 {{name}} 时，请使用 package.json exports 声明的公开入口。",
    },
  },
  create(context) {
    const filename = context.physicalFilename;
    const importer = ownerOf(filename);

    function check(node) {
      if (!node || typeof node.value !== "string") return;
      const specifier = node.value;
      let target = members.find(
        (member) => specifier === member.name || specifier.startsWith(member.name + "/"),
      );
      let pathImport = false;
      if (
        !target &&
        (specifier.startsWith(".") || isAbsolute(specifier) || specifier.startsWith("file:"))
      ) {
        const targetPath = specifier.startsWith("file:")
          ? fileURLToPath(specifier)
          : resolve(filename, "..", specifier);
        target = ownerOf(targetPath);
        pathImport = true;
      }
      if (!target) return;
      if (target.group === "apps" && target !== importer) {
        context.report({ node, messageId: "application" });
        return;
      }
      if (pathImport && target === importer) return;
      const entry = specifier === target.name ? "." : "." + specifier.slice(target.name.length);
      if (pathImport || !target.publicEntries.includes(entry)) {
        context.report({ node, messageId: "publicEntry", data: { name: target.name } });
      }
    }

    return {
      ImportDeclaration: (node) => check(node.source),
      ExportNamedDeclaration: (node) => check(node.source),
      ExportAllDeclaration: (node) => check(node.source),
      ImportExpression: (node) => check(node.source),
      TSImportType: (node) => check(node.source),
      TSExternalModuleReference: (node) => check(node.expression),
      CallExpression(node) {
        if (node.callee.type === "Identifier" && node.callee.name === "require")
          check(node.arguments[0]);
      },
    };
  },
};

export { importBoundaries };
