import { Address, erc20Abi, erc4626Abi } from 'viem'
import RateProviderDataService from '../app'
import { Callchain } from './callchain'
import { Client, diffBps, sameAddress, tryRead } from './common'

/**
 * Check 7: basic hygiene.
 * - every contract in the call path has verified source
 * - age of the reviewed contract
 * - the rate provider actually reads the submitted asset
 * - when the asset is an ERC4626 vault, getRate matches the vault's own exchange rate
 */

export interface UnverifiedContract {
    address: Address
    /** true when the proxy is verified but its implementation is not */
    implementationOnly: boolean
    implementation?: Address
}

export interface HygieneCheckResult {
    unverified: UnverifiedContract[]
    deployedAt?: number
    ageDays?: number
    /** set for rate provider reviews */
    assetInCallPath?: boolean
    erc4626Consistency?: Erc4626RateConsistency
}

export interface Erc4626RateConsistency {
    vault: Address
    underlying: Address
    /** convertToAssets(1 share), scaled to 18 decimals */
    vaultRate: bigint
    providerRate: bigint
    diffBps?: number
}

export async function checkHygiene(
    client: Client,
    service: RateProviderDataService,
    callchain: Callchain,
    options: { asset?: Address; providerRate?: bigint } = {},
): Promise<HygieneCheckResult> {
    const unverified: UnverifiedContract[] = []
    for (const c of callchain.contracts) {
        if (!c.verified) unverified.push({ address: c.address, implementationOnly: false })
        else if (c.isProxy && !c.implementationVerified)
            unverified.push({ address: c.address, implementationOnly: true, implementation: c.implementation })
    }

    const result: HygieneCheckResult = { unverified }

    const deployedAt = await getDeploymentTimestamp(client, service, callchain.target)
    if (deployedAt) {
        result.deployedAt = deployedAt
        result.ageDays = Math.floor((Date.now() / 1000 - deployedAt) / 86400)
    }

    if (options.asset) {
        result.assetInCallPath = callchain.accessListAddresses.some((a) => sameAddress(a, options.asset))
        if (options.providerRate !== undefined) {
            result.erc4626Consistency = await checkErc4626Rate(client, options.asset, options.providerRate)
        }
    }

    return result
}

async function getDeploymentTimestamp(
    client: Client,
    service: RateProviderDataService,
    address: Address,
): Promise<number | undefined> {
    try {
        const [deployment] = await service.getDeploymentBlocks([address])
        if (!deployment) return undefined
        // Etherscan returns the creation timestamp directly; other explorers need a block lookup.
        if (deployment.timestamp) return Number(deployment.timestamp)
        if (deployment.blockNumber) {
            const block = await client.getBlock({ blockNumber: BigInt(deployment.blockNumber) })
            return Number(block.timestamp)
        }
        if (!deployment.deploymentTxHash) return undefined
        const receipt = await client.getTransactionReceipt({ hash: deployment.deploymentTxHash })
        const block = await client.getBlock({ blockNumber: receipt.blockNumber })
        return Number(block.timestamp)
    } catch (error) {
        console.warn(
            `Could not determine deployment time for ${address}:`,
            error instanceof Error ? error.message : error,
        )
        return undefined
    }
}

async function checkErc4626Rate(
    client: Client,
    vault: Address,
    providerRate: bigint,
): Promise<Erc4626RateConsistency | undefined> {
    const underlying = await tryRead<Address>(client, vault, erc4626Abi, 'asset')
    if (!underlying) return undefined
    const shareDecimals = await tryRead<number>(client, vault, erc20Abi, 'decimals')
    const assetDecimals = await tryRead<number>(client, underlying, erc20Abi, 'decimals')
    if (shareDecimals === undefined || assetDecimals === undefined) return undefined

    // Convert enough shares that the result carries 18 decimals of precision even for
    // low-decimal assets (e.g. USDC), so small mismatches are not hidden by rounding.
    const scale = 10n ** BigInt(Math.max(0, 18 - assetDecimals))
    const assetsForShares = await tryRead<bigint>(client, vault, erc4626Abi, 'convertToAssets', [
        10n ** BigInt(shareDecimals) * scale,
    ])
    if (assetsForShares === undefined) return undefined

    const vaultRate = (assetsForShares * 10n ** 18n) / (10n ** BigInt(assetDecimals) * scale)
    return { vault, underlying, vaultRate, providerRate, diffBps: diffBps(providerRate, vaultRate) }
}
