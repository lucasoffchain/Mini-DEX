// Fuji 端到端演示：两个不同地址 充值 → 成交 → 提现，全部走真实链上交易 + 正在运行的 server（链上模式）。
// 用法：USER_KEY=0x...(A) USER_B_KEY=0x...(B) npm run fuji:demo
//   A：mint + deposit 100 USDC + 5 WAVAX，挂 sell limit 1 WAVAX @ 20
//   B：mint + deposit 200 USDC，打 buy market 1 WAVAX → 和 A 成交
//   提现：B 提 1 WAVAX，A 提 20 USDC（卖币所得），都上链并核对链上余额变化
// B 没有 gas 时由 A 转 0.1 AVAX 过去。
import "dotenv/config";
import { createPublicClient, createWalletClient, http, parseAbi, getAddress, parseEther, formatEther, type Hex, type Address } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { avalancheFuji } from "viem/chains";

const BASE = process.env.SERVER_URL ?? "http://localhost:8787";
const RPC = process.env.RPC_URL ?? "https://api.avax-test.network/ext/bc/C/rpc";
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 43113);
const VAULT = getAddress(process.env.VAULT_ADDRESS!);
const TOKENS = { USDC: getAddress(process.env.USDC_ADDRESS!), WAVAX: getAddress(process.env.WAVAX_ADDRESS!) } as const;
const DECIMALS = { USDC: 6, WAVAX: 18 } as const;
type Sym = keyof typeof TOKENS;

const pub = createPublicClient({ chain: avalancheFuji, transport: http(RPC) });
const erc20 = parseAbi([
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function mint(address,uint256)",
]);
const vaultAbi = parseAbi([
  "function deposit(address token, uint256 amount)",
  "function withdraw(address token, uint256 amount, uint256 nonce, uint256 deadline, bytes signature)",
]);

const receipts: { label: string; hash: Hex }[] = [];
const units = (sym: Sym, n: number) => BigInt(n) * 10n ** BigInt(DECIMALS[sym]);

interface User { name: string; account: PrivateKeyAccount; wallet: ReturnType<typeof createWalletClient>; token: string }

function makeUser(name: string, key: string | undefined): User {
  if (!key) throw new Error(`缺少 ${name} 的私钥（USER_KEY / USER_B_KEY）`);
  const account = privateKeyToAccount(key as Hex);
  return { name, account, wallet: createWalletClient({ account, chain: avalancheFuji, transport: http(RPC) }), token: "" };
}

async function api<T = any>(path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  const res = await fetch(BASE + path, { ...init, headers: { "content-type": "application/json", ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) } });
  const body = await res.json();
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status} ${JSON.stringify(body)}`);
  return body as T;
}

async function send(u: User, label: string, hash: Hex) {
  const r = await pub.waitForTransactionReceipt({ hash });
  console.log(`  ${u.name} ${label}: ${r.status}  https://testnet.snowtrace.io/tx/${hash}`);
  if (r.status !== "success") throw new Error(`${label} reverted`);
  receipts.push({ label: `${u.name} ${label}`, hash });
}

async function login(u: User) {
  const { nonce } = await api<{ nonce: string }>(`/auth/nonce?address=${u.account.address}`);
  const signature = await u.account.signTypedData({
    domain: { name: "MiniDex", version: "1", chainId: CHAIN_ID },
    types: { Login: [{ name: "address", type: "address" }, { name: "nonce", type: "string" }, { name: "statement", type: "string" }] },
    primaryType: "Login",
    message: { address: u.account.address, nonce, statement: "Sign in to MiniDex" },
  });
  u.token = (await api<{ token: string }>("/auth/login", { method: "POST", body: JSON.stringify({ address: u.account.address, nonce, signature }) })).token;
}

const balances = (u: User) => api<Record<Sym, { available: string; locked: string }>>("/balances", { token: u.token });
const onchain = (sym: Sym, who: Address) => pub.readContract({ address: TOKENS[sym], abi: erc20, functionName: "balanceOf", args: [who] });

async function deposit(u: User, sym: Sym, amount: number) {
  const wei = units(sym, amount);
  const w = u.wallet as any;
  if ((await onchain(sym, u.account.address)) < wei) {
    await send(u, `mint ${amount} ${sym}`, await w.writeContract({ address: TOKENS[sym], abi: erc20, functionName: "mint", args: [u.account.address, wei] }));
  }
  if ((await pub.readContract({ address: TOKENS[sym], abi: erc20, functionName: "allowance", args: [u.account.address, VAULT] })) < wei) {
    await send(u, `approve ${amount} ${sym}`, await w.writeContract({ address: TOKENS[sym], abi: erc20, functionName: "approve", args: [VAULT, wei] }));
  }
  await send(u, `deposit ${amount} ${sym}`, await w.writeContract({ address: VAULT, abi: vaultAbi, functionName: "deposit", args: [TOKENS[sym], wei] }));
}

async function waitFor(u: User, pred: (b: Awaited<ReturnType<typeof balances>>) => boolean, ms = 120_000) {
  const t0 = Date.now();
  let b = await balances(u);
  while (!pred(b)) {
    if (Date.now() - t0 > ms) throw new Error(`${u.name} 等待入账超时，最后余额 ${JSON.stringify(b)}`);
    await new Promise((r) => setTimeout(r, 2000));
    b = await balances(u);
  }
  return b;
}

async function withdraw(u: User, sym: Sym, amount: string) {
  const before = await onchain(sym, u.account.address);
  const w = await api("/withdraw", { method: "POST", token: u.token, body: JSON.stringify({ token: sym, amount }) });
  await send(u, `withdraw ${amount} ${sym}`, await (u.wallet as any).writeContract({
    address: VAULT, abi: vaultAbi, functionName: "withdraw",
    args: [getAddress(w.tokenAddress), BigInt(w.amount), BigInt(w.nonce), BigInt(w.deadline), w.signature],
  }));
  const diff = (await onchain(sym, u.account.address)) - before;
  if (diff !== BigInt(w.amount)) throw new Error(`${u.name} 链上 ${sym} 变化 ${diff} ≠ ${w.amount}`);
  console.log(`  ✔ ${u.name} 链上 ${sym} +${amount}`);
}

async function main() {
  const A = makeUser("A", process.env.USER_KEY);
  const B = makeUser("B", process.env.USER_B_KEY);
  const config = await api<{ mode: string; vault: string }>("/config");
  if (config.mode !== "chain" || getAddress(config.vault) !== VAULT) throw new Error(`server 不是链上模式或 vault 不一致: ${JSON.stringify(config)}`);
  console.log(`A ${A.account.address}\nB ${B.account.address}\nVault ${VAULT}\n`);

  const gasB = await pub.getBalance({ address: B.account.address });
  if (gasB < parseEther("0.05")) {
    console.log(`[0] B 只有 ${formatEther(gasB)} AVAX，A 转 0.1 AVAX 给 B 付 gas`);
    await send(A, "transfer 0.1 AVAX → B", await (A.wallet as any).sendTransaction({ to: B.account.address, value: parseEther("0.1") }));
  }

  await login(A);
  await login(B);
  const a0 = await balances(A);
  const b0 = await balances(B);

  console.log("\n[1] 充值：A 100 USDC + 5 WAVAX，B 200 USDC");
  await deposit(A, "USDC", 100);
  await deposit(A, "WAVAX", 5);
  await deposit(B, "USDC", 200);
  await waitFor(A, (b) => Number(b.USDC.available) >= Number(a0.USDC.available) + 100 && Number(b.WAVAX.available) >= Number(a0.WAVAX.available) + 5);
  await waitFor(B, (b) => Number(b.USDC.available) >= Number(b0.USDC.available) + 200);
  console.log("  ✔ 后端监听 Deposit 入账:", JSON.stringify({ A: await balances(A), B: await balances(B) }));

  console.log("\n[2] 成交：A sell limit 1 WAVAX @ 20，B buy market 1 WAVAX");
  const sell = await api("/orders", { method: "POST", token: A.token, body: JSON.stringify({ side: "sell", type: "limit", price: "20", qty: "1" }) });
  const buy = await api("/orders", { method: "POST", token: B.token, body: JSON.stringify({ side: "buy", type: "market", qty: "1" }) });
  const fill = buy.fills.find((f: any) => f.makerOrderId === sell.order.id);
  if (!fill) throw new Error(`B 没有吃到 A 的卖单: ${JSON.stringify(buy.fills)}`);
  console.log(`  ✔ 成交 ${fill.qty} @ ${fill.price}  maker=${fill.maker} taker=${fill.taker}`);

  console.log("\n[3] 提现：B 提 1 WAVAX，A 提 20 USDC");
  await withdraw(B, "WAVAX", "1");
  await withdraw(A, "USDC", "20");
  console.log("  交易所余额:", JSON.stringify({ A: await balances(A), B: await balances(B) }));

  console.log("\n==== 交易哈希汇总 ====");
  for (const r of receipts) console.log(`${r.label.padEnd(28)} ${r.hash}`);
  console.log("\nFUJI DEMO OK");
}

main().catch((e) => { console.error(e); process.exit(1); });
