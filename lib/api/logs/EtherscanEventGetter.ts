import axios from 'axios';
import type { Filter, Log } from 'lib/interfaces';
import {
  ETHERSCAN_SUPPORTED_CHAINS,
  getChainApiIdentifer,
  getChainApiKey,
  getChainApiRateLimit,
  getChainApiUrl,
} from 'lib/utils/chains';
import { getAddress } from 'viem';
import type { EventGetter } from './EventGetter';
import { RequestQueue } from './RequestQueue';

export class EtherscanEventGetter implements EventGetter {
  private queues: { [chainId: number]: RequestQueue };

  constructor() {
    const queueEntries = ETHERSCAN_SUPPORTED_CHAINS.map((chainId) => [
      chainId,
      new RequestQueue(getChainApiIdentifer(chainId), getChainApiRateLimit(chainId)),
    ]);
    this.queues = Object.fromEntries(queueEntries);
  }

  async getEvents(chainId: number, filter: Filter, page: number = 1): Promise<Log[]> {
    const apiUrl = getChainApiUrl(chainId);
    const apiKey = getChainApiKey(chainId);
    const queue = this.queues[chainId]!;

    const query = prepareEtherscanGetLogsQuery(filter, page, apiKey);

    const { data } = await retryOn429(() => queue.add(() => axios.get(apiUrl, { params: query })));

    // Throw an error that is compatible with the recursive getLogs retrying client-side if we hit the result limit
    if (data.result?.length === 1000) {
      console.log(data);

      // If we cannot split this block range further, we use Etherscan's pagination in the hope that it does not exceed
      // 10 pages of results
      if (filter.fromBlock === filter.toBlock) {
        return [...data.result.map(formatEtherscanEvent), ...(await this.getEvents(chainId, filter, page + 1))];
      }

      throw new Error('Log response size exceeded');
    }

    if (typeof data.result === 'string') {
      // If we somehow hit the rate limit, we try again
      if (data.result.includes('Max rate limit reached')) {
        console.error('Rate limit reached, retrying...');
        return this.getEvents(chainId, filter);
      }

      // If the query times out, this indicates that we should try again with a smaller block range
      if (data.result.includes('Query Timeout occured')) {
        throw new Error('Log response size exceeded');
      }

      throw new Error(data.result);
    }

    if (!Array.isArray(data.result)) {
      console.log(data);
      throw new Error('Could not retrieve event logs from the blockchain');
    }

    return data.result.map(formatEtherscanEvent);
  }
}

const prepareEtherscanGetLogsQuery = (filter: Filter, page: number, apiKey?: string) => {
  const [topic0, topic1, topic2, topic3] = (filter.topics ?? []).map((topic) =>
    typeof topic === 'string' ? topic.toLowerCase() : topic,
  );

  const query = {
    module: 'logs',
    action: 'getLogs',
    // address: undefined,
    fromBlock: filter.fromBlock ?? 0,
    toBlock: filter.toBlock ?? 'latest',
    topic0,
    topic1,
    topic2,
    topic3,
    topic0_1_opr: topic0 && topic1 ? 'and' : undefined,
    topic0_2_opr: topic0 && topic2 ? 'and' : undefined,
    topic0_3_opr: topic0 && topic3 ? 'and' : undefined,
    topic1_2_opr: topic1 && topic2 ? 'and' : undefined,
    topic1_3_opr: topic1 && topic3 ? 'and' : undefined,
    topic2_3_opr: topic2 && topic3 ? 'and' : undefined,
    offset: 1000,
    apiKey,
    page,
  };

  return query;
};

const formatEtherscanEvent = (etherscanLog: any) => ({
  address: getAddress(etherscanLog.address),
  topics: etherscanLog.topics.filter((topic: string) => !!topic),
  data: etherscanLog.data,
  transactionHash: etherscanLog.transactionHash,
  blockNumber: Number.parseInt(etherscanLog.blockNumber, 16),
  transactionIndex: Number.parseInt(etherscanLog.transactionIndex, 16),
  logIndex: Number.parseInt(etherscanLog.logIndex, 16),
  timestamp: Number.parseInt(etherscanLog.timeStamp, 16),
});

// Certain Blockscout instances will return a 429 error if we hit the rate limit instead of a 200 response with the error message
const retryOn429 = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (e) {
    if (e.message.includes('429')) {
      console.error('Rate limit reached, retrying...');
      return retryOn429(fn);
    }

    throw e;
  }
};
