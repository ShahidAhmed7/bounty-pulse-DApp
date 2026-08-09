import { BrowserProvider, Contract } from 'ethers'
import abi from './BountyPulse.abi.json'

/**
 * Address of the deployed BountyPulse contract.
 *
 * Deploying first, from Anvil account #0, on a freshly restarted node always produces
 * this address (it derives from deployer + nonce). If you deploy twice without
 * restarting Anvil the address changes - either restart Anvil, or override this by
 * setting VITE_CONTRACT_ADDRESS in frontend/.env
 */
export const CONTRACT_ADDRESS =
  import.meta.env.VITE_CONTRACT_ADDRESS || '0x5FbDB2315678afecb367f032d93F642f64180aa3'

export const CONTRACT_ABI = abi

/** Anvil's chain id. MetaMask must be on this network or every call fails. */
export const CHAIN_ID = 31337n

export function hasWallet() {
  return typeof window !== 'undefined' && Boolean(window.ethereum)
}

/** Read-only provider - free view calls, no MetaMask popup. */
export function getProvider() {
  if (!hasWallet()) throw new Error('MetaMask not found. Install it to use BountyPulse.')
  return new BrowserProvider(window.ethereum)
}

/** Prompts MetaMask to connect and returns the active signer. */
export async function getSigner() {
  const provider = getProvider()
  await provider.send('eth_requestAccounts', [])

  const network = await provider.getNetwork()
  if (network.chainId !== CHAIN_ID) {
    throw new Error(`Wrong network: expected Anvil (${CHAIN_ID}), got ${network.chainId}.`)
  }

  return provider.getSigner()
}

/**
 * Contract instance for reading. Costs no gas and never opens MetaMask.
 * Use this for the feed, balances, and anything you only display.
 */
export async function getReadContract() {
  return new Contract(CONTRACT_ADDRESS, CONTRACT_ABI, getProvider())
}

/**
 * Contract instance for writing. Every call through this sends a transaction,
 * costs gas, and pops MetaMask for a signature.
 */
export async function getWriteContract() {
  return new Contract(CONTRACT_ADDRESS, CONTRACT_ABI, await getSigner())
}
