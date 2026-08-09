# BountyPulse

Decentralized micro-bounty and escrow DApp. Solidity + Foundry contract, Vite + Ethers.js v6
frontend, file storage on IPFS via Pinata.

See [`DApp_Su26.md`](DApp_Su26.md) for the full specification.

## Status

| Part | State |
|---|---|
| Smart contract (`src/BountyPulse.sol`) | ✅ complete — 28 tests passing |
| Deploy script (`script/Deploy.s.sol`) | ✅ working |
| ABI export (`frontend/src/contract/`) | ✅ generated |
| Frontend UI / IPFS / events | 🚧 in progress |

## Prerequisites

- [Foundry](https://book.getfoundry.sh/getting-started/installation) (`forge`, `anvil`, `cast`)
- Node.js 18+
- MetaMask browser extension
- A Pinata account for the IPFS JWT

## Running it locally

**1. Start the local chain** — leave this terminal open.

```bash
anvil
```

**2. Deploy the contract** in a second terminal.

```bash
forge script script/Deploy.s.sol:Deploy \
  --rpc-url http://127.0.0.1:8545 \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  --broadcast
```

On a freshly restarted Anvil this always deploys to
`0x5FbDB2315678afecb367f032d93F642f64180aa3`, which is the address the frontend expects.
Deploying twice without restarting Anvil advances the deployer's nonce and changes the
address — restart Anvil, or set `VITE_CONTRACT_ADDRESS` in `frontend/.env`.

**3. Configure the frontend.**

```bash
cd frontend
cp .env.example .env    # then paste your Pinata JWT into it
npm install
npm run dev
```

**4. Point MetaMask at Anvil.**

| Field | Value |
|---|---|
| Network name | Anvil Local |
| RPC URL | `http://127.0.0.1:8545` |
| Chain ID | `31337` |
| Currency | ETH |

Then import these Anvil test accounts (private keys are public and hardcoded into Foundry —
**local development only, never a real network**):

| Role | Private key |
|---|---|
| Arbiter (deployer) | `0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80` |
| Client | `0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d` |
| Freelancer | `0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a` |

> **Restarting Anvil?** MetaMask caches the old nonce and every transaction then fails with
> "Nonce too high". Fix: Settings → Advanced → **Clear activity tab data**, for each account.

## Contract development

```bash
forge build          # compile
forge test           # 28 tests
forge test -vvvv     # full traces, for debugging
forge fmt            # format
```

**After changing the contract, always regenerate the ABI** or the frontend will fail with
confusing decode errors while the Solidity looks fine:

```bash
forge build && jq '.abi' out/BountyPulse.sol/BountyPulse.json \
  > frontend/src/contract/BountyPulse.abi.json
```

## Using the contract from the frontend

`frontend/src/contract/config.js` exports the address, ABI, and ready-made helpers:

```js
import { getReadContract, getWriteContract } from './contract/config.js'

// Reading is free and never opens MetaMask.
const reader = await getReadContract()
const bounties = await reader.getAllBounties()

// Writing sends a transaction and prompts for a signature.
const writer = await getWriteContract()
const tx = await writer.register('Alice', cid, 2)   // Role: 1=Client, 2=Freelancer
await tx.wait()
```

> **Gotcha:** `postBounty` returns a `bountyId` in Solidity, but a transaction resolves to a
> *receipt*, not a return value. To get the new ID, read it from the `BountyPosted` event in
> the receipt logs.

Enum values on the wire: `Role { None:0, Client:1, Freelancer:2, Arbiter:3 }` and
`Status { Open:0, Locked:1, Submitted:2, Resolved:3, Disputed:4 }`.
