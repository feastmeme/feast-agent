import type { Address } from "viem";

/**
 * The two Feast deployments this SDK knows, selected by `FEAST_NETWORK`.
 *
 * Addresses are copied from the Feast app's published address books: the
 * sandbox (a public fork of BNB Smart Chain, chain 56096, where test BNB is
 * free) and BNB Smart Chain itself (chain 56). Every stock token is a Binance
 * bStock and is the SAME contract on both chains, because the sandbox is a fork.
 */

export type NetworkName = "sandbox" | "mainnet";

/** One v3 hop, in the shape the Feast router takes it. */
export type Hop = { tokenOut: Address; fee: number };

/** A tokenized stock (bStock) a Feast coin can be paired with. */
export type StockQuote = {
  /** The token's own ticker, e.g. `AAPLB`. */
  symbol: string;
  address: Address;
  /** The underlying listed share, e.g. `AAPL`. */
  underlying: string;
  /** Who the underlying share is. */
  name: string;
  /** Wrapped native → this token, as the router walks it on a buy. */
  buy: Hop[];
  /** This token → wrapped native, as the router walks it on a sale. */
  sell: Hop[];
  /** The PancakeSwap v3 pool the token is priced in: against USDT, or against WBNB when its route is one hop. */
  pricePool: Address;
};

export type TradeRoute =
  | { kind: "sandbox"; router: Address }
  | { kind: "infinity"; router: Address; permit2: Address; mixedQuoter: Address };

export type FeastNetwork = {
  name: NetworkName;
  chainId: number;
  chainName: string;
  nativeSymbol: string;
  /** A public JSON-RPC endpoint. Override with `FEAST_RPC_URL`. */
  rpcUrl: string;
  /** The Feast site for this chain: its `/api/pin` pins coin metadata, its `/api/v1` is the public read API. */
  siteUrl: string;
  /** The faucet for test BNB; null on mainnet. */
  faucetUrl: string | null;
  explorerUrl: string | null;
  /** Blocks before this one hold no Feast logs. */
  deployBlock: bigint;
  /** True on a chain that holds real money. The SDK refuses to send transactions there. */
  realMoney: boolean;
  trade: TradeRoute;
  contracts: {
    factory: Address;
    hook: Address;
    poolManager: Address;
    vault: Address;
    ledger: Address;
    pricer: Address;
    vesting: Address;
    oracle: Address;
    converter: Address;
    platformSink: Address;
    wrappedNative: Address;
    usdt: Address;
    /** The USDT/WBNB PancakeSwap v3 pool the dollar price of BNB is read from. */
    usdtNativePool: Address;
  };
  stocks: StockQuote[];
};

export const SANDBOX: FeastNetwork = {
  name: "sandbox",
  chainId: 56096,
  chainName: "Feast Sandbox (BNB Smart Chain fork)",
  nativeSymbol: "tBNB",
  rpcUrl: "https://sandbox.feast.meme/api/sandbox/rpc",
  siteUrl: "https://sandbox.feast.meme",
  faucetUrl: "https://sandbox.feast.meme/api/sandbox/faucet",
  explorerUrl: null,
  deployBlock: 121211160n,
  realMoney: false,
  trade: { kind: "sandbox", router: "0xa8c7180912D4464fa66713758Fa7eB3418b81D01" },
  contracts: {
    factory: "0x0c68E97F14D6f934Fef6126a149508fA67B56C3f",
    hook: "0x632261E397351C35f0605dc4FdD83F8dc0f09e44",
    poolManager: "0xa0FfB9c1CE1Fe56963B0321B32E7A0302114058b",
    vault: "0x238a358808379702088667322f80aC48bAd5e6c4",
    ledger: "0xF8e3d44B5E66917307a61E2Be23A25cD068a857a",
    pricer: "0x6e2D59705b1fe25ffe0D77Cc8dE504AFa56810aa",
    vesting: "0x6994ED50b1ae985a89cDC93033985d32cc3696C9",
    oracle: "0x730927e970bb91A6d2b73564c2A0B1Aa02090ebf",
    converter: "0x24E042Db715e90ce4f09733eD3d4B7172590bC9D",
    platformSink: "0xD42D8635F9E60f6a22ab2B3b768A6d594eef7b32",
    wrappedNative: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    usdt: "0x55d398326f99059fF775485246999027B3197955",
    usdtNativePool: "0x36696169C63e42cd08ce11f5deeBbCeBae652050",
  },
  stocks: [
    {
      symbol: "AAPLB",
      address: "0x431a3BEE82E2ca41e49895CbECE5bB0F76A89b7A",
      underlying: "AAPL",
      name: "Apple",
      buy: [{ tokenOut: "0x55d398326f99059fF775485246999027B3197955", fee: 500 }, { tokenOut: "0x431a3BEE82E2ca41e49895CbECE5bB0F76A89b7A", fee: 2500 }],
      sell: [{ tokenOut: "0x55d398326f99059fF775485246999027B3197955", fee: 2500 }, { tokenOut: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", fee: 500 }],
      pricePool: "0xe9b9998b2ec5430d2246c7f1f8d9f298c97d7365",
    },
    {
      symbol: "BNCB",
      address: "0x4902C5ebc598265Ed2212b559B042De8a5Eeec3f",
      underlying: "BNC",
      name: "CEA Industries",
      buy: [{ tokenOut: "0x55d398326f99059fF775485246999027B3197955", fee: 500 }, { tokenOut: "0x4902C5ebc598265Ed2212b559B042De8a5Eeec3f", fee: 500 }],
      sell: [{ tokenOut: "0x55d398326f99059fF775485246999027B3197955", fee: 500 }, { tokenOut: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", fee: 500 }],
      pricePool: "0xb754f10cebf50b8862444cf4d6c1cc31a3b71c18",
    },
    {
      symbol: "MSFTB",
      address: "0x80106cb3EAD06659A5ad19DF39D9b4733863B9b0",
      underlying: "MSFT",
      name: "Microsoft",
      buy: [{ tokenOut: "0x55d398326f99059fF775485246999027B3197955", fee: 500 }, { tokenOut: "0x80106cb3EAD06659A5ad19DF39D9b4733863B9b0", fee: 2500 }],
      sell: [{ tokenOut: "0x55d398326f99059fF775485246999027B3197955", fee: 2500 }, { tokenOut: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", fee: 500 }],
      pricePool: "0x5018b018ceb7645c927c5cf246786f89ebcbe7ea",
    },
    {
      symbol: "MSTRB",
      address: "0xE87afb3076AeB0f9B14E368DE8145ae6a2826A14",
      underlying: "MSTR",
      name: "Strategy",
      buy: [{ tokenOut: "0x55d398326f99059fF775485246999027B3197955", fee: 500 }, { tokenOut: "0xE87afb3076AeB0f9B14E368DE8145ae6a2826A14", fee: 2500 }],
      sell: [{ tokenOut: "0x55d398326f99059fF775485246999027B3197955", fee: 2500 }, { tokenOut: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", fee: 500 }],
      pricePool: "0x692081209619735f25700557078ab084d3e5d007",
    },
    {
      symbol: "NVDAB",
      address: "0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436",
      underlying: "NVDA",
      name: "NVIDIA",
      buy: [{ tokenOut: "0x55d398326f99059fF775485246999027B3197955", fee: 500 }, { tokenOut: "0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436", fee: 2500 }],
      sell: [{ tokenOut: "0x55d398326f99059fF775485246999027B3197955", fee: 2500 }, { tokenOut: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", fee: 500 }],
      pricePool: "0x8fb4243b553ac29ba088acf00b9b7da24bd6690c",
    },
    {
      symbol: "QQQB",
      address: "0x205812CdBed920aFf76C6580abD681a46D11efc7",
      underlying: "QQQ",
      name: "Invesco QQQ (Nasdaq-100)",
      buy: [{ tokenOut: "0x205812CdBed920aFf76C6580abD681a46D11efc7", fee: 500 }],
      sell: [{ tokenOut: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", fee: 500 }],
      pricePool: "0x47bc06722295ac316a569eef87ac32faa455f441",
    },
    {
      symbol: "SPCXB",
      address: "0xbe9D156892E55e7154BcD3cB0FEA677F9D3103E1",
      underlying: "SPCX",
      name: "SpaceX",
      buy: [{ tokenOut: "0xbe9D156892E55e7154BcD3cB0FEA677F9D3103E1", fee: 2500 }],
      sell: [{ tokenOut: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", fee: 2500 }],
      pricePool: "0x66faad27cf481f82d0089ec8156b3aa3636010c7",
    },
    {
      symbol: "TSLAB",
      address: "0x5b1910eAaD6450E50f816082Aa078C41F10C292f",
      underlying: "TSLA",
      name: "Tesla",
      buy: [{ tokenOut: "0x55d398326f99059fF775485246999027B3197955", fee: 500 }, { tokenOut: "0x5b1910eAaD6450E50f816082Aa078C41F10C292f", fee: 2500 }],
      sell: [{ tokenOut: "0x55d398326f99059fF775485246999027B3197955", fee: 2500 }, { tokenOut: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", fee: 500 }],
      pricePool: "0xb0f5e5400e8f0f7c242f2b7740c004f020579c41",
    },
  ],
};

export const MAINNET: FeastNetwork = {
  name: "mainnet",
  chainId: 56,
  chainName: "BNB Smart Chain",
  nativeSymbol: "BNB",
  rpcUrl: "https://bsc-rpc.publicnode.com",
  siteUrl: "https://feast.meme",
  faucetUrl: null,
  explorerUrl: "https://bscscan.com",
  deployBlock: 126462171n,
  realMoney: true,
  trade: {
    kind: "infinity",
    router: "0xd9C500DfF816a1Da21A48A732d3498Bf09dc9AEB",
    permit2: "0x31c2F6fcFf4F8759b3Bd5Bf0e1084A055615c768",
    mixedQuoter: "0x2dCbF7B985c8C5C931818e4E107bAe8aaC8dAB7C",
  },
  contracts: {
    factory: "0x1003b54659F5e31A7391fEBE824A137e8CDa90da",
    hook: "0xABFB955e4582f49dc741DCf5354fbB0edaD0A7c5",
    poolManager: "0xa0FfB9c1CE1Fe56963B0321B32E7A0302114058b",
    vault: "0x238a358808379702088667322f80aC48bAd5e6c4",
    ledger: "0xDbc80A945e67579fF23a7D9E1c658AE4C966C637",
    pricer: "0x3c6a41fa2d743D4b6DbE741A7a64340a2bd8FCE5",
    vesting: "0xDEFAd8D209d808dD4d35CEA02E3E6b1959c7cAbc",
    oracle: "0x25cb1C770d36B4a7dFdC5eD2D6Bc71269Cd57911",
    converter: "0xf95D2F0c52A3e7B1e86b4DbEFeA3C45B163D5b96",
    platformSink: "0x59BA4f39Ce8a405d1C08979680f051c17dC8BBFB",
    wrappedNative: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    usdt: "0x55d398326f99059fF775485246999027B3197955",
    usdtNativePool: "0x172fcD41E0913e95784454622d1c3724f546f849",
  },
  stocks: [
    {
      symbol: "AAPLB",
      address: "0x431a3BEE82E2ca41e49895CbECE5bB0F76A89b7A",
      underlying: "AAPL",
      name: "Apple",
      buy: [{ tokenOut: "0x55d398326f99059fF775485246999027B3197955", fee: 100 }, { tokenOut: "0x431a3BEE82E2ca41e49895CbECE5bB0F76A89b7A", fee: 2500 }],
      sell: [{ tokenOut: "0x55d398326f99059fF775485246999027B3197955", fee: 2500 }, { tokenOut: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", fee: 100 }],
      pricePool: "0xe9b9998B2EC5430D2246c7f1F8D9f298c97D7365",
    },
    {
      symbol: "BABAB",
      address: "0x4eF9d3062c7F6ebA4AAE4990c5036598C6eff4ec",
      underlying: "BABA",
      name: "Alibaba",
      buy: [{ tokenOut: "0x55d398326f99059fF775485246999027B3197955", fee: 100 }, { tokenOut: "0x4eF9d3062c7F6ebA4AAE4990c5036598C6eff4ec", fee: 2500 }],
      sell: [{ tokenOut: "0x55d398326f99059fF775485246999027B3197955", fee: 2500 }, { tokenOut: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", fee: 100 }],
      pricePool: "0xfD95CB1391999006Eb91797a7c62acFe88b20292",
    },
    {
      symbol: "BNCB",
      address: "0x4902C5ebc598265Ed2212b559B042De8a5Eeec3f",
      underlying: "BNC",
      name: "CEA Industries",
      buy: [{ tokenOut: "0x4902C5ebc598265Ed2212b559B042De8a5Eeec3f", fee: 2500 }],
      sell: [{ tokenOut: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", fee: 2500 }],
      pricePool: "0x320e8096e5e7a46E43446141A5B15d801FC596f5",
    },
    {
      symbol: "CRCLB",
      address: "0x80f3D493EBCe97e343c53D29a137942416B4ffC0",
      underlying: "CRCL",
      name: "Circle",
      buy: [{ tokenOut: "0x55d398326f99059fF775485246999027B3197955", fee: 100 }, { tokenOut: "0x80f3D493EBCe97e343c53D29a137942416B4ffC0", fee: 2500 }],
      sell: [{ tokenOut: "0x55d398326f99059fF775485246999027B3197955", fee: 2500 }, { tokenOut: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", fee: 100 }],
      pricePool: "0x29967c54c5Bf12E8158c8894376064b30ebaB297",
    },
    {
      symbol: "GOOGLB",
      address: "0x3F53De71c126BdaBAe20f9cD64848d317f6C3238",
      underlying: "GOOGL",
      name: "Alphabet",
      buy: [{ tokenOut: "0x55d398326f99059fF775485246999027B3197955", fee: 100 }, { tokenOut: "0x3F53De71c126BdaBAe20f9cD64848d317f6C3238", fee: 2500 }],
      sell: [{ tokenOut: "0x55d398326f99059fF775485246999027B3197955", fee: 2500 }, { tokenOut: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", fee: 100 }],
      pricePool: "0x89001D846f7CA36EE089F73eEFC25657E1798144",
    },
    {
      symbol: "NVDAB",
      address: "0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436",
      underlying: "NVDA",
      name: "NVIDIA",
      buy: [{ tokenOut: "0x55d398326f99059fF775485246999027B3197955", fee: 100 }, { tokenOut: "0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436", fee: 2500 }],
      sell: [{ tokenOut: "0x55d398326f99059fF775485246999027B3197955", fee: 2500 }, { tokenOut: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", fee: 100 }],
      pricePool: "0x8FB4243b553aC29BA088aCf00B9B7dA24bD6690C",
    },
    {
      symbol: "QQQB",
      address: "0x205812CdBed920aFf76C6580abD681a46D11efc7",
      underlying: "QQQ",
      name: "Invesco QQQ (Nasdaq-100)",
      buy: [{ tokenOut: "0x205812CdBed920aFf76C6580abD681a46D11efc7", fee: 500 }],
      sell: [{ tokenOut: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", fee: 500 }],
      pricePool: "0x47BC06722295AC316A569EEF87aC32FAA455F441",
    },
    {
      symbol: "SKHYB",
      address: "0xCA750eF65f295BBECd685Abf54e82CAf297BDB61",
      underlying: "SKHY",
      name: "SK hynix",
      buy: [{ tokenOut: "0x55d398326f99059fF775485246999027B3197955", fee: 100 }, { tokenOut: "0xCA750eF65f295BBECd685Abf54e82CAf297BDB61", fee: 2500 }],
      sell: [{ tokenOut: "0x55d398326f99059fF775485246999027B3197955", fee: 2500 }, { tokenOut: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", fee: 100 }],
      pricePool: "0xD7d30F434b12F7Ed9b0Ae11fF1C754745a10aD52",
    },
    {
      symbol: "SPCXB",
      address: "0xbe9D156892E55e7154BcD3cB0FEA677F9D3103E1",
      underlying: "SPCX",
      name: "SpaceX",
      buy: [{ tokenOut: "0xbe9D156892E55e7154BcD3cB0FEA677F9D3103E1", fee: 2500 }],
      sell: [{ tokenOut: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", fee: 2500 }],
      pricePool: "0x66faaD27cf481f82d0089ec8156B3AA3636010C7",
    },
    {
      symbol: "TSLAB",
      address: "0x5b1910eAaD6450E50f816082Aa078C41F10C292f",
      underlying: "TSLA",
      name: "Tesla",
      buy: [{ tokenOut: "0x55d398326f99059fF775485246999027B3197955", fee: 100 }, { tokenOut: "0x5b1910eAaD6450E50f816082Aa078C41F10C292f", fee: 2500 }],
      sell: [{ tokenOut: "0x55d398326f99059fF775485246999027B3197955", fee: 2500 }, { tokenOut: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", fee: 100 }],
      pricePool: "0xB0f5E5400E8F0F7C242F2b7740C004f020579c41",
    },
  ],
};

export const NETWORKS: Record<NetworkName, FeastNetwork> = { sandbox: SANDBOX, mainnet: MAINNET };
