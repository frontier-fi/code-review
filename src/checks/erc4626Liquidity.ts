import { Address, erc20Abi, erc4626Abi, parseAbi } from 'viem'
import { Client, diffBps, tryRead } from './common'

/**
 * Check 8: ERC4626 liquidity and fees, which decide whether boosted pools and buffers
 * can wrap and unwrap.
 * - deposit limits (maxDeposit/maxMint for an ordinary address)
 * - idle underlying held by the vault itself, compared with totalAssets
 * - gap between preview* (includes fees) and convert* (fee-free) functions
 * - paused state
 */

const probeAbi = parseAbi(['function paused() view returns (bool)'])

// An ordinary address with no special permissions, used for max* queries.
const PROBE_ACCOUNT = '0x000000000000000000000000000000000000dEaD' as Address

const MAX_UINT = 2n ** 256n - 1n

export interface Erc4626LiquidityResult {
    underlying?: Address
    underlyingSymbol?: string
    shareDecimals?: number
    assetDecimals?: number
    totalAssets?: bigint
    totalSupply?: bigint
    maxDeposit?: bigint
    maxMint?: bigint
    idleAssets?: bigint
    idlePercent?: number
    /** previewRedeem vs convertToAssets */
    redeemFeeBps?: number
    /** previewDeposit vs convertToShares */
    depositFeeBps?: number
    pausedNow?: boolean
}

export async function checkErc4626Liquidity(client: Client, vault: Address): Promise<Erc4626LiquidityResult> {
    const r: Erc4626LiquidityResult = {}

    r.underlying = await tryRead<Address>(client, vault, erc4626Abi, 'asset')
    r.shareDecimals = await tryRead<number>(client, vault, erc20Abi, 'decimals')
    r.totalAssets = await tryRead<bigint>(client, vault, erc4626Abi, 'totalAssets')
    r.totalSupply = await tryRead<bigint>(client, vault, erc20Abi, 'totalSupply')
    r.maxDeposit = await tryRead<bigint>(client, vault, erc4626Abi, 'maxDeposit', [PROBE_ACCOUNT])
    r.maxMint = await tryRead<bigint>(client, vault, erc4626Abi, 'maxMint', [PROBE_ACCOUNT])
    r.pausedNow = await tryRead<boolean>(client, vault, probeAbi, 'paused')

    if (r.underlying) {
        r.underlyingSymbol = await tryRead<string>(client, r.underlying, erc20Abi, 'symbol')
        r.assetDecimals = await tryRead<number>(client, r.underlying, erc20Abi, 'decimals')
        r.idleAssets = await tryRead<bigint>(client, r.underlying, erc20Abi, 'balanceOf', [vault])
        if (r.idleAssets !== undefined && r.totalAssets) {
            r.idlePercent = Number((r.idleAssets * 10_000n) / r.totalAssets) / 100
        }
    }

    // Use 1000 whole units so rounding on low-decimal tokens does not show up as a fee.
    if (r.shareDecimals !== undefined) {
        const shares = 1000n * 10n ** BigInt(r.shareDecimals)
        const preview = await tryRead<bigint>(client, vault, erc4626Abi, 'previewRedeem', [shares])
        const convert = await tryRead<bigint>(client, vault, erc4626Abi, 'convertToAssets', [shares])
        if (preview !== undefined && convert !== undefined) r.redeemFeeBps = diffBps(preview, convert)
    }
    if (r.assetDecimals !== undefined) {
        const assets = 1000n * 10n ** BigInt(r.assetDecimals)
        const preview = await tryRead<bigint>(client, vault, erc4626Abi, 'previewDeposit', [assets])
        const convert = await tryRead<bigint>(client, vault, erc4626Abi, 'convertToShares', [assets])
        if (preview !== undefined && convert !== undefined) r.depositFeeBps = diffBps(preview, convert)
    }

    return r
}

export function isUnlimited(value?: bigint): boolean {
    return value !== undefined && value >= MAX_UINT / 2n
}
