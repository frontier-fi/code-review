import { Chain, formatUnits } from 'viem'
import type { Outcome, SecurityCheckResults } from './index'
import { AdminCheckResult, Controller } from './admin'
import { OracleCheckResult } from './oracle'
import { SpotPriceCheckResult } from './spotPrice'
import { HygieneCheckResult } from './hygiene'
import { TokenRiskResult } from './token'
import { Erc4626LiquidityResult, isUnlimited } from './erc4626Liquidity'
import { explorerLink, formatDuration } from './common'

/**
 * Renders the automated security checks as a markdown section for the review report.
 * `results` is undefined when the checks could not run at all.
 */
export function renderSecurityChecks(
    chain: Chain,
    results: SecurityCheckResults | undefined,
    failure?: string,
): string {
    const intro = [
        '## Automated Security Checks',
        'These checks run automatically and rely on heuristics. A finding means "look here"; no finding is not proof of safety.',
        '',
    ]
    if (!results) {
        return [...intro, `The automated checks could not run: ${failure ?? 'unknown error'}`, ''].join('\n')
    }

    const link = (a: string) => explorerLink(chain, a)
    const sections = [
        section('Administrative control', results.admin, (r) => renderAdmin(r, link)),
        section('Oracles', results.oracle, (r) => renderOracle(r, link)),
        section('Spot prices and read-only reentrancy', results.spot, (r) => renderSpot(r, link)),
        section('Contract hygiene', results.hygiene, (r) => renderHygiene(r, link)),
    ]
    if (results.liquidity) {
        sections.push(section('ERC4626 liquidity and fees', results.liquidity, (r) => renderLiquidity(r, link)))
    }
    if (results.tokens.length > 0) {
        sections.push(
            [
                '### Token risks',
                ...results.tokens.map((t) => (t.ok ? renderToken(t.value, link) : failed(t.error))),
            ].join('\n'),
        )
    }

    return [...intro, sections.join('\n\n'), ''].join('\n')
}

function section<T>(title: string, outcome: Outcome<T>, render: (value: T) => string): string {
    return [`### ${title}`, outcome.ok ? render(outcome.value) : failed(outcome.error)].join('\n')
}

function failed(error: string): string {
    return `- ⚠️ This check failed to run: ${error}`
}

type Link = (address: string) => string

function describeController(c: Controller, link: Link): string {
    const self = `${c.kind}${c.detail ? ` (${c.detail})` : ''} ${link(c.address)}`
    return c.ownedBy ? `${self}, owned by ${describeController(c.ownedBy, link)}` : self
}

function renderAdmin(r: AdminCheckResult, link: Link): string {
    const lines: string[] = []
    const withRoles = r.contracts.filter((c) => c.roles.length > 0)

    if (withRoles.length === 0) {
        lines.push('- No owner, admin, governance or role-admin accounts were found on contracts in the call path.')
    } else {
        lines.push(
            `- **Highest risk: ${r.highestRisk}** (EOA or 1-of-n Safe = High, Safe or timelock under 24h = Medium, timelock of 24h+ = Low)`,
        )
        lines.push('')
        lines.push('| Contract | Role | Controlled by | Risk |')
        lines.push('|---|---|---|---|')
        for (const c of withRoles) {
            for (const role of c.roles) {
                lines.push(
                    `| ${c.name} ${link(c.address)} | ${role.role} | ${describeController(role.controller, link)} | ${role.risk} |`,
                )
            }
        }
    }

    for (const c of r.contracts) {
        for (const note of c.notes) lines.push(`- ⚠️ ${c.name} ${link(c.address)}: ${note}`)
    }

    const withFunctions = r.contracts.filter((c) => c.privilegedFunctions.length > 0)
    if (withFunctions.length > 0) {
        lines.push('')
        lines.push('Functions that look like admin actions (check who can call them and what they change):')
        for (const c of withFunctions) {
            const shown = c.privilegedFunctions
                .slice(0, 20)
                .map((f) => `\`${f}\``)
                .join(', ')
            const more = c.privilegedFunctions.length > 20 ? `, and ${c.privilegedFunctions.length - 20} more` : ''
            lines.push(`- ${c.name} ${link(c.address)}: ${shown}${more}`)
        }
    }
    return lines.join('\n')
}

function renderOracle(r: OracleCheckResult, link: Link): string {
    if (r.feeds.length === 0) {
        return '- No Chainlink-compatible, API3, Chronicle or Pyth feeds were found in the call path.'
    }
    const lines = [
        '- **Oracle-based price data found.** The `market-rate` warning was applied automatically.',
        '',
        '| Feed | Type | Description | Latest answer | Age |',
        '|---|---|---|---|---|',
    ]
    for (const f of r.feeds) {
        const answer =
            f.answer === undefined
                ? 'n/a'
                : f.decimals !== undefined
                  ? formatUnits(f.answer, f.decimals)
                  : f.answer.toString()
        const age =
            f.ageSeconds === undefined ? 'n/a' : `${formatDuration(f.ageSeconds)}${f.stale ? ' ⚠️ **stale**' : ''}`
        lines.push(`| ${f.name} ${link(f.address)} | ${f.type} | ${f.description ?? ''} | ${answer} | ${age} |`)
    }
    lines.push('')
    lines.push(
        `- Staleness guard in the reading contract: ${
            r.stalenessGuardFound === undefined
                ? 'unknown (source not available)'
                : r.stalenessGuardFound
                  ? 'a staleness-related pattern was found in the source; confirm it rejects old answers'
                  : '⚠️ **none found** — an old answer would be used as if current'
        }`,
    )
    if (r.l2RequiresSequencerCheck) {
        lines.push(
            `- L2 sequencer-uptime check: ${
                r.sequencerCheckFound === undefined
                    ? 'unknown (source not available)'
                    : r.sequencerCheckFound
                      ? 'found'
                      : '⚠️ **none found** — feeds may report stale prices while the sequencer is down'
            }`,
        )
    }
    return lines.join('\n')
}

function renderSpot(r: SpotPriceCheckResult, link: Link): string {
    if (r.pools.length === 0) {
        return '- No AMM pools (Uniswap, Algebra, Curve, Balancer V2) were found in the call path.'
    }
    const lines = ['| Pool | Kind | Risk |', '|---|---|---|']
    for (const p of r.pools) lines.push(`| ${p.name} ${link(p.address)} | ${p.kind} | ${p.risk} |`)
    lines.push('')
    const kinds = r.pools.map((p) => p.kind)
    if (kinds.some((k) => k.startsWith('Uniswap') || k === 'Algebra')) {
        lines.push(`- TWAP usage in source: ${r.twapUsageFound ? 'found' : '⚠️ **not found** — likely a spot read'}`)
    }
    if (kinds.includes('Balancer V2')) {
        lines.push(
            `- Balancer read-only reentrancy guard: ${r.balancerReentrancyGuardFound ? 'found' : '⚠️ **not found**'}`,
        )
    }
    if (kinds.includes('Curve')) {
        lines.push(
            `- Curve reentrancy lock check: ${r.curveReentrancyGuardFound ? 'possible pattern found' : '⚠️ **not found**'}`,
        )
    }
    return lines.join('\n')
}

function renderHygiene(r: HygieneCheckResult, link: Link): string {
    const lines: string[] = []
    if (r.unverified.length === 0) {
        lines.push('- All contracts in the call path have verified source.')
    } else {
        lines.push(
            '- ⚠️ **Unverified contracts in the call path. This makes the review UNUSABLE until they are verified:**',
        )
        for (const u of r.unverified) {
            lines.push(
                u.implementationOnly
                    ? `    - proxy ${link(u.address)}: implementation ${link(u.implementation ?? '')} is unverified`
                    : `    - ${link(u.address)} (unverified, or the explorer lookup failed)`,
            )
        }
    }

    if (r.ageDays !== undefined) {
        const date = new Date((r.deployedAt ?? 0) * 1000).toISOString().slice(0, 10)
        lines.push(`- Deployed ${date} (${r.ageDays} days ago)${r.ageDays < 30 ? ' ⚠️ **less than 30 days old**' : ''}`)
    } else {
        lines.push('- Deployment date: unknown (explorer lookup failed)')
    }

    if (r.assetInCallPath !== undefined) {
        lines.push(
            r.assetInCallPath
                ? '- The submitted asset is read during `getRate`.'
                : '- ⚠️ The submitted asset is **not** read during `getRate`. That is expected for oracle-based providers; otherwise confirm the asset and rate provider belong together.',
        )
    }

    const c = r.erc4626Consistency
    if (c) {
        const mismatch = c.diffBps === undefined || c.diffBps > 10
        lines.push(
            `- The asset is an ERC4626 vault. Its rate (\`convertToAssets\`, 18 decimals) is ${c.vaultRate} and \`getRate\` returns ${c.providerRate}` +
                (c.diffBps !== undefined ? `, a difference of ${c.diffBps} bps` : '') +
                (mismatch ? '. ⚠️ **These differ**; confirm the rate provider is meant for this vault.' : '.'),
        )
    }
    return lines.join('\n')
}

function renderLiquidity(r: Erc4626LiquidityResult, link: Link): string {
    const lines: string[] = []
    const fmt = (v: bigint | undefined, decimals: number | undefined) =>
        v === undefined ? 'n/a' : decimals === undefined ? v.toString() : formatUnits(v, decimals)

    if (r.underlying) lines.push(`- Underlying asset: ${r.underlyingSymbol ?? ''} ${link(r.underlying)}`)
    lines.push(`- Total assets: ${fmt(r.totalAssets, r.assetDecimals)}`)

    const limit = (v: bigint | undefined, decimals: number | undefined) =>
        v === undefined
            ? 'n/a'
            : isUnlimited(v)
              ? 'unlimited'
              : v === 0n
                ? '⚠️ **0 (deposits blocked: paused, capped or permissioned)**'
                : fmt(v, decimals)
    lines.push(`- maxDeposit for an ordinary address: ${limit(r.maxDeposit, r.assetDecimals)}`)
    lines.push(`- maxMint for an ordinary address: ${limit(r.maxMint, r.shareDecimals)}`)

    if (r.idleAssets !== undefined) {
        lines.push(
            `- Underlying held idle by the vault: ${fmt(r.idleAssets, r.assetDecimals)}${r.idlePercent !== undefined ? ` (${r.idlePercent}% of total assets)` : ''}. ` +
                'Funds deployed in strategies or lending markets may not be withdrawable on demand; check utilisation of the underlying markets.',
        )
    }

    const fee = (bps: number | undefined, what: string) =>
        bps === undefined ? `- ${what}: n/a` : `- ${what}: ${bps} bps${bps > 1 ? ' ⚠️ **fee or haircut applied**' : ''}`
    lines.push(fee(r.redeemFeeBps, 'Gap between `previewRedeem` and `convertToAssets`'))
    lines.push(fee(r.depositFeeBps, 'Gap between `previewDeposit` and `convertToShares`'))

    if (r.pausedNow !== undefined) lines.push(`- Paused now: ${r.pausedNow ? '⚠️ **yes**' : 'no'}`)
    lines.push('- Per-holder withdrawal limits (`maxWithdraw`/`maxRedeem`) are not checked automatically.')
    return lines.join('\n')
}

function renderToken(t: TokenRiskResult, link: Link): string {
    const name = `${t.symbol ?? 'Token'} ${link(t.address)}`
    if (!t.abiChecked) {
        return `- ${name}: ⚠️ ${t.abiUnavailableReason ?? 'ABI unavailable'}, so pause, blocklist, rebasing and transfer-fee features could not be checked.${t.pausedNow ? ' ⚠️ **Paused now.**' : ''}`
    }
    const flags: string[] = []
    const list = (names: string[]) => names.map((n) => `\`${n}\``).join(', ')
    if (t.pausable.length) flags.push(`pausable (${list(t.pausable)})`)
    if (t.blocklist.length) flags.push(`can block or freeze addresses (${list(t.blocklist)})`)
    if (t.rebasing.length) flags.push(`possibly rebasing (${list(t.rebasing)})`)
    if (t.feeOnTransfer.length) flags.push(`possible transfer fee (${list(t.feeOnTransfer)})`)
    const paused = t.pausedNow ? ' ⚠️ **Paused now.**' : ''
    return flags.length === 0
        ? `- ${name}: no pause, blocklist, rebasing or transfer-fee features found.${paused}`
        : `- ${name}: ${flags.join('; ')}.${paused}`
}
