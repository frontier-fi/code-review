import { Address, Hex, StateOverride, erc20Abi, numberToHex, parseAbi } from 'viem'
import { Callchain } from './callchain'
import { Client, diffBps, isTransportError, sameAddress } from './common'

/**
 * Check 8: donation attacks.
 *
 * A rate is open to donation when anyone can move it by sending tokens (or ETH) straight
 * to a contract, e.g. `totalAssets()` that returns `asset.balanceOf(address(this))`.
 *
 * Instead of guessing from source code, this simulates the donation: for every storage
 * slot that `getRate` reads on a token, it raises the slot with an `eth_call` state override
 * and checks whether (a) the rate moves and (b) the slot is a call-path contract's token
 * balance. The same is done for the native balance of every call-path contract.
 * Rates that only pick up donations later (e.g. on a harvest) are not detected.
 */

export interface DonationFinding {
    kind: 'token' | 'native'
    /** The donated token; undefined for native ETH. */
    token?: Address
    /** The contract whose balance was raised. */
    holder: Address
    baseRate: bigint
    donatedRate: bigint
    changeBps?: number
}

export interface DonationCheckResult {
    findings: DonationFinding[]
    slotsTested: number
    /** Storage slots skipped because of MAX_SLOTS. */
    slotsSkipped: number
}

/** On-chain reads the check needs; separated from the client so the logic can be unit tested. */
export interface DonationProbe {
    rate(override?: StateOverride): Promise<bigint | undefined>
    storage(address: Address, slot: Hex): Promise<bigint | undefined>
    nativeBalance(address: Address): Promise<bigint>
    balanceOf(token: Address, holder: Address, override?: StateOverride): Promise<bigint | undefined>
    totalSupply(token: Address, override?: StateOverride): Promise<bigint | undefined>
}

export interface DonationInput {
    /** Contracts whose balance a donation could raise (the target and every call-path contract). */
    holders: Address[]
    /** The access list of the `getRate` call. */
    accessList: readonly { address: Address; storageKeys: readonly Hex[] }[]
}

/** Bounds RPC load on providers with large call paths. */
const MAX_SLOTS = 150
const ONE = 10n ** 18n
/** Values at or above this are not plain balances (packed words, addresses, flags). */
const MAX_PLAUSIBLE_BALANCE = 2n ** 200n

const rateAbi = parseAbi(['function getRate() view returns (uint256)'])

export function clientDonationProbe(client: Client, target: Address): DonationProbe {
    return {
        rate: async (stateOverride) => {
            try {
                return (await client.readContract({
                    address: target,
                    abi: rateAbi,
                    functionName: 'getRate',
                    stateOverride,
                })) as bigint
            } catch (error) {
                if (isTransportError(error)) throw error
                return undefined
            }
        },
        storage: async (address, slot) => {
            try {
                const value = await client.getStorageAt({ address, slot })
                return value ? BigInt(value) : 0n
            } catch (error) {
                if (isTransportError(error)) throw error
                return undefined
            }
        },
        nativeBalance: (address) => client.getBalance({ address }),
        balanceOf: async (token, holder, stateOverride) => {
            try {
                return (await client.readContract({
                    address: token,
                    abi: erc20Abi,
                    functionName: 'balanceOf',
                    args: [holder],
                    stateOverride,
                })) as bigint
            } catch (error) {
                if (isTransportError(error)) throw error
                return undefined
            }
        },
        totalSupply: async (token, stateOverride) => {
            try {
                return (await client.readContract({
                    address: token,
                    abi: erc20Abi,
                    functionName: 'totalSupply',
                    stateOverride,
                })) as bigint
            } catch (error) {
                if (isTransportError(error)) throw error
                return undefined
            }
        },
    }
}

export async function checkDonation(probe: DonationProbe, input: DonationInput): Promise<DonationCheckResult> {
    const baseRate = await probe.rate()
    if (baseRate === undefined) throw new Error('getRate could not be called')

    const holders = dedupe(input.holders)
    const findings: DonationFinding[] = []
    const finding = (f: Omit<DonationFinding, 'baseRate' | 'changeBps'>) =>
        findings.push({ ...f, baseRate, changeBps: diffBps(f.donatedRate, baseRate) })

    // Token balances read by getRate.
    let slotsTested = 0
    let slotsSkipped = 0
    const balanceCache = new Map<string, bigint | undefined>()
    const currentBalance = async (token: Address, holder: Address) => {
        const key = `${token}:${holder}`.toLowerCase()
        if (!balanceCache.has(key)) balanceCache.set(key, await probe.balanceOf(token, holder))
        return balanceCache.get(key)
    }

    for (const entry of input.accessList) {
        const token = entry.address
        // Only ERC20-like contracts hold balances a donation could raise.
        if ((await currentBalance(token, holders[0])) === undefined) continue
        let foundForToken = false

        for (const slot of entry.storageKeys) {
            if (foundForToken) break
            if (slotsTested >= MAX_SLOTS) {
                slotsSkipped++
                continue
            }
            const value = await probe.storage(token, slot)
            if (value === undefined || value >= MAX_PLAUSIBLE_BALANCE) continue
            slotsTested++

            const raised = value + (value > 0n ? value / 2n + 1n : ONE)
            const override: StateOverride = [
                { address: token, stateDiff: [{ slot, value: numberToHex(raised, { size: 32 }) }] },
            ]
            const donatedRate = await probe.rate(override)
            if (donatedRate === undefined || donatedRate === baseRate) continue

            // The rate depends on this slot. It is a donation vector only if the slot is a holder's balance.
            // A transfer never changes totalSupply, so a slot that does (e.g. a rebasing token's total
            // pooled amount, which moves every balance) is global state, not a balance.
            const supplyBefore = await probe.totalSupply(token)
            if (supplyBefore !== undefined && (await probe.totalSupply(token, override)) !== supplyBefore) continue
            for (const holder of holders) {
                const before = await currentBalance(token, holder)
                if (before === undefined) continue
                const after = await probe.balanceOf(token, holder, override)
                if (after !== undefined && after !== before) {
                    finding({ kind: 'token', token, holder, donatedRate })
                    foundForToken = true
                    break
                }
            }
        }
    }

    // Native balances, e.g. `address(this).balance`.
    for (const holder of holders) {
        const balance = await probe.nativeBalance(holder)
        const raised = balance + (balance > 0n ? balance / 2n + 1n : ONE)
        const donatedRate = await probe.rate([{ address: holder, balance: raised }])
        if (donatedRate !== undefined && donatedRate !== baseRate) finding({ kind: 'native', holder, donatedRate })
    }

    return { findings, slotsTested, slotsSkipped }
}

export async function checkDonationForCallchain(
    client: Client,
    callchain: Callchain,
    accessList: readonly { address: Address; storageKeys: readonly Hex[] }[],
): Promise<DonationCheckResult> {
    return checkDonation(clientDonationProbe(client, callchain.target), {
        holders: [callchain.target, ...callchain.accessListAddresses],
        accessList,
    })
}

function dedupe(addresses: Address[]): Address[] {
    const out: Address[] = []
    for (const a of addresses) if (!out.some((o) => sameAddress(o, a))) out.push(a)
    return out
}
