import { Address } from 'viem'
import RateProviderDataService from '../app'
import { checkAdminControl, AdminCheckResult } from './admin'
import { loadCallchain } from './callchain'
import { createClient } from './common'
import { checkErc4626Liquidity, Erc4626LiquidityResult } from './erc4626Liquidity'
import { checkHygiene, HygieneCheckResult } from './hygiene'
import { checkOracles, OracleCheckResult } from './oracle'
import { checkSpotPrice, SpotPriceCheckResult } from './spotPrice'
import { checkTokenRisks, TokenRiskResult } from './token'

export { renderSecurityChecks } from './report'

/** A check either produced a result or failed with an error message; one failure never stops the review. */
export type Outcome<T> = { ok: true; value: T } | { ok: false; error: string }

export interface SecurityCheckResults {
    admin: Outcome<AdminCheckResult>
    oracle: Outcome<OracleCheckResult>
    spot: Outcome<SpotPriceCheckResult>
    hygiene: Outcome<HygieneCheckResult>
    tokens: Outcome<TokenRiskResult>[]
    liquidity?: Outcome<Erc4626LiquidityResult>
}

async function attempt<T>(name: string, fn: () => Promise<T>): Promise<Outcome<T>> {
    try {
        return { ok: true, value: await fn() }
    } catch (error) {
        const message = error instanceof Error ? error.message.split('\n')[0] : String(error)
        console.warn(`Security check "${name}" failed: ${message}`)
        return { ok: false, error: message }
    }
}

/**
 * Runs the automated security checks for a rate provider.
 * `service` must already be initialized (access list loaded).
 */
export async function runRateProviderChecks(
    service: RateProviderDataService,
    options: { asset: Address; providerRate?: bigint },
): Promise<SecurityCheckResults> {
    const client = createClient(service.chain)
    const callchain = await loadCallchain(service, client)

    const admin = await attempt('admin control', () => checkAdminControl(client, callchain))
    const oracle = await attempt('oracles', () => checkOracles(client, service.chain, callchain))
    const spot = await attempt('spot price', () => checkSpotPrice(client, callchain))
    const hygiene = await attempt('hygiene', () =>
        checkHygiene(client, service, callchain, { asset: options.asset, providerRate: options.providerRate }),
    )

    // The pool holds the asset; when that asset is an ERC4626 vault, its underlying matters too.
    const tokenAddresses: Address[] = [options.asset]
    const underlying = hygiene.ok ? hygiene.value.erc4626Consistency?.underlying : undefined
    if (underlying) tokenAddresses.push(underlying)
    const tokens: Outcome<TokenRiskResult>[] = []
    for (const token of tokenAddresses) {
        tokens.push(await attempt(`token risks ${token}`, () => checkTokenRisks(client, service, token)))
    }

    return { admin, oracle, spot, hygiene, tokens }
}

/**
 * Runs the automated security checks for an ERC4626 vault.
 * `service` must already be initialized (access list loaded).
 */
export async function runErc4626Checks(service: RateProviderDataService): Promise<SecurityCheckResults> {
    const client = createClient(service.chain)
    const callchain = await loadCallchain(service, client)

    const admin = await attempt('admin control', () => checkAdminControl(client, callchain))
    const oracle = await attempt('oracles', () => checkOracles(client, service.chain, callchain))
    const spot = await attempt('spot price', () => checkSpotPrice(client, callchain))
    const hygiene = await attempt('hygiene', () => checkHygiene(client, service, callchain))
    const liquidity = await attempt('ERC4626 liquidity', () => checkErc4626Liquidity(client, service.rateProvider))

    const tokens: Outcome<TokenRiskResult>[] = []
    const underlying = liquidity.ok ? liquidity.value.underlying : undefined
    if (underlying) {
        tokens.push(await attempt(`token risks ${underlying}`, () => checkTokenRisks(client, service, underlying)))
    }

    return { admin, oracle, spot, hygiene, tokens, liquidity }
}

/** Unverified contracts in the call path make the review unusable. */
export function hasUnverifiedContracts(results: SecurityCheckResults): boolean {
    return results.hygiene.ok && results.hygiene.value.unverified.length > 0
}

/** Any oracle in the call path means the rate is not a pure yield rate. */
export function hasOracle(results: SecurityCheckResults): boolean {
    return results.oracle.ok && results.oracle.value.feeds.length > 0
}
