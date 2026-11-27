import {
    AbiDecodingDataSizeInvalidError,
    AbiDecodingDataSizeTooSmallError,
    AbiDecodingZeroDataError,
    Address,
    BaseError,
    ContractFunctionRevertedError,
    ContractFunctionZeroDataError,
    ExecutionRevertedError,
    Hex,
    RawContractError,
    RpcError,
    RpcRequestError,
    StateOverride,
    erc20Abi,
    getAddress,
    numberToHex,
    parseAbi,
} from 'viem'
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
    code?(address: Address): Promise<Hex | undefined>
}

export interface DonationInput {
    /** Contracts whose balance a donation could raise (the target and every call-path contract). */
    holders: Address[]
    /** The access list of the `getRate` call. */
    accessList: readonly { address: Address; storageKeys: readonly Hex[] }[]
}

/** Bounds RPC load on providers with large call paths. */
const MAX_SLOTS = 150
const MAX_EXTRA_HOLDERS = 40
const ONE = 10n ** 18n
const LOW_128_MASK = (1n << 128n) - 1n
/** Plain balances sit well below 2^128; larger values are packed words (e.g. Aave v3 UserState). */
const MAX_UNPACKED_BALANCE = 2n ** 128n
const MIN_ADDRESS_VALUE = 2n ** 100n
const ADDRESS_MASK = (1n << 160n) - 1n

/** Extracts candidate 20-byte addresses pushed via `PUSH20` (e.g. Solidity immutables). */
export function extractPush20Addresses(bytecode: Hex): Address[] {
    const hex = bytecode.startsWith('0x') ? bytecode.slice(2) : bytecode
    const len = Math.floor(hex.length / 2)
    const out: Address[] = []
    let i = 0
    while (i < len) {
        const opcode = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
        if (opcode === 0x73 && i + 21 <= len) {
            const addrHex = hex.slice((i + 1) * 2, (i + 21) * 2)
            const val = BigInt(`0x${addrHex}`)
            if (val >= MIN_ADDRESS_VALUE && val < ADDRESS_MASK) {
                out.push(getAddress(`0x${addrHex}`))
            }
        }
        // Skip PUSH1 (0x60)..PUSH32 (0x7f) immediate data bytes so data isn't read as opcodes.
        if (opcode >= 0x60 && opcode <= 0x7f) {
            i += 1 + (opcode - 0x5f)
        } else {
            i += 1
        }
    }
    return dedupe(out)
}

/**
 * Computes an increased slot value to simulate a donation.
 * For packed words >= 2^128 (such as Aave v3 UserState { uint128 balance; uint128 additionalData }),
 * only the lower 128-bit field is raised while keeping the upper 128 bits intact.
 */
export function raiseSlotValue(value: bigint): bigint | undefined {
    if (value < MAX_UNPACKED_BALANCE) {
        return value + (value > 0n ? value / 2n + 1n : ONE)
    }
    const low = value & LOW_128_MASK
    const high = value >> 128n
    const delta = low > 0n ? low / 2n + 1n : ONE
    if (low + delta > LOW_128_MASK) return undefined
    return (high << 128n) | (low + delta)
}

const rateAbi = parseAbi(['function getRate() view returns (uint256)'])
const REVERT_HINT = /revert|invalid opcode|out of gas|panic|overflow|underflow/i

/**
 * True when a probe call failed due to RPC / state-override incompatibility rather than
 * a contract revert or ABI mismatch.
 */
export function isDonationRpcError(error: unknown): boolean {
    if (isTransportError(error)) return true
    if (!(error instanceof BaseError)) return false

    const isContractFailure = !!error.walk(
        (e) =>
            e instanceof ContractFunctionRevertedError ||
            e instanceof ExecutionRevertedError ||
            e instanceof RawContractError ||
            e instanceof ContractFunctionZeroDataError ||
            e instanceof AbiDecodingZeroDataError ||
            e instanceof AbiDecodingDataSizeTooSmallError ||
            e instanceof AbiDecodingDataSizeInvalidError,
    )
    if (isContractFailure) return false

    return !!error.walk(
        (e) =>
            (e instanceof RpcError || e instanceof RpcRequestError) &&
            !REVERT_HINT.test(`${e.message} ${e.details ?? ''}`),
    )
}

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
                if (isDonationRpcError(error)) throw error
                return undefined
            }
        },
        storage: async (address, slot) => {
            try {
                const value = await client.getStorageAt({ address, slot })
                return value ? BigInt(value) : 0n
            } catch (error) {
                if (isDonationRpcError(error)) throw error
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
                if (isDonationRpcError(error)) throw error
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
                if (isDonationRpcError(error)) throw error
                return undefined
            }
        },
        code: async (address) => {
            try {
                return await client.getCode({ address })
            } catch (error) {
                if (isDonationRpcError(error)) throw error
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
    let overrideAttempts = 0
    let overrideUndefined = 0
    const balanceCache = new Map<string, bigint | undefined>()
    const currentBalance = async (token: Address, holder: Address) => {
        const key = `${token}:${holder}`.toLowerCase()
        if (!balanceCache.has(key)) balanceCache.set(key, await probe.balanceOf(token, holder))
        return balanceCache.get(key)
    }

    let cachedExtraHolders: Address[] | undefined
    const extraHolders = async (): Promise<Address[]> => {
        if (cachedExtraHolders) return cachedExtraHolders
        const candidates: Address[] = []
        const seen = new Set(holders.map((h) => h.toLowerCase()))
        const pushCandidate = (addr: Address) => {
            const lower = addr.toLowerCase()
            if (seen.has(lower) || candidates.length >= MAX_EXTRA_HOLDERS) return
            seen.add(lower)
            candidates.push(addr)
        }

        for (const entry of input.accessList) {
            if (candidates.length >= MAX_EXTRA_HOLDERS) break
            for (const s of entry.storageKeys) {
                if (candidates.length >= MAX_EXTRA_HOLDERS) break
                const v = await probe.storage(entry.address, s)
                if (v !== undefined && v >= MIN_ADDRESS_VALUE && v < ADDRESS_MASK) {
                    pushCandidate(getAddress(`0x${v.toString(16).padStart(40, '0')}`))
                }
            }
        }

        if (probe.code) {
            for (const h of holders) {
                if (candidates.length >= MAX_EXTRA_HOLDERS) break
                const bytecode = await probe.code(h)
                if (!bytecode || bytecode === '0x') continue
                for (const addr of extractPush20Addresses(bytecode)) pushCandidate(addr)
            }
        }

        cachedExtraHolders = candidates
        return candidates
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
            if (value === undefined) continue
            const raised = raiseSlotValue(value)
            if (raised === undefined) continue
            slotsTested++

            const override: StateOverride = [
                { address: token, stateDiff: [{ slot, value: numberToHex(raised, { size: 32 }) }] },
            ]
            overrideAttempts++
            const donatedRate = await probe.rate(override)
            if (donatedRate === undefined) {
                overrideUndefined++
                continue
            }
            if (donatedRate === baseRate) continue

            // The rate depends on this slot. It is a donation vector only if the slot is a holder's balance.
            // A transfer never changes totalSupply, so a slot that does (e.g. a rebasing token's total
            // pooled amount, which moves every balance) is global state, not a balance.
            const supplyBefore = await probe.totalSupply(token)
            if (supplyBefore !== undefined && (await probe.totalSupply(token, override)) !== supplyBefore) continue
            const matchHolderBalance = async (candidateHolders: Address[]): Promise<boolean> => {
                for (const holder of candidateHolders) {
                    const before = await currentBalance(token, holder)
                    if (before === undefined) continue
                    const after = await probe.balanceOf(token, holder, override)
                    if (after !== undefined && after !== before) {
                        finding({ kind: 'token', token, holder, donatedRate })
                        foundForToken = true
                        return true
                    }
                }
                return false
            }

            if (!(await matchHolderBalance(holders))) {
                await matchHolderBalance(await extraHolders())
            }
        }
    }

    // Native balances, e.g. `address(this).balance`.
    for (const holder of holders) {
        const balance = await probe.nativeBalance(holder)
        const raised = balance + (balance > 0n ? balance / 2n + 1n : ONE)
        overrideAttempts++
        const donatedRate = await probe.rate([{ address: holder, balance: raised }])
        if (donatedRate === undefined) {
            overrideUndefined++
            continue
        }
        if (donatedRate !== baseRate) finding({ kind: 'native', holder, donatedRate })
    }

    if (overrideAttempts > 0 && overrideUndefined === overrideAttempts) {
        throw new Error('all state-override getRate calls failed; RPC may not support stateOverride')
    }

    return { findings, slotsTested, slotsSkipped }
}

export async function checkDonationForCallchain(
    client: Client,
    callchain: Callchain,
    accessList: readonly { address: Address; storageKeys: readonly Hex[] }[],
    asset?: Address,
): Promise<DonationCheckResult> {
    return checkDonation(clientDonationProbe(client, callchain.target), {
        holders: [
            callchain.target,
            ...(asset ? [asset] : []),
            ...callchain.accessListAddresses,
            ...accessList.map((a) => a.address),
        ],
        accessList,
    })
}

function dedupe(addresses: Address[]): Address[] {
    const out: Address[] = []
    for (const a of addresses) if (!out.some((o) => sameAddress(o, a))) out.push(a)
    return out
}
