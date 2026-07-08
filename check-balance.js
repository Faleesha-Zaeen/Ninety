import { initWallet, getBalance, getEthBalance, getAddress, shutdownWallet } from './lib/wallet.js'

async function check(dir) {
  console.log(`Checking ${dir}...`)
  await initWallet(dir)
  console.log(`Address: ${getAddress()}`)
  const usdt = await getBalance()
  const eth = await getEthBalance()
  console.log(`USDT: ${usdt.formatted}`)
  console.log(`ETH: ${eth.formatted}`)
  shutdownWallet()
}

async function main() {
  await check('./peer1-wallet')
  console.log('---')
  await check('./peer2-wallet')
  process.exit(0)
}

main()
