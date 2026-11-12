import { Address, erc20Abi, parseAbi, zeroAddress } from 'viem'
import RateProviderDataService from '../app'
import { Client, allNames, parseAbiSafe, tryRead, unique } from './common'

/**
 * Check 9: risks of the token held by the pool.
 * Flags pausable, blocklisting, rebasing and fee-on-transfer tokens from their ABI,
 * plus whether the token is paused right now.
 */

const probeAbi = parseAbi(['function paused() view returns (bool)'])

const PAUSABLE = /^(pause|unpause|paused|whenNotPaused|Paused|Unpaused)$/
const BLOCKLIST = /black.?list|block.?list|deny.?list|freeze|frozen|isBlocked|addBlocked|sanction/i
const REBASING =
    /rebase|sharesOf|getSharesByPooled|getPooledEthByShares|scaledBalanceOf|gonsPerFragment|underlyingBalanceOf|rebasingCredits/i
// USDT exposes basisPointsRate/maximumFee; tax tokens usually have *Fee / setTax setters.
const FEE_ON_TRANSFER =
    /basisPointsRate|maximumFee|transferFee|taxFee|sellFee|buyFee|setTax|setFee|feeOnTransfer|_fee\b/i

export interface TokenRiskResult {
    address: Address
    symbol?: string
    /** False when the token's ABI could not be obtained, so the feature lists below are empty, not clean. */
    abiChecked: boolean
    abiUnavailableReason?: string
    pausedNow?: boolean
    pausable: string[]
    blocklist: string[]
    rebasing: string[]
    feeOnTransfer: string[]
}

export async function checkTokenRisks(
    client: Client,
    service: RateProviderDataService,
    token: Address,
): Promise<TokenRiskResult> {
    const [info] = await service.getContractInfo([token])
    let abi = parseAbiSafe(info?.ABI)
    let unavailableReason: string | undefined = info ? undefined : 'source unverified'
    if (info?.Proxy === '1' && info.Implementation && info.Implementation !== zeroAddress) {
        const [impl] = await service.getContractInfo([info.Implementation])
        abi = parseAbiSafe(impl?.ABI)
        // The proxy's own ABI says nothing about the token's features, so don't fall back to it.
        if (!impl) unavailableReason = `implementation ${info.Implementation} is unverified`
    }
    if (!unavailableReason && abi.length === 0) unavailableReason = 'the ABI could not be read'

    const names = unique(allNames(abi))
    const matching = (re: RegExp) => names.filter((n) => re.test(n))

    return {
        address: token,
        symbol: await tryRead<string>(client, token, erc20Abi, 'symbol'),
        abiChecked: !unavailableReason,
        abiUnavailableReason: unavailableReason,
        pausedNow: await tryRead<boolean>(client, token, probeAbi, 'paused'),
        pausable: matching(PAUSABLE),
        blocklist: matching(BLOCKLIST),
        rebasing: matching(REBASING),
        feeOnTransfer: matching(FEE_ON_TRANSFER),
    }
}
