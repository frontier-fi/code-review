import { Address, Hex, StateOverride, numberToHex } from 'viem'
import { mainnet } from 'viem/chains'
import { checkDonation, DonationProbe } from '../../src/checks/donation'
import { AdminCheckResult, singleKeyUpgradeable } from '../../src/checks/admin'
import { hasDonationRisk, hasEoaUpgradeable, renderSecurityChecks, SecurityCheckResults } from '../../src/checks'

const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address
const slot = (n: number) => numberToHex(n, { size: 32 }) as Hex
const ONE = 10n ** 18n

const VAULT = a(1)
const TOKEN = a(10)
const BALANCE_SLOT = slot(1) // TOKEN.balances[VAULT]
const PRICE_SLOT = slot(2) // some TOKEN state that is not a balance
const SUPPLY_SLOT = slot(3) // VAULT.totalSupply

/**
 * A tiny chain model: storage per contract, native balances, and a getRate formula.
 * State overrides are applied on top of it for the duration of one call.
 */
function fakeChain(rate: (read: (address: Address, s: Hex) => bigint, native: (h: Address) => bigint) => bigint) {
    const storage: Record<string, bigint> = {
        [`${TOKEN}:${BALANCE_SLOT}`]: 100n * ONE,
        [`${TOKEN}:${PRICE_SLOT}`]: 2n * ONE,
        [`${VAULT}:${SUPPLY_SLOT}`]: 100n * ONE,
    }
    const natives: Record<string, bigint> = { [VAULT]: 50n * ONE }

    const view = (override?: StateOverride) => {
        const read = (address: Address, s: Hex) => {
            const o = override?.find((x) => x.address === address)?.stateDiff?.find((d) => d.slot === s)
            return o ? BigInt(o.value) : storage[`${address}:${s}`] ?? 0n
        }
        const native = (h: Address) => override?.find((x) => x.address === h)?.balance ?? natives[h] ?? 0n
        return { read, native }
    }

    const probe: DonationProbe = {
        rate: async (override) => {
            const v = view(override)
            return rate(v.read, v.native)
        },
        storage: async (address, s) => storage[`${address}:${s}`] ?? 0n,
        nativeBalance: async (h) => natives[h] ?? 0n,
        balanceOf: async (token, holder, override) => {
            if (token !== TOKEN) return undefined // not an ERC20
            return holder === VAULT ? view(override).read(TOKEN, BALANCE_SLOT) : 0n
        },
        // a rebasing-style token: the price slot scales every balance and the supply
        totalSupply: async (token, override) =>
            token === TOKEN ? (1000n * view(override).read(TOKEN, PRICE_SLOT)) / 2n : undefined,
    }
    return probe
}

const accessList = [
    { address: TOKEN, storageKeys: [PRICE_SLOT, BALANCE_SLOT] },
    { address: VAULT, storageKeys: [SUPPLY_SLOT] },
]

describe('donation check', () => {
    it('flags a rate computed from the vault token balance', async () => {
        const probe = fakeChain((read) => (read(TOKEN, BALANCE_SLOT) * ONE) / read(VAULT, SUPPLY_SLOT))
        const r = await checkDonation(probe, { holders: [VAULT, TOKEN], accessList })
        expect(r.findings).toHaveLength(1)
        expect(r.findings[0]).toMatchObject({ kind: 'token', token: TOKEN, holder: VAULT, baseRate: ONE })
        expect(r.findings[0].donatedRate).toBeGreaterThan(ONE)
    })

    it('does not flag state that moves the rate but is not a balance', async () => {
        // the rate depends on TOKEN's price slot and VAULT's own supply, neither of which a transfer changes
        const probe = fakeChain((read) => (read(TOKEN, PRICE_SLOT) * ONE) / read(VAULT, SUPPLY_SLOT))
        const r = await checkDonation(probe, { holders: [VAULT, TOKEN], accessList })
        expect(r.findings).toHaveLength(0)
        expect(r.slotsTested).toBeGreaterThan(0)
    })

    it('does not treat a global slot that moves every balance as a donation', async () => {
        const probe = fakeChain((read) => (read(TOKEN, PRICE_SLOT) * ONE) / read(VAULT, SUPPLY_SLOT))
        // every balance scales with the price slot, like stETH's total pooled ether
        probe.balanceOf = async (token, holder, override) => {
            if (token !== TOKEN) return undefined
            const price = BigInt(override?.[0]?.stateDiff?.find((d) => d.slot === PRICE_SLOT)?.value ?? 2n * ONE)
            return holder === VAULT ? (100n * price) / 2n : 0n
        }
        const r = await checkDonation(probe, { holders: [VAULT, TOKEN], accessList })
        expect(r.findings).toHaveLength(0)
    })

    it('flags a rate computed from the native balance', async () => {
        const probe = fakeChain((read, native) => (native(VAULT) * ONE) / read(VAULT, SUPPLY_SLOT))
        const r = await checkDonation(probe, { holders: [VAULT], accessList })
        expect(r.findings).toEqual([expect.objectContaining({ kind: 'native', holder: VAULT })])
    })

    it('fails the check when getRate cannot be called', async () => {
        const probe = fakeChain(() => ONE)
        probe.rate = async () => undefined
        await expect(checkDonation(probe, { holders: [VAULT], accessList })).rejects.toThrow('getRate')
    })
})

function adminWith(contract: AdminCheckResult['contracts'][number]): AdminCheckResult {
    return { contracts: [contract], highestRisk: 'High' }
}

describe('single-key upgradeability', () => {
    const base = { address: a(1), name: 'Proxy', privilegedFunctions: [], notes: [] }

    it('flags a proxy admin that is an EOA or sits behind a 1-of-n Safe', () => {
        expect(
            singleKeyUpgradeable(
                adminWith({
                    ...base,
                    isProxy: true,
                    roles: [
                        { role: 'Proxy admin (EIP-1967)', controller: { address: a(2), kind: 'EOA' }, risk: 'High' },
                    ],
                }),
            ),
        ).toHaveLength(1)
        expect(
            singleKeyUpgradeable(
                adminWith({
                    ...base,
                    isProxy: true,
                    roles: [
                        {
                            role: 'Proxy admin (EIP-1967)',
                            controller: {
                                address: a(2),
                                kind: 'Contract',
                                ownedBy: { address: a(3), kind: 'Safe', threshold: 1 },
                            },
                            risk: 'High',
                        },
                    ],
                }),
            ),
        ).toHaveLength(1)
    })

    it('ignores a multisig proxy admin even if an EOA owns other roles', () => {
        expect(
            singleKeyUpgradeable(
                adminWith({
                    ...base,
                    isProxy: true,
                    roles: [
                        {
                            role: 'Proxy admin (EIP-1967)',
                            controller: { address: a(2), kind: 'Safe', threshold: 3 },
                            risk: 'Medium',
                        },
                        { role: 'Owner', controller: { address: a(4), kind: 'EOA' }, risk: 'High' },
                    ],
                }),
            ),
        ).toHaveLength(0)
    })

    it('uses the owner of a proxy without an admin slot (UUPS), but not of a plain contract', () => {
        const owner = [{ role: 'Owner', controller: { address: a(4), kind: 'EOA' as const }, risk: 'High' as const }]
        expect(singleKeyUpgradeable(adminWith({ ...base, isProxy: true, roles: owner }))).toHaveLength(1)
        expect(singleKeyUpgradeable(adminWith({ ...base, isProxy: false, roles: owner }))).toHaveLength(0)
    })
})

describe('close-review flags in the report', () => {
    function results(): SecurityCheckResults {
        return {
            admin: {
                ok: true,
                value: adminWith({
                    address: a(1),
                    name: 'Proxy',
                    isProxy: true,
                    privilegedFunctions: [],
                    notes: [],
                    roles: [
                        { role: 'Proxy admin (EIP-1967)', controller: { address: a(2), kind: 'EOA' }, risk: 'High' },
                    ],
                }),
            },
            oracle: { ok: true, value: { feeds: [], l2RequiresSequencerCheck: false } },
            spot: {
                ok: true,
                value: {
                    pools: [],
                    twapUsageFound: false,
                    balancerReentrancyGuardFound: false,
                    curveReentrancyGuardFound: false,
                },
            },
            hygiene: { ok: true, value: { unverified: [] } },
            tokens: [],
            donation: {
                ok: true,
                value: {
                    findings: [
                        {
                            kind: 'token',
                            token: TOKEN,
                            holder: VAULT,
                            baseRate: ONE,
                            donatedRate: (3n * ONE) / 2n,
                            changeBps: 5000,
                        },
                    ],
                    slotsTested: 3,
                    slotsSkipped: 0,
                },
            },
        }
    }

    it('detects both flags and renders them', () => {
        const r = results()
        expect(hasDonationRisk(r)).toBe(true)
        expect(hasEoaUpgradeable(r)).toBe(true)
        const md = renderSecurityChecks(mainnet, r)
        expect(md).toContain('### Donation attacks')
        expect(md).toContain('+5000 bps')
        expect(md).toContain('Upgradeable by a single key')
    })

    it('does not flag when the donation check failed or found nothing', () => {
        const r = results()
        r.donation = { ok: false, error: 'rpc down' }
        expect(hasDonationRisk(r)).toBe(false)
        expect(renderSecurityChecks(mainnet, r)).toContain('This check failed to run: rpc down')
        r.donation = { ok: true, value: { findings: [], slotsTested: 4, slotsSkipped: 0 } }
        expect(hasDonationRisk(r)).toBe(false)
    })
})
