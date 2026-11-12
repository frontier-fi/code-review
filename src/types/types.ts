import { Address, Hex, Chain } from 'viem'

export interface GetContractSourceCodeResult {
    SourceCode: string
    ABI: string
    ContractName: string
    CompilerVersion: string
    OptimizationUsed: string
    Runs: string
    ConstructorArguments: string
    EVMVersion: string
    Library: string
    LicenseType: string
    Proxy: string
    Implementation: Address
    SwarmSource: string
}

export interface GetContractSourceCodeResponse {
    status: string
    message: string
    result: GetContractSourceCodeResult[]
}

export interface TransactionData {
    result: Array<{
        txHash: Hex
        blockNumber: string
        timestamp?: string
    }>
}

/**
 * Contract metadata returned by a chain explorer. `SourceCode` is only set by
 * explorers that return it, and is the raw (possibly JSON-wrapped) source.
 */
export interface ContractSourceInfo {
    address: Address
    Proxy: string
    ContractName: string
    ABI: string
    Implementation: Address
    SourceCode?: string
}

/**
 * Interface for chain explorer APIs that provide contract source code
 * and deployment information.
 */
export interface ChainApi {
    /**
     * The chain this API instance is configured for.
     */
    readonly chain: Chain
    /**
     * Fetches source code information for the given addresses.
     * @param addresses The addresses to fetch source code for.
     * @returns An array of contract information including ABI, proxy status, etc.
     */
    getSourceCode(addresses: Address[]): Promise<ContractSourceInfo[]>

    /**
     * Fetches deployment transaction hash and block number for the given addresses.
     * @param addresses The addresses to fetch deployment information for.
     * @returns An array of deployment information.
     */
    getDeploymentTxHashAndBlock(
        addresses: Address[],
    ): Promise<{ address: Address; deploymentTxHash: Hex; blockNumber: string; timestamp?: string }[]>
}
