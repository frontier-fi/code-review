import { Address } from 'viem'
import { mainnet } from 'viem/chains'
import { riskOf } from '../../src/checks/admin'
import { diffBps } from '../../src/checks/common'
import { hasOracle, hasUnverifiedContracts, renderSecurityChecks, SecurityCheckResults } from '../../src/checks'

const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address

function baseResults(): SecurityCheckResults {
    return {
        admin: { ok: true, value: { contracts: [], highestRisk: 'None' } },
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
    }
}

describe('admin risk ranking', () => {
    it('ranks the account that ultimately controls a role', () => {
        expect(riskOf({ address: a(1), kind: 'EOA' })).toBe('High')
        expect(riskOf({ address: a(1), kind: 'Safe', threshold: 1 })).toBe('High')
        expect(riskOf({ address: a(1), kind: 'Safe', threshold: 3 })).toBe('Medium')
        expect(riskOf({ address: a(1), kind: 'Timelock', delaySeconds: 3600 })).toBe('Medium')
        expect(riskOf({ address: a(1), kind: 'Timelock', delaySeconds: 2 * 86400 })).toBe('Low')
        expect(riskOf({ address: a(1), kind: 'Contract' })).toBe('Unknown')
        // a ProxyAdmin owned by an EOA is as risky as the EOA
        expect(riskOf({ address: a(1), kind: 'Contract', ownedBy: { address: a(2), kind: 'EOA' } })).toBe('High')
    })
})

describe('verdict helpers', () => {
    it('flags unverified contracts and detected oracles', () => {
        const r = baseResults()
        expect(hasUnverifiedContracts(r)).toBe(false)
        expect(hasOracle(r)).toBe(false)

        r.hygiene = { ok: true, value: { unverified: [{ address: a(5), implementationOnly: false }] } }
        r.oracle = {
            ok: true,
            value: {
                feeds: [{ address: a(6), name: 'Feed', type: 'Chainlink-compatible' }],
                l2RequiresSequencerCheck: false,
            },
        }
        expect(hasUnverifiedContracts(r)).toBe(true)
        expect(hasOracle(r)).toBe(true)
    })

    it('does not fail the review when a check itself errored', () => {
        const r = baseResults()
        r.hygiene = { ok: false, error: 'rpc down' }
        expect(hasUnverifiedContracts(r)).toBe(false)
    })
})

describe('report rendering', () => {
    it('renders failures and findings', () => {
        const r = baseResults()
        r.spot = { ok: false, error: 'rpc down' }
        r.hygiene = { ok: true, value: { unverified: [{ address: a(5), implementationOnly: false }] } }
        const md = renderSecurityChecks(mainnet, r)
        expect(md).toContain('## Automated Security Checks')
        expect(md).toContain('This check failed to run: rpc down')
        expect(md).toContain('UNUSABLE until they are verified')
    })

    it('says so when the checks could not run at all', () => {
        expect(renderSecurityChecks(mainnet, undefined, 'no access list')).toContain('could not run: no access list')
    })
})

describe('diffBps', () => {
    it('computes the absolute difference in basis points', () => {
        expect(diffBps(1010n, 1000n)).toBe(100)
        expect(diffBps(990n, 1000n)).toBe(100)
        expect(diffBps(1n, 0n)).toBeUndefined()
    })
})
