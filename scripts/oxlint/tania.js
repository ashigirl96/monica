// oxlint は node で動き、node の版によっては TS の plugin を読めないので JS で書く。

function hasEnv(options) {
  return (
    options?.type === "ObjectExpression" &&
    options.properties.some((p) => p.type === "Property" && (p.key.name ?? p.key.value) === "env")
  );
}

// 絶対 path の実行ファイルは PATH を引かない。
function looksUpPath(command) {
  const first = command?.type === "ArrayExpression" ? command.elements[0] : undefined;
  return !(
    first?.type === "Literal" &&
    typeof first.value === "string" &&
    first.value.startsWith("/")
  );
}

export default {
  meta: { name: "tania" },
  rules: {
    // Bun.spawn は env を渡さないと起動時の environ で子を起こし、実行ファイルも起動時の PATH で探す。
    // Backend が login shell から取った PATH は process.env にしか無いので、渡し忘れは .app でだけ表に出る。
    "spawn-env": {
      create(context) {
        return {
          CallExpression(node) {
            const { callee } = node;
            if (callee.type !== "MemberExpression" || callee.object.name !== "Bun") return;
            if (!["spawn", "spawnSync"].includes(callee.property.name)) return;
            const [first, second] = node.arguments;
            const ok =
              first?.type === "ObjectExpression"
                ? hasEnv(first) ||
                  !looksUpPath(first.properties.find((p) => p.key?.name === "cmd")?.value)
                : hasEnv(second) || !looksUpPath(first);
            if (ok) return;
            context.report({
              node,
              message:
                "Bun.spawn に env: process.env を渡す。渡さないと login shell の PATH が効かず、.app でだけコマンドが見つからない",
            });
          },
        };
      },
    },
  },
};
