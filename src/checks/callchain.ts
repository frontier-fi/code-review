import { Abi, Address, zeroAddress } from 'viem'
import RateProviderDataService from '../app'
import { Client, hasCode, parseAbiSafe, sameAddress } from './common'

/**
 * A contract touched by the reviewed call (`getRate` for rate providers, `previewMint`
 * for ERC4626 vaults), as seen through the call's access list.
 */
export interface CallchainContract {
    address: Address
    name: string
    /** The contract's own source is verified on the explorer. */
    verified: boolean
    isProxy: boolean
    implementation?: Address
    /** Only meaningful for proxies. */
    implementationVerified?: boolean
    /** Implementation ABI for proxies, own ABI otherwise. Empty if unverified. */
    abi: Abi
    /** Raw source text of the contract and, for proxies, its implementation. */
    sources: string[]
}

export interface Callchain {
    /** The reviewed contract (rate provider or ERC4626 vault). */
    target: Address
    /** Contracts in the call path. Implementations behind a proxy are folded into their proxy. */
    contracts: CallchainContract[]
    /** Every address with code in the access list, implementations included. */
    accessListAddresses: Address[]
}

export async function loadCallchain(service: RateProviderDataService, client: Client): Promise<Callchain> {
    const target = service.rateProvider
    const candidates: Address[] = service.accessList.accessList.map((a) => a.address)
    if (!candidates.some((a) => sameAddress(a, target))) candidates.push(target)

    // Access lists can include addresses without code (e.g. balance lookups); skip those.
    const withCode: Address[] = []
    for (const address of dedupe(candidates)) {
        if (sameAddress(address, target) || (await hasCode(client, address))) withCode.push(address)
    }

    const infos = await service.getContractInfo(withCode)
    const infoFor = (a: string) => infos.find((i) => sameAddress(i.address, a))

    const proxyImplementations = infos
        .filter((i) => i.Proxy === '1' && i.Implementation && !sameAddress(i.Implementation, zeroAddress))
        .map((i) => i.Implementation)

    // Fetch implementations that were not in the access list themselves.
    const implInfos = await service.getContractInfo(dedupe(proxyImplementations))
    const implInfoFor = (a: string) => implInfos.find((i) => sameAddress(i.address, a))

    const contracts: CallchainContract[] = withCode
        // implementations are reached through their proxy; reporting them separately would double count
        .filter((address) => !proxyImplementations.some((impl) => sameAddress(impl, address)))
        .map((address) => {
            const info = infoFor(address)
            const isProxy = info?.Proxy === '1' && !!info.Implementation
            const impl = isProxy ? implInfoFor(info!.Implementation) : undefined
            return {
                address,
                name: impl?.ContractName || info?.ContractName || 'unknown',
                verified: !!info,
                isProxy,
                implementation: isProxy ? info!.Implementation : undefined,
                implementationVerified: isProxy ? !!impl : undefined,
                abi: parseAbiSafe(isProxy ? impl?.ABI : info?.ABI),
                sources: [info?.SourceCode, impl?.SourceCode].filter((s): s is string => !!s),
            }
        })

    return { target, contracts, accessListAddresses: withCode }
}

function dedupe(addresses: Address[]): Address[] {
    const out: Address[] = []
    for (const a of addresses) if (!out.some((o) => sameAddress(o, a))) out.push(a)
    return out
}
