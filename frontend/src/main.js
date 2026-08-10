import './style.css'
import { parseEther, formatEther } from 'ethers'
import { hasWallet, getProvider, getSigner, getReadContract, getWriteContract, getEventContract } from './contract/config.js'
import { uploadFileToPinata, uploadJSONToPinata, cidToGatewayUrl } from './ipfsHelper.js'

const ROLE_NAMES = ['None', 'Client', 'Freelancer', 'Arbiter']
const STATUS_NAMES = ['Open', 'Locked', 'Submitted', 'Resolved', 'Disputed']

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
  bounties: [], // [{ id, client, winner, maxBudget, escrow, detailsCID, workCID, status, bids: Bid[] }]
  sortBy: 'newest', // 'newest' | 'budget-desc' | 'budget-asc'
  withdrawable: 0n,
}

function short(address) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

function sameAddress(a, b) {
  return Boolean(a) && Boolean(b) && a.toLowerCase() === b.toLowerCase()
}

function setStatus(message, isError = false) {
  state.status = message ? { message, isError } : null
  render()
}

async function loadBounties() {
  try {
    const reader = await getReadContract()
    const raw = await reader.getAllBounties()
    state.bounties = await Promise.all(
      raw.map(async (bounty, id) => ({
        id,
        client: bounty.client,
        winner: bounty.winner,
        maxBudget: bounty.maxBudget,
        escrow: bounty.escrow,
        detailsCID: bounty.detailsCID,
        workCID: bounty.workCID,
        status: bounty.status,
        bids: await reader.getBids(id),
      }))
    )
  } catch (err) {
    console.error(err)
    setStatus(`Could not load bounties: ${err.message}`, true)
  }
}

async function loadWithdrawable(address) {
  try {
    const reader = await getReadContract()
    state.withdrawable = await reader.withdrawable(address)
  } catch (err) {
    console.error(err)
  }
}

/** Re-reads everything a write tx could have changed - feed + the caller's own balance. */
async function refreshFeedState() {
  await Promise.all([loadBounties(), loadWithdrawable(state.address)])
}

let refreshTimer = null

/**
 * Debounced full refresh, triggered by a contract event instead of our own tx. A single
 * transaction can emit more than one event (e.g. fundEscrow + a refund) - without coalescing
 * this would re-read chain state twice for one change. Also reloads `state.user` (not just
 * the feed/balance), since reputation can change for an address that isn't the local caller.
 */
function scheduleRefresh() {
  clearTimeout(refreshTimer)
  refreshTimer = setTimeout(async () => {
    if (!state.address) return
    const reader = await getReadContract()
    state.user = await reader.getUser(state.address)
    await refreshFeedState()
    render()
  }, 500)
}

/**
 * Live sync (Checkpoint 5): one wildcard listener catches every contract event instead of
 * eleven near-identical handlers - any state change just triggers the same refresh path.
 */
function subscribeToEvents() {
  getEventContract().on('*', scheduleRefresh)
}

async function loadAccount(address) {
  state.address = address
  try {
    const reader = await getReadContract()
    state.user = await reader.getUser(address)
    await refreshFeedState()
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
    await loadBounties()
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
    await loadBounties()
    setStatus('Work submitted!')
  } catch (err) {
    setStatus(err.message, true)
  }
}

async function handlePlaceBid(event) {
  event.preventDefault()
  const form = event.target
  const bountyId = Number(form.dataset.bountyId)
  const amount = form.amount.value

  try {
    setStatus('Confirm the transaction in MetaMask...')
    const writer = await getWriteContract()
    const tx = await writer.placeBid(bountyId, parseEther(amount))
    setStatus('Waiting for the transaction to be mined...')
    await tx.wait()

    await loadBounties()
    setStatus('Bid placed!')
  } catch (err) {
    setStatus(err.message, true)
  }
}

async function handleFundEscrow(bountyId, bidIndex) {
  try {
    // Read the amount off the already-fetched bid rather than a text input -
    // guarantees the value sent is exactly the chosen bid, never mistyped.
    const bid = state.bounties[bountyId]?.bids[bidIndex]
    if (!bid) throw new Error('Bid not found - refresh and try again')

    setStatus('Confirm the transaction in MetaMask...')
    const writer = await getWriteContract()
    const tx = await writer.fundEscrow(bountyId, bidIndex, { value: bid.amount })
    setStatus('Waiting for the transaction to be mined...')
    await tx.wait()

    await refreshFeedState()
    setStatus('Escrow funded!')
  } catch (err) {
    setStatus(err.message, true)
  }
}

async function handleApproveWork(bountyId) {
  try {
    setStatus('Confirm the transaction in MetaMask...')
    const writer = await getWriteContract()
    const tx = await writer.approveWork(bountyId)
    setStatus('Waiting for the transaction to be mined...')
    await tx.wait()

    await refreshFeedState()
    setStatus('Work approved!')
  } catch (err) {
    setStatus(err.message, true)
  }
}

async function handleRaiseDispute(bountyId) {
  try {
    setStatus('Confirm the transaction in MetaMask...')
    const writer = await getWriteContract()
    const tx = await writer.raiseDispute(bountyId)
    setStatus('Waiting for the transaction to be mined...')
    await tx.wait()

    await refreshFeedState()
    setStatus('Dispute raised!')
  } catch (err) {
    setStatus(err.message, true)
  }
}

async function handleResolveDispute(bountyId, freelancerAtFault) {
  try {
    setStatus('Confirm the transaction in MetaMask...')
    const writer = await getWriteContract()
    const tx = await writer.resolveDispute(bountyId, freelancerAtFault)
    setStatus('Waiting for the transaction to be mined...')
    await tx.wait()

    await refreshFeedState()
    setStatus('Dispute resolved!')
  } catch (err) {
    setStatus(err.message, true)
  }
}

async function handleClaimFunds() {
  try {
    setStatus('Confirm the transaction in MetaMask...')
    const writer = await getWriteContract()
    const tx = await writer.claimFunds()
    setStatus('Waiting for the transaction to be mined...')
    await tx.wait()

    await loadWithdrawable(state.address)
    setStatus('Funds claimed!')
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

function bidsHtml(bounty) {
  if (bounty.bids.length === 0) return `<p class="empty">No bids yet.</p>`

  return `
    <ul class="bid-list">
      ${bounty.bids
        .map((bid, bidIndex) => {
          const isClient = sameAddress(bounty.client, state.address)
          const canFund = isClient && Number(bounty.status) === 0
          return `
            <li class="bid-row">
              <span class="address" title="${bid.freelancer}">${short(bid.freelancer)}</span>
              <span>${formatEther(bid.amount)} ETH</span>
              ${
                canFund
                  ? `<button type="button" class="fund-escrow-btn" data-bounty-id="${bounty.id}" data-bid-index="${bidIndex}">Fund Escrow</button>`
                  : ''
              }
            </li>
          `
        })
        .join('')}
    </ul>
  `
}

function bidFormHtml(bounty) {
  const isFreelancer = state.user?.registered && Number(state.user.role) === 2
  if (!isFreelancer || Number(bounty.status) !== 0) return ''
  if (bounty.bids.some((bid) => sameAddress(bid.freelancer, state.address))) {
    return `<p class="empty">You already bid on this bounty.</p>`
  }
  if (Number(state.user.reputation) < 40) {
    return `<p class="empty">Reputation too low to bid (need 40+).</p>`
  }

  return `
    <form class="bid-form" data-bounty-id="${bounty.id}">
      <label>Your bid (ETH)
        <input name="amount" type="number" step="any" min="0" max="${formatEther(bounty.maxBudget)}" required />
      </label>
      <button type="submit">Place Bid</button>
    </form>
  `
}

function clientActionsHtml(bounty) {
  if (!sameAddress(bounty.client, state.address)) return ''

  const status = Number(bounty.status)
  const buttons = []
  if (status === 2) {
    buttons.push(`<button type="button" class="approve-work-btn" data-bounty-id="${bounty.id}">Approve Work</button>`)
  }
  if (status === 1 || status === 2) {
    buttons.push(`<button type="button" class="raise-dispute-btn" data-bounty-id="${bounty.id}">Raise Dispute</button>`)
  }

  return buttons.length ? `<div class="action-row">${buttons.join('')}</div>` : ''
}

function arbiterActionsHtml(bounty) {
  const isArbiter = state.user?.registered && Number(state.user.role) === 3
  if (!isArbiter || Number(bounty.status) !== 4) return ''

  return `
    <div class="action-row">
      <button type="button" class="resolve-dispute-btn" data-bounty-id="${bounty.id}" data-at-fault="true">Resolve: Freelancer at fault</button>
      <button type="button" class="resolve-dispute-btn" data-bounty-id="${bounty.id}" data-at-fault="false">Resolve: Client at fault</button>
    </div>
  `
}

function bountyCardHtml(bounty) {
  const statusName = STATUS_NAMES[Number(bounty.status)]

  return `
    <article class="card bounty-card">
      <div class="bounty-header">
        <h3>Bounty #${bounty.id}</h3>
        <span class="badge status-${statusName.toLowerCase()}">${statusName}</span>
      </div>
      <p class="bounty-meta">
        Client <span class="address" title="${bounty.client}">${short(bounty.client)}</span>
        &middot; Max budget <strong>${formatEther(bounty.maxBudget)} ETH</strong>
        ${Number(bounty.status) >= 1 ? `&middot; Escrow <strong>${formatEther(bounty.escrow)} ETH</strong>` : ''}
      </p>
      <a href="${cidToGatewayUrl(bounty.detailsCID)}" target="_blank" rel="noopener">View bounty details on IPFS</a>
      ${bounty.workCID ? `<br /><a href="${cidToGatewayUrl(bounty.workCID)}" target="_blank" rel="noopener">View submitted work on IPFS</a>` : ''}

      <h4>Bids</h4>
      ${bidsHtml(bounty)}
      ${bidFormHtml(bounty)}
      ${clientActionsHtml(bounty)}
      ${arbiterActionsHtml(bounty)}
    </article>
  `
}

function sortedBounties() {
  const list = [...state.bounties]
  if (state.sortBy === 'budget-desc') {
    list.sort((a, b) => (a.maxBudget < b.maxBudget ? 1 : a.maxBudget > b.maxBudget ? -1 : 0))
  } else if (state.sortBy === 'budget-asc') {
    list.sort((a, b) => (a.maxBudget > b.maxBudget ? 1 : a.maxBudget < b.maxBudget ? -1 : 0))
  } else {
    list.sort((a, b) => b.id - a.id) // newest first
  }
  return list
}

function bountyFeedHtml() {
  if (!state.address) return ''

  const list = sortedBounties()

  return `
    <section class="card">
      <div class="feed-header">
        <h2>Bounty Feed</h2>
        <label class="sort-select">Sort by
          <select id="sort-select">
            <option value="newest" ${state.sortBy === 'newest' ? 'selected' : ''}>Newest</option>
            <option value="budget-desc" ${state.sortBy === 'budget-desc' ? 'selected' : ''}>Highest Budget</option>
            <option value="budget-asc" ${state.sortBy === 'budget-asc' ? 'selected' : ''}>Lowest Budget</option>
          </select>
        </label>
      </div>
      <div class="bounty-list">
        ${list.length ? list.map(bountyCardHtml).join('') : `<p class="empty">No bounties posted yet.</p>`}
      </div>
    </section>
  `
}

function earningsHtml() {
  if (!state.user?.registered) return ''
  const role = Number(state.user.role)
  // Freelancer/Arbiter always see this (spec 3.4). A Client normally has nothing to
  // claim, EXCEPT a dispute resolved in their favor credits withdrawable[client] too
  // (contract Outcome A, src/BountyPulse.sol) - surface it then, so a refund isn't
  // stuck with no button to claim it.
  const alwaysShows = role === 2 || role === 3
  if (!alwaysShows && state.withdrawable === 0n) return ''

  return `
    <section class="card earnings-card">
      <h2>Unclaimed Earnings</h2>
      <p class="earnings-amount">${formatEther(state.withdrawable)} ETH</p>
      <button type="button" id="claim-funds-btn" ${state.withdrawable === 0n ? 'disabled' : ''}>Claim Funds</button>
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
      ${earningsHtml()}
      ${postBountyFormHtml()}
      ${submitWorkFormHtml()}
      ${bountyFeedHtml()}
    </main>
  `

  document.querySelector('#connect-btn')?.addEventListener('click', connectWallet)
  document.querySelector('#register-form')?.addEventListener('submit', handleRegister)
  document.querySelector('#post-bounty-form')?.addEventListener('submit', handlePostBounty)
  document.querySelector('#submit-work-form')?.addEventListener('submit', handleSubmitWork)
  document.querySelector('#claim-funds-btn')?.addEventListener('click', handleClaimFunds)
  document.querySelector('#sort-select')?.addEventListener('change', (event) => {
    state.sortBy = event.target.value
    render()
  })
  document.querySelectorAll('.bid-form').forEach((form) => form.addEventListener('submit', handlePlaceBid))
  document.querySelectorAll('.fund-escrow-btn').forEach((btn) =>
    btn.addEventListener('click', () => handleFundEscrow(Number(btn.dataset.bountyId), Number(btn.dataset.bidIndex)))
  )
  document
    .querySelectorAll('.approve-work-btn')
    .forEach((btn) => btn.addEventListener('click', () => handleApproveWork(Number(btn.dataset.bountyId))))
  document
    .querySelectorAll('.raise-dispute-btn')
    .forEach((btn) => btn.addEventListener('click', () => handleRaiseDispute(Number(btn.dataset.bountyId))))
  document.querySelectorAll('.resolve-dispute-btn').forEach((btn) =>
    btn.addEventListener('click', () =>
      handleResolveDispute(Number(btn.dataset.bountyId), btn.dataset.atFault === 'true')
    )
  )
}

async function init() {
  render()
  if (!hasWallet()) return

  subscribeToEvents()

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
      state.bounties = []
      state.withdrawable = 0n
    } else {
      await loadAccount(accounts[0])
    }
    render()
  })
}

init()
