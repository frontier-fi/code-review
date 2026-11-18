import * as dotenv from 'dotenv'
import path from 'path'
import { Address, Chain } from 'viem'
import { arbitrum, avalanche, base, mainnet, monad, sepolia } from 'viem/chains'
import { findRateProviderFactory } from '../src/utils/rateProviderFactories'

dotenv.config()
const fs = require('fs')

// Fills in the factory field of rate provider registry entries that were created by a known factory.
// npm run backfill-factories

// Map registry key to Chain object and dRPC network name
const networks: { [key: string]: { chain: Chain; drpcNetwork: string } } = {
    ethereum: { chain: mainnet, drpcNetwork: 'ethereum' },
    arbitrum: { chain: arbitrum, drpcNetwork: 'arbitrum' },
    base: { chain: base, drpcNetwork: 'base' },
    avalanche: { chain: avalanche, drpcNetwork: 'avalanche' },
    monad: { chain: monad, drpcNetwork: 'monad' },
    sepolia: { chain: sepolia, drpcNetwork: 'sepolia' },
}

async function main() {
    if (!process.env.DRPC_API_KEY) {
        throw new Error('DRPC_API_KEY is not set')
    }

    const registryPath = path.join(__dirname, '../rate-providers/registry.json')
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'))

    for (const [registryKey, { chain, drpcNetwork }] of Object.entries(networks)) {
        const network = {
            ...chain,
            rpcUrls: {
                ...chain.rpcUrls,
                default: { http: [`https://lb.drpc.live/${drpcNetwork}/${process.env.DRPC_API_KEY}`] },
            },
        }

        let filled = 0
        for (const [rateProvider, entry] of Object.entries<{ factory: string }>(registry[registryKey] ?? {})) {
            if (entry.factory !== '') continue
            const factory = await findRateProviderFactory(network, rateProvider as Address)
            if (factory !== '') {
                entry.factory = factory
                filled++
            }
        }
        console.log(`${registryKey}: filled in ${filled} factories`)
    }

    fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n')
}

main().catch((error) => {
    console.error(error)
    process.exit(1)
})
