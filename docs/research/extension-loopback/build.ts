// 拡張が読む extension/rpc.js（@orpc/client 1.15.4 の createORPCClient と RPCLink）を作る。
// usage: bun docs/research/extension-loopback/build.ts
const web = `${import.meta.dir}/../../../apps/web`

const result = await Bun.build({
  entrypoints: [`${import.meta.dir}/rpc-entry.ts`],
  outdir: `${import.meta.dir}/extension`,
  naming: 'rpc.js',
  target: 'browser',
  format: 'esm',
  plugins: [
    {
      name: 'orpc-from-apps-web',
      // @orpc/client は repo の root に無く、apps/web の依存として入っている。
      setup(build) {
        build.onResolve({ filter: /^@orpc\// }, (args) =>
          args.importer.startsWith(import.meta.dir)
            ? { path: Bun.resolveSync(args.path, web) }
            : undefined,
        )
      },
    },
  ],
})
if (!result.success) throw new AggregateError(result.logs)
