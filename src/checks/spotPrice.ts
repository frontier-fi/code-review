import { Address, parseAbi } from 'viem'
import { Callchain } from './callchain'
import { Client, sameAddress, stripComments, tryRead } from './common'

/**
 * Check 3: spot-price reads and read-only reentrancy.
 *
 * Flags contracts in the call path that are AMM pools. Reading their current state
 * (reserves, slot0, virtual price, BPT rate) can be moved by a large swap or flash loan
 * inside one transaction, and Curve and Balancer V2 pool reads are open to read-only
 * reentrancy unless the reader checks the pool's reentrancy lock.
 */

const probeAbi = parseAbi([
    'function getReserves() view returns (uint256, uint256, uint256)',
    'function slot0() view returns (uint160 sqrtPriceX96, int24 tick)',
    'function globalState() view returns (uint160 price, int24 tick)',
    'function get_virtual_price() view returns (uint256)',
    'function getPoolId() view returns (bytes32)',
    'function token0() view returns (address)',
])

export type PoolKind = 'Uniswap V2-style' | 'Uniswap V3-style' | 'Algebra' | 'Curve' | 'Balancer V2'

export interface DetectedPool {
    address: Address
    name: string
    kind: PoolKind
    risk: string
}

export interface SpotPriceCheckResult {
    pools: DetectedPool[]
    twapUsageFound: boolean
    balancerReentrancyGuardFound: boolean
    curveReentrancyGuardFound: boolean
}

// Call sites only. `function observe(` in a bundled pool interface is a declaration, not usage.
const TWAP = /\.observe\s*\(|\.getTimepoints\s*\(|(?<!function\s+)\b(?:consult\w*|getTimeWeighted\w*|\w*twap\w*)\s*\(/i
const BALANCER_GUARD = /ensureNotInVaultContext|VaultReentrancyLib/
// Curve pools have no view reentrancy lock; integrators call a state-changing no-op
// (e.g. withdraw_admin_fees / remove_liquidity of 0) to trip the lock.
const CURVE_GUARD = /withdraw_admin_fees|claim_admin_fees|remove_liquidity\s*\(\s*0|reentrancy/i

export async function checkSpotPrice(client: Client, callchain: Callchain): Promise<SpotPriceCheckResult> {
    const pools: DetectedPool[] = []

    for (const contract of callchain.contracts) {
        const kind = await probePool(client, contract.address)
        if (kind) pools.push({ address: contract.address, name: contract.name, kind, risk: riskFor(kind) })
    }

    // Only the reading contracts count. A pool's own source defines observe(), lock
    // checks, etc., which says nothing about whether the reader uses them.
    const sources = callchain.contracts
        .filter((c) => !pools.some((p) => sameAddress(p.address, c.address)))
        .flatMap((c) => c.sources)
        .map(stripComments)
    return {
        pools,
        twapUsageFound: sources.some((s) => TWAP.test(s)),
        balancerReentrancyGuardFound: sources.some((s) => BALANCER_GUARD.test(s)),
        curveReentrancyGuardFound: sources.some((s) => CURVE_GUARD.test(s)),
    }
}

async function probePool(client: Client, address: Address): Promise<PoolKind | undefined> {
    if ((await tryRead(client, address, probeAbi, 'getPoolId')) !== undefined) return 'Balancer V2'
    if ((await tryRead(client, address, probeAbi, 'get_virtual_price')) !== undefined) return 'Curve'

    // The AMM shapes below are only treated as pools if they also have a token0, which
    // filters out unrelated contracts that happen to share a function name.
    const hasToken0 = (await tryRead(client, address, probeAbi, 'token0')) !== undefined
    if (!hasToken0) return undefined
    if ((await tryRead(client, address, probeAbi, 'slot0')) !== undefined) return 'Uniswap V3-style'
    if ((await tryRead(client, address, probeAbi, 'globalState')) !== undefined) return 'Algebra'
    if ((await tryRead(client, address, probeAbi, 'getReserves')) !== undefined) return 'Uniswap V2-style'
    return undefined
}

function riskFor(kind: PoolKind): string {
    switch (kind) {
        case 'Uniswap V2-style':
            return 'Spot reserves can be moved within one transaction by a large swap or flash loan.'
        case 'Uniswap V3-style':
        case 'Algebra':
            return 'Spot price (slot0/globalState) can be moved within one transaction. A TWAP via observe() is much harder to manipulate.'
        case 'Curve':
            return 'get_virtual_price and pool balances can be read mid-withdrawal (read-only reentrancy) unless the reader trips the pool lock first.'
        case 'Balancer V2':
            return 'Pool rates and balances can be read mid-join/exit (read-only reentrancy) unless the reader calls VaultReentrancyLib.ensureNotInVaultContext.'
    }
}
