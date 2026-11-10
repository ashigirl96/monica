import { lookup as dnsLookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'

export type Lookup = (
  host: string,
  options: { all: true },
) => Promise<{ address: string; family: number }[]>

const LOCAL = new BlockList()
for (const [prefix, length] of [
  ['0.0.0.0', 8],
  ['127.0.0.0', 8],
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['169.254.0.0', 16],
  // Tailscale の tailnet もこの範囲にあり、LAN と同じく手元の口とみなす。
  ['100.64.0.0', 10],
  ['224.0.0.0', 4],
  ['255.255.255.255', 32],
] as const) {
  LOCAL.addSubnet(prefix, length, 'ipv4')
}
for (const [prefix, length] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  LOCAL.addSubnet(prefix, length, 'ipv6')
}

// IPv4-mapped IPv6（::ffff:127.0.0.1）は、Bun の BlockList が IPv4 の subnet に当てる。
function isLocalAddress(address: string): boolean {
  const family = isIP(address)
  return family === 0 || LOCAL.check(address, family === 4 ? 'ipv4' : 'ipv6')
}

export async function isLocalHost(host: string, lookup: Lookup = dnsLookup): Promise<boolean> {
  const name = host
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^\[(.*)\]$/, '$1')
  if (name === 'localhost' || name.endsWith('.localhost')) return true
  if (isIP(name)) return isLocalAddress(name)
  try {
    const addresses = await lookup(name, { all: true })
    return addresses.length === 0 || addresses.some(({ address }) => isLocalAddress(address))
  } catch {
    return true
  }
}
