// oxlint は node で動き、node の版によっては TS の plugin を読めないので JS で書く。

function hasEnv(options) {
  return (
    options?.type === 'ObjectExpression' &&
    options.properties.some((p) => p.type === 'Property' && (p.key.name ?? p.key.value) === 'env')
  )
}

// 絶対 path の実行ファイルは PATH を引かない。
function looksUpPath(command) {
  const first = command?.type === 'ArrayExpression' ? command.elements[0] : undefined
  return !(
    first?.type === 'Literal' &&
    typeof first.value === 'string' &&
    first.value.startsWith('/')
  )
}

function isFunction(node) {
  return node?.type === 'ArrowFunctionExpression' || node?.type === 'FunctionExpression'
}

// task の reservation の method は transaction を開いて最後の引数を中で呼ぶので、transaction と同じく async 関数を受けてはいけない。
const TRANSACTION_CALLBACK_LAST = new Set(['writeOpenTask', 'writeClosedTask', 'openRunTab'])

function isAsyncFunction(node) {
  return isFunction(node) && node.async
}

// read が返す関数。read の中で走る callback（map など）は数えない。
function returnedFunctions(read) {
  if (read.body.type !== 'BlockStatement') return isFunction(read.body) ? [read.body] : []
  const found = []
  const visit = (node) => {
    if (!node || typeof node.type !== 'string' || isFunction(node)) return
    if (node.type === 'ReturnStatement' && isFunction(node.argument)) found.push(node.argument)
    for (const [key, child] of Object.entries(node)) {
      if (key === 'parent') continue
      for (const item of Array.isArray(child) ? child : [child]) {
        if (item && typeof item === 'object') visit(item)
      }
    }
  }
  for (const statement of read.body.body) visit(statement)
  return found
}

function calls(node, name) {
  if (!node || typeof node.type !== 'string') return false
  if (
    node.type === 'CallExpression' &&
    node.callee.type === 'Identifier' &&
    node.callee.name === name
  ) {
    return true
  }
  return Object.entries(node).some(
    ([key, child]) =>
      key !== 'parent' &&
      (Array.isArray(child) ? child : [child]).some(
        (item) => item && typeof item === 'object' && calls(item, name),
      ),
  )
}

function isStringLiteral(node) {
  return node?.type === 'Literal' && typeof node.value === 'string'
}

function isString(node) {
  return (
    isStringLiteral(node) ||
    node?.type === 'TemplateLiteral' ||
    (node?.type === 'LogicalExpression' &&
      ['??', '||'].includes(node.operator) &&
      isStringLiteral(node.right))
  )
}

function propertyName(node) {
  if (node.computed) return isStringLiteral(node.property) ? node.property.value : undefined
  return node.property.name
}

function isEnv(node) {
  return (
    node?.type === 'MemberExpression' &&
    !node.computed &&
    node.property.name === 'env' &&
    node.object.type === 'Identifier' &&
    ['process', 'Bun'].includes(node.object.name)
  )
}

function isTz(node) {
  return node?.type === 'MemberExpression' && isEnv(node.object) && propertyName(node) === 'TZ'
}

const SCHEMA_ENTRY = /^@monica\/([^/]+)\/schema$/
const TESTING_ENTRY = /^@monica\/[^/]+\/testing$/

export default {
  meta: { name: 'monica' },
  rules: {
    // Bun.spawn は env を渡さないと起動時の environ で子を起こし、実行ファイルも起動時の PATH で探す。
    // Backend が login shell から取った PATH は process.env にしか無いので、渡し忘れは .app でだけ表に出る。
    'spawn-env': {
      create(context) {
        return {
          CallExpression(node) {
            const { callee } = node
            if (callee.type !== 'MemberExpression' || callee.object.name !== 'Bun') return
            if (!['spawn', 'spawnSync'].includes(callee.property.name)) return
            const [first, second] = node.arguments
            const ok =
              first?.type === 'ObjectExpression'
                ? hasEnv(first) ||
                  !looksUpPath(first.properties.find((p) => p.key?.name === 'cmd')?.value)
                : hasEnv(second) || !looksUpPath(first)
            if (ok) return
            context.report({
              node,
              message:
                'Bun.spawn に env: process.env を渡す。渡さないと login shell の PATH が効かず、.app でだけコマンドが見つからない',
            })
          },
        }
      },
    },
    // bun:sqlite の transaction は同期で、async 関数を渡すと await の後の throw で rollback されない。
    'sync-transaction': {
      create(context) {
        const asyncNames = new Set()
        const passedByName = []
        const report = (node) =>
          context.report({
            node,
            message:
              'transaction に async 関数を渡さない。throw しても rollback されない（ADR-0009）。fs への副作用は commit の後に呼ぶ。ptyd には workbench が送る',
          })
        return {
          FunctionDeclaration(node) {
            if (node.async && node.id) asyncNames.add(node.id.name)
          },
          VariableDeclarator(node) {
            if (node.id.type === 'Identifier' && isAsyncFunction(node.init)) {
              asyncNames.add(node.id.name)
            }
          },
          CallExpression(node) {
            const { callee } = node
            if (callee.type !== 'MemberExpression') return
            const { name } = callee.property
            const callback =
              name === 'transaction'
                ? node.arguments[0]
                : TRANSACTION_CALLBACK_LAST.has(name)
                  ? node.arguments.at(-1)
                  : undefined
            if (isAsyncFunction(callback)) report(node)
            else if (callback?.type === 'Identifier')
              passedByName.push({ node, name: callback.name })
          },
          'Program:exit'() {
            for (const { node, name } of passedByName) if (asyncNames.has(name)) report(node)
          },
        }
      },
    },
    'cross-domain-write': {
      create(context) {
        const own = /\/packages\/([^/]+)\/src\//.exec(context.filename)?.[1]
        const tables = new Set()
        const namespaces = new Set()
        const isForeignTable = (node) =>
          node?.type === 'Identifier'
            ? tables.has(node.name)
            : node?.type === 'MemberExpression' && namespaces.has(node.object.name)
        return {
          ImportDeclaration(node) {
            const domain = SCHEMA_ENTRY.exec(node.source.value)?.[1]
            if (!domain || domain === own || node.importKind === 'type') return
            for (const specifier of node.specifiers) {
              const names = specifier.type === 'ImportNamespaceSpecifier' ? namespaces : tables
              names.add(specifier.local.name)
            }
          },
          CallExpression(node) {
            const { callee } = node
            if (callee.type !== 'MemberExpression') return
            if (!['insert', 'update', 'delete'].includes(callee.property.name)) return
            if (!isForeignTable(node.arguments[0])) return
            context.report({
              node,
              message:
                '他の domain の table に直接書かない。書き込みは相手の domain の method を通す（ADR-0009）',
            })
          },
        }
      },
    },
    // jotai は read の間に呼んだ get だけを依存に数えるので、返した関数の中の get は依存にならず、atom は変わらない。
    'atom-deferred-get': {
      create(context) {
        return {
          CallExpression(node) {
            if (node.callee.type !== 'Identifier' || node.callee.name !== 'atom') return
            const [read] = node.arguments
            const get = isFunction(read) && read.params[0]
            if (get?.type !== 'Identifier') return
            for (const returned of returnedFunctions(read)) {
              if (!calls(returned.body, get.name)) continue
              context.report({
                node: returned,
                message:
                  'atom の read の中で get で読み、読んだ値を返す関数に閉じ込める。返す関数の中の get は依存にならず、読む atom が変わっても描き直されない',
              })
            }
          },
        }
      },
    },
    // no-restricted-imports は override をまたいで重ならないので、file の集合ごとの制限と別の rule にする。
    'testing-entry': {
      create(context) {
        const check = (node) => {
          if (!TESTING_ENTRY.test(node.source?.value)) return
          context.report({
            node,
            message:
              'testing entry を import するのはテストと testing.ts だけ（docs/packages.md の entry）',
          })
        }
        return {
          ImportDeclaration: check,
          ExportNamedDeclaration: check,
          ExportAllDeclaration: check,
        }
      },
    },
    'tz-restore': {
      create(context) {
        const report = (node) =>
          context.report({
            node,
            message:
              "process.env.TZ には文字列を代入して戻す（tz ?? 'UTC'）。undefined を代入しても delete しても UTC に戻らず、同じ process で後に走るテストに時間帯が漏れる",
          })
        return {
          AssignmentExpression(node) {
            if (node.operator === '=' && isTz(node.left) && !isString(node.right)) report(node)
          },
          UnaryExpression(node) {
            if (node.operator === 'delete' && isTz(node.argument)) report(node)
          },
        }
      },
    },
    'contract-only': {
      create(context) {
        const namespaces = new Set()
        const reportSchemaFactory = (node) =>
          context.report({
            node,
            message:
              'createSchemaFactory は各 package の contract.ts にだけ書き、table から作る zod schema はそこで作る。日付を受ける coerce の設定を package ごとに 1 か所にするため',
          })
        return {
          ImportDeclaration(node) {
            if (node.source.value !== 'drizzle-zod') return
            for (const specifier of node.specifiers) {
              if (specifier.type === 'ImportNamespaceSpecifier') {
                namespaces.add(specifier.local.name)
              } else if (
                specifier.type === 'ImportSpecifier' &&
                (specifier.imported.name ?? specifier.imported.value) === 'createSchemaFactory'
              ) {
                reportSchemaFactory(specifier)
              }
            }
          },
          MemberExpression(node) {
            const name = propertyName(node)
            if (name === '$meta') {
              context.report({
                node,
                message:
                  '$meta は各 package の contract.ts にだけ書く。oRPC 2.0 で $meta が無くなるので、直す場所を contract.ts に集める',
              })
            } else if (
              name === 'createSchemaFactory' &&
              node.object.type === 'Identifier' &&
              namespaces.has(node.object.name)
            ) {
              reportSchemaFactory(node)
            }
          },
        }
      },
    },
    // 理由の無い disable は、後から外してよいかを誰も判断できない。
    'disable-reason': {
      create(context) {
        return {
          Program() {
            for (const comment of context.sourceCode.getAllComments()) {
              if (!/^\s*(oxlint|eslint)-disable/.test(comment.value)) continue
              if (/\s--\s+\S/.test(comment.value)) continue
              context.report({
                node: comment,
                message: 'lint を黙らせるときは、rule の後に `-- 理由` を 1 文書く',
              })
            }
          },
        }
      },
    },
  },
}
