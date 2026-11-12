import { Chain } from 'viem'
import EtherscanApi from '../services/etherscanApi'

export const createChainApi = (chain: Chain) => new EtherscanApi(chain, process.env.ETHERSCAN_API_KEY || '')
