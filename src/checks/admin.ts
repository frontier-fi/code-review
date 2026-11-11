import { Address, Hex, parseAbi, zeroAddress, hexToBigInt, getAddress } from 'viem'
import { Callchain } from './callchain'
import { Client, formatDuration, stateChangingFunctionNames, tryRead, unique } from './common'

/**
 * Check 1: who can change the price.
 *
 * For every contract in the call path, find the accounts that control it (proxy admin,
 * beacon owner, owner, governance, DEFAULT_ADMIN_ROLE holder), work out what those
 * accounts are (EOA, Safe, timelock), and list functions that look like admin actions.
 */

const EIP1967_ADMIN_SLOT = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103'
const EIP1967_BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50'
const DEFAULT_ADMIN_ROLE = '0x0000000000000000000000000000000000000000000000000000000000000000'

const probeAbi = parseAbi([
    'function owner() view returns (address)',
    'function admin() view returns (address)',
    'function governance() view returns (address)',
    'function getRoleMember(bytes32 role, uint256 index) view returns (address)',
    'function getThreshold() view returns (uint256)',
    'function getOwners() view returns (address[])',
    'function getMinDelay() view returns (uint256)',
])

// Function names that usually indicate a privileged action on price-relevant state.
const PRIVILEGED_FUNCTION =
    /^(set|update|change|config|pause|unpause|upgrade|grantRole|revokeRole|transferOwnership|acceptOwnership|renounce|emergency|freeze|unfreeze|shutdown|sweep|rescue|migrate|initialize|reinitialize|kill|withdrawAll|skim)/i

// Per-user actions (e.g. Aave's setUserEMode) share admin-like prefixes but are not privileged.
const USER_FUNCTION = /User|OnBehalfOf|ForUser|Self$/

export type ControllerKind = 'EOA' | 'Safe' | 'Timelock' | 'Contract'
export type Risk = 'High' | 'Medium' | 'Low' | 'Unknown'

export interface Controller {
    address: Address
    kind: ControllerKind
    /** Human-readable detail, e.g. "3/5 signers" or "2.0d delay" */
    detail?: string
    /** Safe signing threshold */
    threshold?: number
    /** Timelock minimum delay */
    delaySeconds?: number
    /** When this contract is itself owned by another account (e.g. a ProxyAdmin owned by a Safe). */
    ownedBy?: Controller
}

export interface ControlRole {
    role: string
    controller: Controller
    risk: Risk
}

export interface ContractControl {
    address: Address
    name: string
    roles: ControlRole[]
    privilegedFunctions: string[]
}

export interface AdminCheckResult {
    contracts: ContractControl[]
    highestRisk: Risk | 'None'
}

export async function checkAdminControl(client: Client, callchain: Callchain): Promise<AdminCheckResult> {
    // Completed classifications only. Unresolved promises are never shared, so an ownership
    // cycle (A owned by B, B owned by A) cannot make a lookup wait on itself.
    const cache = new Map<string, Controller>()
    const classify = async (address: Address, path: string[] = []): Promise<Controller> => {
        const key = address.toLowerCase()
        const cached = cache.get(key)
        if (cached) return cached
        if (path.includes(key) || path.length >= 3) {
            return { address, kind: 'Contract', detail: path.includes(key) ? 'circular ownership' : undefined }
        }
        const result = await classifyController(client, address, (owner) => classify(owner, [...path, key]))
        cache.set(key, result)
        return result
    }

    const contracts: ContractControl[] = []
    for (const contract of callchain.contracts) {
        const roles: { role: string; address: Address }[] = []

        const adminFromSlot = await readAddressSlot(client, contract.address, EIP1967_ADMIN_SLOT)
        if (adminFromSlot) roles.push({ role: 'Proxy admin (EIP-1967)', address: adminFromSlot })

        const beacon = await readAddressSlot(client, contract.address, EIP1967_BEACON_SLOT)
        if (beacon) {
            const beaconOwner = await tryRead<Address>(client, beacon, probeAbi, 'owner')
            if (beaconOwner && beaconOwner !== zeroAddress) roles.push({ role: 'Beacon owner', address: beaconOwner })
        }

        const owner = await tryRead<Address>(client, contract.address, probeAbi, 'owner')
        if (owner && owner !== zeroAddress) roles.push({ role: 'Owner', address: owner })

        // admin() on a transparent proxy is routed differently depending on the caller; the slot read covers proxies.
        if (!contract.isProxy) {
            const admin = await tryRead<Address>(client, contract.address, probeAbi, 'admin')
            if (admin && admin !== zeroAddress) roles.push({ role: 'Admin', address: admin })
        }

        const governance = await tryRead<Address>(client, contract.address, probeAbi, 'governance')
        if (governance && governance !== zeroAddress) roles.push({ role: 'Governance', address: governance })

        const roleAdmin = await tryRead<Address>(client, contract.address, probeAbi, 'getRoleMember', [
            DEFAULT_ADMIN_ROLE,
            0n,
        ])
        if (roleAdmin && roleAdmin !== zeroAddress)
            roles.push({ role: 'DEFAULT_ADMIN_ROLE holder', address: roleAdmin })

        const resolved: ControlRole[] = []
        for (const r of dedupeRoles(roles)) {
            const controller = await classify(r.address)
            resolved.push({ role: r.role, controller, risk: riskOf(controller) })
        }

        contracts.push({
            address: contract.address,
            name: contract.name,
            roles: resolved,
            privilegedFunctions: unique(stateChangingFunctionNames(contract.abi)).filter(
                (n) => PRIVILEGED_FUNCTION.test(n) && !USER_FUNCTION.test(n),
            ),
        })
    }

    const risks = contracts.flatMap((c) => c.roles.map((r) => r.risk))
    const order: Risk[] = ['High', 'Unknown', 'Medium', 'Low']
    const highestRisk = order.find((r) => risks.includes(r)) ?? 'None'

    return { contracts, highestRisk }
}

async function classifyController(
    client: Client,
    address: Address,
    classifyOwner: (owner: Address) => Promise<Controller>,
): Promise<Controller> {
    let code: Hex | undefined
    try {
        code = await client.getCode({ address })
    } catch {
        // don't report an RPC failure as an EOA
        return { address, kind: 'Contract', detail: 'lookup failed' }
    }
    // No code, or an EIP-7702 delegation designator, means a key holder controls it directly.
    if (!code || code === '0x' || code.toLowerCase().startsWith('0xef0100')) {
        return { address, kind: 'EOA', detail: code && code !== '0x' ? 'EIP-7702 delegated' : undefined }
    }

    const threshold = await tryRead<bigint>(client, address, probeAbi, 'getThreshold')
    const owners = await tryRead<Address[]>(client, address, probeAbi, 'getOwners')
    if (threshold !== undefined && owners !== undefined) {
        return {
            address,
            kind: 'Safe',
            threshold: Number(threshold),
            detail: `${threshold}/${owners.length} signers`,
        }
    }

    const minDelay = await tryRead<bigint>(client, address, probeAbi, 'getMinDelay')
    if (minDelay !== undefined) {
        return {
            address,
            kind: 'Timelock',
            delaySeconds: Number(minDelay),
            detail: `${formatDuration(Number(minDelay))} delay`,
        }
    }

    // e.g. an OpenZeppelin ProxyAdmin: follow its owner so the report shows who really controls it.
    const owner = await tryRead<Address>(client, address, probeAbi, 'owner')
    if (owner && owner !== zeroAddress && owner.toLowerCase() !== address.toLowerCase()) {
        return { address, kind: 'Contract', ownedBy: await classifyOwner(owner) }
    }

    return { address, kind: 'Contract' }
}

/** Risk of the account that ultimately controls a role. */
export function riskOf(controller: Controller): Risk {
    const ultimate = ultimateController(controller)
    switch (ultimate.kind) {
        case 'EOA':
            return 'High'
        case 'Safe':
            return (ultimate.threshold ?? 0) <= 1 ? 'High' : 'Medium'
        case 'Timelock':
            // a timelock without a meaningful delay gives users no time to exit
            return (ultimate.delaySeconds ?? 0) < 86400 ? 'Medium' : 'Low'
        default:
            return 'Unknown'
    }
}

export function ultimateController(controller: Controller): Controller {
    return controller.ownedBy ? ultimateController(controller.ownedBy) : controller
}

async function readAddressSlot(client: Client, address: Address, slot: Hex): Promise<Address | undefined> {
    try {
        const value = await client.getStorageAt({ address, slot })
        if (!value || hexToBigInt(value) === 0n) return undefined
        return getAddress(`0x${value.slice(-40)}`)
    } catch {
        return undefined
    }
}

function dedupeRoles(roles: { role: string; address: Address }[]) {
    const out: { role: string; address: Address }[] = []
    for (const r of roles) {
        const existing = out.find((o) => o.address.toLowerCase() === r.address.toLowerCase())
        if (existing) existing.role = `${existing.role}, ${r.role}`
        else out.push({ ...r })
    }
    return out
}
