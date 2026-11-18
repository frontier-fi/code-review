import { Address, Hex, Chain, createPublicClient, http } from 'viem'
import { ChainApi, ContractSourceInfo } from '../types/types'

/**
 * RpcApi class to look up contract deployments directly over RPC.
 * Used for chains where no free explorer API exposes contract creation info.
 * Requires an archive RPC, since it reads contract code at historical blocks.
 */
class RpcApi implements ChainApi {
    public chain: Chain

    constructor(chain: Chain) {
        this.chain = chain
    }

    /**
     * Finds the deployment block for the given addresses by binary searching for the
     * first block at which the address has code. Does not return the deployment tx hash.
     * Implements ChainApi interface.
     */
    public async getDeploymentTxHashAndBlock(
        addresses: Address[],
    ): Promise<{ address: Address; deploymentTxHash?: Hex; blockNumber: string }[]> {
        const publicClient = createPublicClient({
            chain: this.chain,
            transport: http(this.chain.rpcUrls.default.http[0]),
        })
        const latestBlock = await publicClient.getBlockNumber()

        return Promise.all(
            addresses.map(async (address) => {
                if (!(await this.hasCode(publicClient, address, latestBlock))) {
                    throw new Error(`No code found at address ${address} on ${this.chain.name}`)
                }

                let low = 0n
                let high = latestBlock
                while (low < high) {
                    const mid = (low + high) / 2n
                    if (await this.hasCode(publicClient, address, mid)) {
                        high = mid
                    } else {
                        low = mid + 1n
                    }
                }
                return { address, blockNumber: low.toString() }
            }),
        )
    }

    private async hasCode(
        publicClient: ReturnType<typeof createPublicClient>,
        address: Address,
        blockNumber: bigint,
    ): Promise<boolean> {
        const code = await publicClient.getCode({ address, blockNumber })
        return code !== undefined && code !== '0x'
    }

    /**
     * Fetches source code information for the given addresses.
     * Implements ChainApi interface.
     * Not available over RPC - will throw an error.
     */
    public async getSourceCode(addresses: Address[]): Promise<ContractSourceInfo[]> {
        throw new Error('getSourceCode is not available for RpcApi')
    }
}

export default RpcApi
