import {
    Abi,
    Address,
    BaseError,
    Chain,
    HttpRequestError,
    LimitExceededRpcError,
    PublicClient,
    TimeoutError,
    WebSocketRequestError,
    createPublicClient,
    http,
} from 'viem'

/**
 * Shared helpers for the automated security checks.
 *
 * Most checks "probe" contracts: they call a function that only a certain kind of
 * contract has (e.g. `latestRoundData()` for a Chainlink-style feed) and treat a
 * successful, well-formed answer as detection. This works for unverified contracts
 * too, since it does not depend on explorer ABIs.
 */

export type Client = PublicClient

export function createClient(chain: Chain): Client {
    return createPublicClient({
        chain,
        transport: http(chain.rpcUrls.default.http[0], { batch: true }),
    }) as Client
}

// Some nodes answer a revert with a non-200 status; those are still reverts, not outages.
const REVERT_HINT = /revert|invalid opcode|out of gas/i

/**
 * True when the RPC itself failed (rate limit, timeout, HTTP error) rather than the
 * contract reverting. Probes must not treat such failures as "not detected".
 */
export function isTransportError(error: unknown): boolean {
    if (!(error instanceof BaseError)) return false
    return !!error.walk(
        (e) =>
            e instanceof TimeoutError ||
            e instanceof WebSocketRequestError ||
            e instanceof LimitExceededRpcError ||
            (e instanceof HttpRequestError &&
                !REVERT_HINT.test(`${e.details} ${e.body ? JSON.stringify(e.body) : ''}`)),
    )
}

/**
 * Calls a view function and returns undefined if it reverts or does not exist.
 * RPC failures are rethrown so the calling check is reported as failed instead of
 * silently reporting "nothing found".
 */
export async function tryRead<T>(
    client: Client,
    address: Address,
    abi: Abi,
    functionName: string,
    args: readonly unknown[] = [],
): Promise<T | undefined> {
    try {
        return (await client.readContract({ address, abi, functionName, args })) as T
    } catch (error) {
        if (isTransportError(error)) throw error
        return undefined
    }
}

export function sameAddress(a?: string, b?: string): boolean {
    return !!a && !!b && a.toLowerCase() === b.toLowerCase()
}

export function parseAbiSafe(abi: string | undefined): Abi {
    if (!abi) return []
    try {
        const parsed = JSON.parse(abi)
        return Array.isArray(parsed) ? (parsed as Abi) : []
    } catch {
        return []
    }
}

/** Names of all non-view, non-pure functions in an ABI. */
export function stateChangingFunctionNames(abi: Abi): string[] {
    return abi
        .filter(
            (item): item is Extract<Abi[number], { type: 'function' }> =>
                item.type === 'function' && item.stateMutability !== 'view' && item.stateMutability !== 'pure',
        )
        .map((item) => item.name)
}

/** Names of all functions and events in an ABI. */
export function allNames(abi: Abi): string[] {
    return abi
        .filter((item) => item.type === 'function' || item.type === 'event')
        .map((item) => (item as { name: string }).name)
}

export function unique<T>(values: T[]): T[] {
    return [...new Set(values)]
}

/**
 * Removes Solidity/Vyper comments so pattern searches only see code. Explorer source
 * may be JSON-wrapped, where newlines are escaped as \\n, so line comments end there too.
 */
export function stripComments(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/.*?(?=\\n|\n|$)/g, ' ')
        .replace(/^\s*#.*$/gm, ' ')
}

export function explorerLink(chain: Chain, address: string): string {
    const base = chain.blockExplorers?.default.url
    return base ? `[${address}](${base}/address/${address})` : `\`${address}\``
}

export function formatDuration(seconds: number): string {
    if (seconds < 120) return `${seconds}s`
    if (seconds < 2 * 3600) return `${Math.round(seconds / 60)}m`
    if (seconds < 2 * 86400) return `${(seconds / 3600).toFixed(1)}h`
    return `${(seconds / 86400).toFixed(1)}d`
}

/** Relative difference of a vs b in basis points (absolute value). */
export function diffBps(a: bigint, b: bigint): number | undefined {
    if (b === 0n) return undefined
    const diff = a > b ? a - b : b - a
    return Number((diff * 1_000_000n) / b) / 100
}

export async function latestTimestamp(client: Client): Promise<number> {
    const block = await client.getBlock({ blockTag: 'latest' })
    return Number(block.timestamp)
}

export async function hasCode(client: Client, address: Address): Promise<boolean> {
    try {
        const code = await client.getCode({ address })
        return !!code && code !== '0x'
    } catch {
        // on RPC failure, keep the address rather than silently dropping it from the review
        return true
    }
}
