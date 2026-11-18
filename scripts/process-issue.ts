import * as dotenv from 'dotenv'
import { writeReviewAndUpdateRegistry as writeERC4626ReviewAndUpdateRegistry } from '../src/utils/write-erc4626-review'
import { writeReviewAndUpdateRegistry } from '../src/utils/write-rp-review'

dotenv.config()

import { base, mainnet, arbitrum, avalanche, Chain, monad, sepolia } from 'viem/chains'
import { Hex } from 'viem'

/* 
The additional_contract_information can contain the below strings

"Does this rate provider pertain to an ERC4626 contract?",
"If so, is the intention for this ERC4626 asset to be boosted?",
"If so, shall the underlying asset be used to add/remove liquidity in a pool if possible? (i.e. add USDC for waUSDC)",
"If so, shall the wrapped asset also be used to add/remove liquidity in a pool? (i.e. add waUSDC directly)",
"Is a combined rate provider needed (i.e. wstETH in aave)?"
*/
interface IssueData {
    additional_contract_information: {
        selected: string[]
        unselected: string[]
    }
    network: string
    rate_provider_contract_address: Hex
    asset_contract_address: Hex
    audits: string
    protocol_documentation: string
    erc4626_asset_contract_address: Hex
    erc4626_asset_contract_audits: string
    erc4626_asset_contract_documentation: string
    link_to_passing_fork_tests: string
    terms_and_conditions: {
        selected: string[]
        unselected: string[]
    }
}

async function processIssue(issueJson: string) {
    // the issue is parsed via https://github.com/marketplace/actions/issue-template-parser

    const issueData: IssueData = JSON.parse(issueJson)

    // Map network name to Chain object
    const networks: { [key: string]: Chain } = {
        base,
        mainnet,
        arbitrum,
        avalanche,
        monad,
        sepolia,
    }
    // Map network name to dRPC network name
    const drpcNetworks: { [key: string]: string } = {
        base: 'base',
        mainnet: 'ethereum',
        arbitrum: 'arbitrum',
        avalanche: 'avalanche',
        monad: 'monad',
        sepolia: 'sepolia',
    }
    let network = networks[issueData.network]
    if (!network || !drpcNetworks[issueData.network]) {
        throw new Error(`Unsupported network: ${issueData.network}`)
    }

    // build the dRPC URL from the API key
    if (!process.env.DRPC_API_KEY) {
        throw new Error('DRPC_API_KEY is not set')
    }
    const rpcUrl = `https://lb.drpc.live/${drpcNetworks[issueData.network]}/${process.env.DRPC_API_KEY}`

    // replace the default network url with the passed one
    // Override the default RPC URL
    // Reason it must be an RPC URL that supports createAccessList
    network = {
        ...network,
        rpcUrls: {
            ...network.rpcUrls,
            default: {
                http: [rpcUrl],
            },
        },
    }

    await writeReviewAndUpdateRegistry(
        issueData.rate_provider_contract_address,
        network,
        issueData.asset_contract_address,
        rpcUrl as string,
        issueData.protocol_documentation,
        issueData.audits,
        issueData.additional_contract_information.selected.includes(
            'Is the rate provider reporting a value other than token yield?',
        )
            ? { isMarketRate: true }
            : undefined,
    )

    // Only continue with erc4626 review if

    //await writeERC4626ReviewAndUpdateRegistry(erc4626Address, network, rpcUrl)
    if (
        issueData.additional_contract_information.selected.includes(
            'If so, is the intention for this ERC4626 asset to be boosted?',
        )
    ) {
        await writeERC4626ReviewAndUpdateRegistry(
            issueData.erc4626_asset_contract_address,
            network,
            rpcUrl,
            issueData.erc4626_asset_contract_audits, //link to audits
            issueData.erc4626_asset_contract_documentation, //written docs excerpt
            issueData.link_to_passing_fork_tests, // are fork tests passing?
            issueData.link_to_passing_fork_tests, //link to passing fork tests
            issueData.additional_contract_information.selected.includes('If so, is the Buffer already initialized?') &&
                issueData.link_to_passing_fork_tests
                ? true
                : false,
            issueData.additional_contract_information.selected.includes(
                'If so, shall the underlying asset be used to add/remove liquidity in a pool if possible? (i.e. add USDC for waUSDC)',
            ),
            issueData.additional_contract_information.selected.includes(
                'If so, shall the wrapped asset also be used to add/remove liquidity in a pool? (i.e. add waUSDC directly)',
            ),
        )
    }
}

// Read from environment variable instead of command line
const issueData = process.env.ISSUE_DATA || process.argv[2] || '{}'
//console.log('Issue data from environment:', issueData)

processIssue(issueData)
