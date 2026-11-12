import { Address, Chain, parseAbi } from 'viem'
import { arbitrum, base, optimism } from 'viem/chains'
import { Callchain } from './callchain'
import { Client, latestTimestamp, sameAddress, tryRead } from './common'

/**
 * Check 2: oracle detection and staleness.
 *
 * Probes every contract in the call path for well-known oracle interfaces, reports how
 * old each feed's latest answer is, and searches the reviewed contract's source for a
 * staleness guard and (on L2s) a sequencer-uptime check.
 *
 * Any detected oracle means the rate is not a pure on-chain yield rate, so the caller
 * applies the `market-rate` warning automatically.
 */

const probeAbi = parseAbi([
    'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
    'function decimals() view returns (uint8)',
    'function description() view returns (string)',
    'function aggregator() view returns (address)',
    // API3 dAPI proxies
    'function read() view returns (int224 value, uint32 timestamp)',
    // Chronicle
    'function readWithAge() view returns (uint256 value, uint256 age)',
    // Pyth core contract
    'function getValidTimePeriod() view returns (uint256)',
])

/** Answers older than this are flagged. Most Chainlink/API3 heartbeats are 24h or less. */
const STALE_AFTER_SECONDS = 26 * 3600

const STALENESS_GUARD =
    /stale|heartbeat|maxAge|max_age|maxDelay|max_delay|maxTimeDelay|getPriceNoOlderThan|validTimePeriod|block\.timestamp\s*-\s*\w*updated/i
const SEQUENCER_CHECK = /sequencer/i
const L2_CHAINS_WITH_SEQUENCER_FEEDS = [arbitrum.id, base.id, optimism.id] as number[]

export type FeedType = 'Chainlink-compatible' | 'API3' | 'Chronicle' | 'Pyth'

export interface DetectedFeed {
    address: Address
    name: string
    type: FeedType
    description?: string
    answer?: bigint
    decimals?: number
    ageSeconds?: number
    stale?: boolean
}

export interface OracleCheckResult {
    feeds: DetectedFeed[]
    /** undefined when no source was available to search */
    stalenessGuardFound?: boolean
    /** only set on L2s where a sequencer check is relevant */
    sequencerCheckFound?: boolean
    l2RequiresSequencerCheck: boolean
}

export async function checkOracles(client: Client, chain: Chain, callchain: Callchain): Promise<OracleCheckResult> {
    const now = await latestTimestamp(client)
    const feeds: DetectedFeed[] = []

    // The reviewed contract itself is excluded: many rate providers expose a Chainlink-style
    // interface on top of a purely on-chain rate.
    const candidates = callchain.contracts.filter((c) => !sameAddress(c.address, callchain.target))

    for (const contract of candidates) {
        const feed = await probeFeed(client, contract.address, now)
        if (feed) feeds.push({ ...feed, name: contract.name })
    }

    // A Chainlink proxy and its aggregator both answer latestRoundData; keep only the proxy.
    const aggregators = await Promise.all(feeds.map((f) => tryRead<Address>(client, f.address, probeAbi, 'aggregator')))
    const deduped = feeds.filter((f) => !aggregators.some((agg) => sameAddress(agg, f.address)))

    // Search the reviewed contract and any non-feed contracts for guards. All feed contracts,
    // aggregators included, are excluded: their own code mentions staleness without guarding the reader.
    const sources = callchain.contracts
        .filter((c) => !feeds.some((f) => sameAddress(f.address, c.address)))
        .flatMap((c) => c.sources)
    const haveSource = sources.length > 0
    const l2RequiresSequencerCheck = deduped.length > 0 && L2_CHAINS_WITH_SEQUENCER_FEEDS.includes(chain.id)

    return {
        feeds: deduped,
        stalenessGuardFound: haveSource ? sources.some((s) => STALENESS_GUARD.test(s)) : undefined,
        sequencerCheckFound:
            l2RequiresSequencerCheck && haveSource ? sources.some((s) => SEQUENCER_CHECK.test(s)) : undefined,
        l2RequiresSequencerCheck,
    }
}

async function probeFeed(
    client: Client,
    address: Address,
    now: number,
): Promise<Omit<DetectedFeed, 'name'> | undefined> {
    const round = await tryRead<readonly [bigint, bigint, bigint, bigint, bigint]>(
        client,
        address,
        probeAbi,
        'latestRoundData',
    )
    if (round) {
        const [, answer, , updatedAt] = round
        // updatedAt must look like a unix timestamp; filters out unrelated functions sharing the selector shape
        if (updatedAt > 1_000_000_000n && updatedAt <= BigInt(now + 3600)) {
            const isApi3 = (await tryRead(client, address, probeAbi, 'read')) !== undefined
            const ageSeconds = now - Number(updatedAt)
            return {
                address,
                type: isApi3 ? 'API3' : 'Chainlink-compatible',
                description: await tryRead<string>(client, address, probeAbi, 'description'),
                decimals: await tryRead<number>(client, address, probeAbi, 'decimals'),
                answer,
                ageSeconds,
                stale: ageSeconds > STALE_AFTER_SECONDS,
            }
        }
    }

    const api3 = await tryRead<readonly [bigint, number]>(client, address, probeAbi, 'read')
    if (api3 && api3[1] > 1_000_000_000 && api3[1] <= now + 3600) {
        const ageSeconds = now - api3[1]
        return { address, type: 'API3', answer: api3[0], ageSeconds, stale: ageSeconds > STALE_AFTER_SECONDS }
    }

    const chronicle = await tryRead<readonly [bigint, bigint]>(client, address, probeAbi, 'readWithAge')
    if (chronicle && chronicle[1] > 1_000_000_000n) {
        const ageSeconds = now - Number(chronicle[1])
        return {
            address,
            type: 'Chronicle',
            answer: chronicle[0],
            ageSeconds,
            stale: ageSeconds > STALE_AFTER_SECONDS,
        }
    }

    const pythPeriod = await tryRead<bigint>(client, address, probeAbi, 'getValidTimePeriod')
    if (pythPeriod !== undefined) {
        return { address, type: 'Pyth' }
    }

    return undefined
}
