const PINATA_JWT = import.meta.env.VITE_PINATA_JWT
const PINATA_API = 'https://api.pinata.cloud'
const PINATA_GATEWAY = 'https://gateway.pinata.cloud/ipfs'

function assertJwt() {
  if (!PINATA_JWT) {
    throw new Error(
      'Missing VITE_PINATA_JWT. Run `cp .env.example .env` in frontend/ and paste your Pinata JWT.',
    )
  }
}

async function assertOk(res) {
  if (!res.ok) {
    throw new Error(`Pinata upload failed (${res.status}): ${await res.text()}`)
  }
}

/**
 * Uploads a File/Blob (avatar image, work deliverable, ...) to Pinata.
 * Returns the resulting CID - this is the string the smart contract stores,
 * never the file itself.
 */
export async function uploadFileToPinata(file) {
  assertJwt()

  const formData = new FormData()
  formData.append('file', file)

  const res = await fetch(`${PINATA_API}/pinning/pinFileToIPFS`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${PINATA_JWT}` },
    body: formData,
  })
  await assertOk(res)

  const { IpfsHash } = await res.json()
  return IpfsHash
}

/**
 * Uploads plain JSON (e.g. a bounty description) to Pinata and returns its CID.
 * Used instead of uploadFileToPinata when there's no file, just structured text.
 */
export async function uploadJSONToPinata(data) {
  assertJwt()

  const res = await fetch(`${PINATA_API}/pinning/pinJSONToIPFS`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${PINATA_JWT}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ pinataContent: data }),
  })
  await assertOk(res)

  const { IpfsHash } = await res.json()
  return IpfsHash
}

/** Builds a browser-viewable URL for a CID via Pinata's public gateway. */
export function cidToGatewayUrl(cid) {
  return `${PINATA_GATEWAY}/${cid}`
}
