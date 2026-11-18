import { Address, Chain, createPublicClient, http, parseAbi } from 'viem'
import { arbitrum, avalanche, base, mainnet, monad, sepolia } from 'viem/chains'

const factoryAbi = parseAbi(['function isRateProviderFromFactory(address rateProvider) view returns (bool)'])

/**
 * Known rate provider factories per chain. All of them are immutable (no proxy, owner or
 * disable function) and permissionless, and the rate providers they create have no admin.
 */
export const rateProviderFactories: { [chainId: number]: Address[] } = {
    [mainnet.id]: [
        '0x1311Fbc9F60359639174c1e7cC2032DbDb5Cc4d1', // ChainlinkRateProviderFactory
        '0xFC541f8d8c5e907E236C8931F0Df9F58e0C259Ec', // ERC4626RateProviderFactory
        '0xeC2C6184761ab7fE061130B4A7e3Da89c72F8395', // AaveMarketRateTransformerFactory
        '0x1973A094af519CA65cE5ce79E7A8c87dC2fF1767', // ConstantRateProviderFactory
        '0xd2cd8027F8c4B8ddCd1bFcD4e47587f41F2712f2', // CombinedRateProviderFactory
    ],
    [arbitrum.id]: [
        '0x5DbAd78818D4c8958EfF2d5b95b28385A22113Cd', // ChainlinkRateProviderFactory
        '0xe548a29631f9E49830bE8edc22d407b2D2915F31', // ERC4626RateProviderFactory
        '0xeC2C6184761ab7fE061130B4A7e3Da89c72F8395', // AaveMarketRateTransformerFactory
        '0xF502791715F287989374c452Fa78b475A3194a90', // ConstantRateProviderFactory
        '0x26dEc0e6a4249F28e0f16A1a79808bF9ba308310', // CombinedRateProviderFactory
    ],
    [base.id]: [
        '0x0A973B6DB16C2ded41dC91691Cc347BEb0e2442B', // ChainlinkRateProviderFactory
        '0xEfD3aF73d3359014f3B864d37AC672A6d3D7ff1A', // ERC4626RateProviderFactory
        '0x4E185b1502Fea7a06B63fDdA6de38F92C9528566', // AaveMarketRateTransformerFactory
        '0xc0555b555857AAf2b5b28601eaAcFba2F8BBFB09', // ConstantRateProviderFactory
        '0x40B48e1eB72c62f7201B4C2621Df7D822CCB9944', // CombinedRateProviderFactory
    ],
    [avalanche.id]: [
        '0x76578ecf9a141296Ec657847fb45B0585bCDa3a6', // ChainlinkRateProviderFactory
        '0xfCe81cafe4b3F7e2263EFc2d907f488EBF2B238E', // ERC4626RateProviderFactory
        '0xeC2C6184761ab7fE061130B4A7e3Da89c72F8395', // CombinedRateProviderFactory
    ],
    [monad.id]: [
        '0x138D9E0d0Cc4906C4cD865b38c9340A5CeDD9850', // ChainlinkRateProviderFactory
        '0xb0334C5287Bfb15A8C9464898CDB0248ED176332', // ERC4626RateProviderFactory
        '0x8942C1e1e0D48E14EFBa4cc48d2E3584116e367f', // CombinedRateProviderFactory
    ],
    [sepolia.id]: [
        '0xA8920455934Da4D853faac1f94Fe7bEf72943eF1', // ChainlinkRateProviderFactory
    ],
}

/**
 * Finds the known factory that created the given rate provider.
 * @returns The factory address, or an empty string if no known factory created it.
 */
export async function findRateProviderFactory(chain: Chain, rateProvider: Address): Promise<Address | ''> {
    const publicClient = createPublicClient({
        chain,
        transport: http(chain.rpcUrls.default.http[0]),
    })

    for (const factory of rateProviderFactories[chain.id] ?? []) {
        const isFromFactory = await publicClient.readContract({
            address: factory,
            abi: factoryAbi,
            functionName: 'isRateProviderFromFactory',
            args: [rateProvider],
        })
        if (isFromFactory) return factory
    }
    return ''
}
