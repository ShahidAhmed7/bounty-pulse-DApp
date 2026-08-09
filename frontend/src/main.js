import './style.css'
import { parseEther } from 'ethers'
import { hasWallet, getProvider, getSigner, getReadContract, getWriteContract } from './contract/config.js'
import { uploadFileToPinata, uploadJSONToPinata, cidToGatewayUrl } from './ipfsHelper.js'

const ROLE_NAMES = ['None', 'Client', 'Freelancer', 'Arbiter']

const app = document.querySelector('#app')

const state = {
  address: null,
  user: null, // { name, avatarCID, role, reputation, registered } or null until loaded
  status: null, // { message, isError }
  results: {
    register: null, // { avatarCID } | null
    postBounty: null, // { bountyId, detailsCID }
    submitWork: null, // { workCID }
  },
}

function short(address) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

function setStatus(message, isError = false) {
  state.status = message ? { message, isError } : null
  render()
}

async function loadAccount(address) {
  state.address = address
  try {
    const reader = await getReadContract()
    state.user = await reader.getUser(address)
  } catch (err) {
    console.error(err)
    setStatus(`Could not read on-chain profile: ${err.message}`, true)
  }
}

async function connectWallet() {
  try {
    setStatus('Connecting...')
    await getSigner() // prompts MetaMask, throws if on the wrong chain
    const [address] = await getProvider().send('eth_accounts', [])
    await loadAccount(address)
    setStatus(null)
  } catch (err) {
    setStatus(err.message, true)
  }
}

async function handleRegister(event) {
  event.preventDefault()
  const form = event.target
  const name = form.name.value.trim()
  const role = Number(form.role.value)
  const avatarFile = form.avatar.files[0]

  try {
    setStatus('Uploading avatar to IPFS...')
    const avatarCID = avatarFile ? await uploadFileToPinata(avatarFile) : ''

    setStatus('Confirm the transaction in MetaMask...')
    const writer = await getWriteContract()
    const tx = await writer.register(name, avatarCID, role)
    setStatus('Waiting for the transaction to be mined...')
    await tx.wait()

    state.results.register = avatarCID ? { avatarCID } : null
    await loadAccount(state.address)
    setStatus('Registered!')
  } catch (err) {
    setStatus(err.message, true)
  }
}

async function handlePostBounty(event) {
  event.preventDefault()
  const form = event.target
  const budgetEth = form.budget.value
  const description = form.description.value.trim()

  try {
    setStatus('Uploading bounty details to IPFS...')
    const detailsCID = await uploadJSONToPinata({ description })

    setStatus('Confirm the transaction in MetaMask...')
    const writer = await getWriteContract()
    const tx = await writer.postBounty(parseEther(budgetEth), detailsCID)
    setStatus('Waiting for the transaction to be mined...')
    const receipt = await tx.wait()

    // postBounty's `returns (uint256 bountyId)` isn't reachable from a mined
    // transaction - only a receipt is. The id has to be read back out of the
    // BountyPosted event the function emits.
    const parsed = receipt.logs
      .map((log) => {
        try {
          return writer.interface.parseLog(log)
        } catch {
          return null
        }
      })
      .find((log) => log?.name === 'BountyPosted')

    state.results.postBounty = { bountyId: parsed.args.bountyId.toString(), detailsCID }
    form.reset()
    setStatus('Bounty posted!')
  } catch (err) {
    setStatus(err.message, true)
  }
}

async function handleSubmitWork(event) {
  event.preventDefault()
  const form = event.target
  const bountyId = form.bountyId.value
  const workFile = form.workFile.files[0]

  try {
    setStatus('Uploading work file to IPFS...')
    const workCID = await uploadFileToPinata(workFile)

    setStatus('Confirm the transaction in MetaMask...')
    const writer = await getWriteContract()
    const tx = await writer.submitWork(bountyId, workCID)
    setStatus('Waiting for the transaction to be mined...')
    await tx.wait()

    state.results.submitWork = { workCID, isImage: workFile.type.startsWith('image/') }
    form.reset()
    setStatus('Work submitted!')
  } catch (err) {
    setStatus(err.message, true)
  }
}

function walletBarHtml() {
  if (!hasWallet()) {
    return `<div class="wallet-bar"><span class="error">MetaMask not found - install it to use BountyPulse.</span></div>`
  }

  if (!state.address) {
    return `<div class="wallet-bar"><button id="connect-btn" type="button">Connect Wallet</button></div>`
  }

  const roleName = state.user ? ROLE_NAMES[Number(state.user.role)] : '...'
  const badgeClass = state.user?.registered ? `badge role-${roleName.toLowerCase()}` : 'badge role-none'
  const reputation =
    state.user?.registered && Number(state.user.role) === 2
      ? `<span class="reputation">Reputation: ${state.user.reputation}</span>`
      : ''

  return `
    <div class="wallet-bar">
      <span class="address" title="${state.address}">${short(state.address)}</span>
      <span class="${badgeClass}">${state.user?.registered ? roleName : 'Not registered'}</span>
      ${reputation}
    </div>
  `
}

function statusHtml() {
  if (!state.status) return ''
  return `<div class="status ${state.status.isError ? 'status-error' : 'status-ok'}">${state.status.message}</div>`
}

function registerFormHtml() {
  if (state.user?.registered) return ''

  const result = state.results.register
    ? `
      <div class="cid-result">
        <p>Avatar CID: <code>${state.results.register.avatarCID}</code></p>
        <img class="avatar-preview" src="${cidToGatewayUrl(state.results.register.avatarCID)}" alt="avatar preview" />
      </div>
    `
    : ''

  return `
    <section class="card">
      <h2>Register</h2>
      <form id="register-form">
        <label>Name <input name="name" type="text" required /></label>
        <label>Role
          <select name="role" required>
            <option value="1">Client</option>
            <option value="2">Freelancer</option>
          </select>
        </label>
        <label>Avatar (optional) <input name="avatar" type="file" accept="image/*" /></label>
        <button type="submit">Register</button>
      </form>
      ${result}
    </section>
  `
}

function postBountyFormHtml() {
  if (!state.user?.registered || Number(state.user.role) !== 1) return ''

  const result = state.results.postBounty
    ? `
      <div class="cid-result">
        <p>Bounty #${state.results.postBounty.bountyId} posted.</p>
        <p>Details CID: <code>${state.results.postBounty.detailsCID}</code></p>
        <a href="${cidToGatewayUrl(state.results.postBounty.detailsCID)}" target="_blank" rel="noopener">View on IPFS gateway</a>
      </div>
    `
    : ''

  return `
    <section class="card">
      <h2>Post a Bounty</h2>
      <form id="post-bounty-form">
        <label>Max budget (ETH) <input name="budget" type="number" step="any" min="0" required /></label>
        <label>Description <textarea name="description" rows="4" required></textarea></label>
        <button type="submit">Post Bounty</button>
      </form>
      ${result}
    </section>
  `
}

function submitWorkFormHtml() {
  if (!state.user?.registered || Number(state.user.role) !== 2) return ''

  const result = state.results.submitWork
    ? `
      <div class="cid-result">
        <p>Work CID: <code>${state.results.submitWork.workCID}</code></p>
        ${
          state.results.submitWork.isImage
            ? `<img class="avatar-preview" src="${cidToGatewayUrl(state.results.submitWork.workCID)}" alt="submitted work preview" />`
            : `<a href="${cidToGatewayUrl(state.results.submitWork.workCID)}" target="_blank" rel="noopener">View on IPFS gateway</a>`
        }
      </div>
    `
    : ''

  return `
    <section class="card">
      <h2>Submit Work</h2>
      <form id="submit-work-form">
        <label>Bounty ID <input name="bountyId" type="number" min="0" required /></label>
        <label>Work file <input name="workFile" type="file" required /></label>
        <button type="submit">Submit Work</button>
      </form>
      ${result}
    </section>
  `
}

function render() {
  app.innerHTML = `
    <header>
      <h1>BountyPulse</h1>
      ${walletBarHtml()}
    </header>
    ${statusHtml()}
    <main>
      ${registerFormHtml()}
      ${postBountyFormHtml()}
      ${submitWorkFormHtml()}
    </main>
  `

  document.querySelector('#connect-btn')?.addEventListener('click', connectWallet)
  document.querySelector('#register-form')?.addEventListener('submit', handleRegister)
  document.querySelector('#post-bounty-form')?.addEventListener('submit', handlePostBounty)
  document.querySelector('#submit-work-form')?.addEventListener('submit', handleSubmitWork)
}

async function init() {
  render()
  if (!hasWallet()) return

  // Silent read - eth_accounts never opens a MetaMask popup, unlike
  // eth_requestAccounts. This is how the address is "auto-detected on load"
  // without ever asking the user to type a wallet address.
  const [address] = await getProvider().send('eth_accounts', [])
  if (address) await loadAccount(address)
  render()

  window.ethereum.on('accountsChanged', async (accounts) => {
    state.results.register = null
    state.results.postBounty = null
    state.results.submitWork = null
    if (accounts.length === 0) {
      state.address = null
      state.user = null
    } else {
      await loadAccount(accounts[0])
    }
    render()
  })
}

init()
