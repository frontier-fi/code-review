import { Address, PublicClient } from 'viem'

// https://eips.ethereum.org/EIPS/eip-1967
const implementationSlot = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const beaconSlot = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50'

/**
 * Reads the ERC-1967 implementation and beacon slots of a proxy at the given block.
 * Comparing the result at two blocks shows whether the proxy was upgraded in between.
 * @returns Both slot values joined, or undefined if neither slot is set.
 */
export async function getErc1967Pointers(
    publicClient: PublicClient,
    address: Address,
    blockNumber: bigint,
): Promise<string | undefined> {
    const [implementation, beacon] = await Promise.all([
        publicClient.getStorageAt({ address, slot: implementationSlot, blockNumber }),
        publicClient.getStorageAt({ address, slot: beaconSlot, blockNumber }),
    ])
    if (!isSet(implementation) && !isSet(beacon)) return undefined
    return `${implementation}:${beacon}`
}

function isSet(value: string | undefined): boolean {
    return value !== undefined && BigInt(value) !== 0n
}
