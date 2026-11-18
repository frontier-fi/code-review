# code-review

A collection of smart contract code reviews performed upon friendly request.

NOTHING IN THIS REPOSITORY CONSTITUTES A FORMAL AUDIT, AND CODE SHOULD NEVER BE DEPLOYED TO PRODUCTION WITHOUT A FORMAL AUDIT. REVIEWERS ARE HUMAN; MISTAKES WILL BE MADE AND BUGS MISSED. REVIEWERS ARE NOT LIABLE FOR ANY INCIDENT THAT OCCURS POST-REVIEW. THIS IS MERELY A FRIENDLY PEER-REVIEW SERVICE AND SHOULD NOT BE TREATED AS A STAMP OF APPROVAL. REVIEWED CODE IS NOT NECESSARILY BUG-FREE. ALWAYS TRIPLE-CHECK BEFORE INTERACTING WITH SMART CONTRACTS, AND DO NOT TRUST REVIEWERS ON THE BASIS OF REPUTATION ALONE.

## Rate Provider Factories

Balancer deployed these factories, and Frontier reuses them. They are immutable: none is a proxy, and none has an owner, pause or disable function. Anyone can call `create`, and the rate providers they create have no admin and fix all parameters at construction. A factory-created rate provider is therefore only as safe as the contracts it reads from (the price feed, the ERC4626 vault, or the two combined rate providers).

`write-review` detects whether a rate provider was created by one of these factories and fills in the `factory` field of its registry entry. The list of known factories lives in `src/utils/rateProviderFactories.ts`.

### Chainlink and ERC4626 Rate Provider Factories

| Network    | ChainlinkRateProviderFactory               | ERC4626RateProviderFactory                 |
| ---------- | ------------------------------------------ | ------------------------------------------ |
| Arbitrum   | 0x5DbAd78818D4c8958EfF2d5b95b28385A22113Cd | 0xe548a29631f9E49830bE8edc22d407b2D2915F31 |
| Avalanche  | 0x76578ecf9a141296Ec657847fb45B0585bCDa3a6 | 0xfCe81cafe4b3F7e2263EFc2d907f488EBF2B238E |
| Base       | 0x0A973B6DB16C2ded41dC91691Cc347BEb0e2442B | 0xEfD3aF73d3359014f3B864d37AC672A6d3D7ff1A |
| Ethereum   | 0x1311Fbc9F60359639174c1e7cC2032DbDb5Cc4d1 | 0xFC541f8d8c5e907E236C8931F0Df9F58e0C259Ec |
| Monad      | 0x138D9E0d0Cc4906C4cD865b38c9340A5CeDD9850 | 0xb0334C5287Bfb15A8C9464898CDB0248ED176332 |
| Sepolia    | 0xA8920455934Da4D853faac1f94Fe7bEf72943eF1 | N/A                                        |

The Chainlink rate provider only checks that the price is positive. It has no staleness or L2 sequencer check.

### Rate Transformer Factories

Use these factories when an ERC4626 vault contains a yield bearing token to combine their respective rates of growth. This denominates the vault asset in the underlying for correlated pairs. For example Aave-wstETH pairing with Aave-wETH by denominating the assets in wETH.

| Network    | AaveRateTransformerFactory                 |
| ---------- | ------------------------------------------ |
| Arbitrum   | 0xeC2C6184761ab7fE061130B4A7e3Da89c72F8395 |
| Base       | 0x4E185b1502Fea7a06B63fDdA6de38F92C9528566 |
| Ethereum   | 0xeC2C6184761ab7fE061130B4A7e3Da89c72F8395 |

### Constant Rate Provider Factories

Use these factories for Gyro pools. They report a static rate custom tailored to gyro pools.

| Network    | ConstantRateProviderFactory                |
| ---------- | ------------------------------------------ |
| Arbitrum   | 0xF502791715F287989374c452Fa78b475A3194a90 |
| Base       | 0xc0555b555857AAf2b5b28601eaAcFba2F8BBFB09 |
| Ethereum   | 0x1973A094af519CA65cE5ce79E7A8c87dC2fF1767 |

### Combined Rate Provider Factories

Use these factories to combine rate providers, similar to AaveRateTransformers. These factories take in two different rate providers, multiply them, and display the result as getRate. Used for nested rates to denominate the base asset. For example Aave - wstETH has a LST rate and a lending vault rate which must be combined to result in the ETH rate.

| Network    | CombinedRateProviderFactory                |
| ---------- | ------------------------------------------ |
| Arbitrum   | 0x26dEc0e6a4249F28e0f16A1a79808bF9ba308310 |
| Avalanche  | 0xeC2C6184761ab7fE061130B4A7e3Da89c72F8395 |
| Base       | 0x40B48e1eB72c62f7201B4C2621Df7D822CCB9944 |
| Ethereum   | 0xd2cd8027F8c4B8ddCd1bFcD4e47587f41F2712f2 |
| Monad      | 0x8942C1e1e0D48E14EFBa4cc48d2E3584116e367f |

---

## Setup

1. **Install dependencies:**
    ```sh
    npm install
    ```

2. **Set up environment variables:**
    Create a .env file in the root directory and add the necessary environment variables. You can use the .env.example file as a reference.

    ```sh
    cp .env.example .env
    ```

    ### Essential Environment Variables:
    - **`TENDERLY_ACCOUNT_SLUG`**: Your Tenderly account slug.
    - **`TENDERLY_PROJECT_SLUG`**: Your Tenderly project slug.
    - **`TENDERLY_API_ACCESS_KEY`**: Your Tenderly API access key.
    - **`ETHERSCAN_API_KEY`**: Your Etherscan API key (for Ethereum).
    - **`DRPC_API_KEY`**: Your dRPC API key, used to build the RPC URL for the issue's network.

---

## Testing

1. **Run tests:**
    ```sh
    npm test
    ```

---

## Scripts

The following scripts are available in the package.json file:

- **`npm run test`**: Runs the test suite.
- **`npm run lint`**: Lints the registry.
- **`npm run write-review`**: Generates the rate-provider review.
- **`npm run backfill-factories`**: Fills in the `factory` field of registry entries created by a known factory.

---

## Running Scripts

### `npm run write-review`

This script generates a review for a specified rate provider. It fetches the necessary data, generates a markdown review file, and updates the registry with the new review information.

#### Usage:
```sh
npm run write-review -- --rateProviderAddress <address> --network <network> --rateProviderAsset <asset> --rpcUrl <rpcUrl>
```

#### Example:
```sh
npm run write-review -- --rateProviderAddress 0xA4c27E4Aa764312fD958345Ed683c6eeC4581A10 --network mainnet --rateProviderAsset 0x7788A3538C5fc7F9c7C8A74EAC4c898fC8d87d92 --rpcUrl <yourRpcUrl>
```

#### Supported Networks:

**WIP**: This is work in progress and will be updated once more reviews for new networks come in.

The supported networks can be seen in the `write-review.ts` file under the network option:
```typescript
.option('network', {
    alias: 'n',
    type: 'string',
    description: 'The network the rate provider is deployed on',
    choices: ['base', 'mainnet', 'arbitrum', 'avalanche', 'monad', 'sepolia'],
    demandOption: true,
})
```

### `npm run backfill-factories`

This script asks every known factory (see [Rate Provider Factories](#rate-provider-factories)) whether it created each registry entry that has an empty `factory` field, and fills in the factory address where one did. It needs `DRPC_API_KEY`.

#### Usage:
```sh
npm run backfill-factories
```

---

## Output

The `write-review` script does the following:
1. Updates the `registry.json` file with rate provider information, including the factory that created it if it is a known one.
2. Generates a markdown review report.
3. Runs automated security checks (`src/checks/`) and adds them to the report: who controls each contract in the `getRate` path, oracle feeds and their staleness, AMM spot-price reads, unverified contracts, contract age, and risks of the pooled token. A detected oracle adds the `market-rate` warning; an unverified contract in the call path makes the review `UNUSABLE`.

### Post-Script Actions:
Before the review is finalized, the user is expected to:
- Add context about the rate provider in the generated markdown file.
- Include audit reports (if available).
- Optionally rename the review file and update the `name` and `review` fields in the registry.
