import { Address, BaseError, HttpRequestError, zeroAddress } from 'viem'
import { checkAdminControl } from '../../src/checks/admin'
import { Callchain, CallchainContract } from '../../src/checks/callchain'
import { Client, isTransportError, stripComments, tryRead } from '../../src/checks/common'
import { checkSpotPrice } from '../../src/checks/spotPrice'
import { checkTokenRisks } from '../../src/checks/token'

// Regression tests for the findings of the independent audit of src/checks.

const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address
const revert = () => {
    throw new Error('execution reverted')
}

type Reads = Record<string, (args: readonly unknown[]) => unknown>

/** A client whose reads are answered per address and function name; anything else reverts. */
function stubClient(reads: Record<string, Reads>, code: Record<string, string> = {}): Client {
    return {
        readContract: async ({ address, functionName, args }: any) => {
            const fn = reads[address.toLowerCase()]?.[functionName]
            return fn ? fn(args ?? []) : revert()
        },
        getStorageAt: async () => `0x${'0'.repeat(64)}`,
        getCode: async ({ address }: any) => code[address.toLowerCase()] ?? '0x',
    } as unknown as Client
}

function contract(address: Address, sources: string[] = [], name = 'C'): CallchainContract {
    return { address, name, verified: true, isProxy: false, abi: [], sources }
}

function callchain(contracts: CallchainContract[]): Callchain {
    return { target: contracts[0].address, contracts, accessListAddresses: contracts.map((c) => c.address) }
}

describe('finding 1: every DEFAULT_ADMIN_ROLE holder is ranked', () => {
    it('reports High when a non-first role member is an EOA', async () => {
        const target = a(1)
        const timelock = a(2)
        const eoa = a(3)
        const client = stubClient(
            {
                [target]: {
                    getRoleMemberCount: () => 2n,
                    getRoleMember: ([, i]) => ((i as bigint) === 0n ? timelock : eoa),
                },
                [timelock]: { getMinDelay: () => 2n * 86400n },
            },
            { [timelock]: '0x6080' },
        )
        const result = await checkAdminControl(client, callchain([contract(target)]))
        const roles = result.contracts[0].roles
        expect(roles.map((r) => r.risk)).toEqual(['Low', 'High'])
        expect(roles[1].role).toBe('DEFAULT_ADMIN_ROLE holder (2 of 2)')
        expect(result.highestRisk).toBe('High')
    })
})

describe('finding 2: TWAP detection ignores pool sources and declarations', () => {
    const pool = a(10)
    const reader = a(11)
    const poolReads: Reads = { token0: () => a(99), slot0: () => [1n, 0] }

    it('does not count the pool defining observe()', async () => {
        const client = stubClient({ [pool]: poolReads })
        const result = await checkSpotPrice(
            client,
            callchain([
                contract(reader, [
                    'interface IPool { function observe(uint32[] calldata s) external view; }\n' +
                        'function rate() view { (uint160 p,) = pool.slot0(); } // TODO: use a twap()',
                ]),
                contract(pool, ['function observe(uint32[] calldata s) { oracle.observe(s); }']),
            ]),
        )
        expect(result.pools.map((p) => p.kind)).toEqual(['Uniswap V3-style'])
        expect(result.twapUsageFound).toBe(false)
    })

    it('still finds a reader that calls observe()', async () => {
        const client = stubClient({ [pool]: poolReads })
        const result = await checkSpotPrice(
            client,
            callchain([
                contract(reader, ['(int56[] memory ticks,) = IUniswapV3Pool(pool).observe(secondsAgos);']),
                contract(pool),
            ]),
        )
        expect(result.twapUsageFound).toBe(true)
    })

    it('strips comments, including in JSON-wrapped source', () => {
        expect(stripComments('a // twap()\\nb /* consult() */ c')).not.toMatch(/twap|consult/)
    })
})

describe('finding 3: a proxy token with no implementation ABI is not reported clean', () => {
    it('marks the token as unchecked', async () => {
        const token = a(20)
        const impl = a(21)
        const service = {
            getContractInfo: async (addresses: Address[]) =>
                addresses[0] === token
                    ? [{ address: token, Proxy: '1', Implementation: impl, ContractName: 'Proxy', ABI: '[]' }]
                    : [],
        } as any
        const result = await checkTokenRisks(stubClient({ [token]: { symbol: () => 'TKN' } }), service, token)
        expect(result.abiChecked).toBe(false)
        expect(result.abiUnavailableReason).toContain('unverified')
    })
})

describe('finding 4: RPC failures are not treated as "not detected"', () => {
    const httpError = (status: number, details: string) =>
        new HttpRequestError({ url: 'https://rpc.example', status, details, body: {} })

    it('classifies transport errors', () => {
        expect(isTransportError(httpError(429, 'Too Many Requests'))).toBe(true)
        expect(isTransportError(new BaseError('wrapped', { cause: httpError(503, 'Service Unavailable') }))).toBe(true)
        expect(isTransportError(httpError(500, '{"code":3,"message":"execution reverted"}'))).toBe(false)
        expect(isTransportError(new Error('execution reverted'))).toBe(false)
    })

    it('tryRead rethrows transport errors and swallows reverts', async () => {
        const failing = {
            readContract: async () => {
                throw httpError(429, 'Too Many Requests')
            },
        } as unknown as Client
        await expect(tryRead(failing, zeroAddress, [], 'latestRoundData')).rejects.toThrow()
        expect(await tryRead(stubClient({}), zeroAddress, [], 'latestRoundData')).toBeUndefined()
    })
})
