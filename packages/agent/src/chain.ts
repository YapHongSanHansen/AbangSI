/**
 * Seller-side Cardano transactions (Evolution SDK, Blockfrost) against Masumi's
 * canonical preprod contracts:
 *
 *   register / deregister   mint / burn the registry V2 NFT          (MintAction 0 / BurnAction 2)
 *   submitResult            vested_pay FundsLocked → ResultSubmitted  (SubmitResult 5)
 *   withdraw / collectDue   vested_pay ResultSubmitted → seller       (Withdraw 0, after unlock_time)
 *
 * Validity windows are derived from chain time (latest block), never the local
 * clock, and respect vested_pay's rules (see contracts/vested_pay.ak):
 *   SubmitResult: lower ≥ seller_cooldown_time; upper < submit_result_time;
 *                 continuation seller_cooldown ≥ upper + cooldown_period; value preserved.
 *   Withdraw:     lower ≥ unlock_time; buyer collateral returned, tagged with the spent out-ref.
 * Every build is evaluated by Blockfrost, so a script failure throws before signing.
 */
import {
  Address, Assets, Client, Data, InlineDatum, KeyHash, preprod, ScriptHash, SlotConfig, Time,
  TransactionHash, TransactionInput, type TransactionMetadatum, type UTxO,
} from "@evolution-sdk/evolution";
import { MASUMI_DEFAULT_DEPLOYMENT, parseMasumiLockDatum, type MasumiDatumView } from "@x402/cardano";
import type { Blockfrost } from "./config.js";
import { ESCROW_ADDRESS, paymentKeyHash, REGISTRY_POLICY_ID, unitKey } from "./constants.js";
import { assertCanonicalContracts, paymentScript, registryScript } from "./contracts.js";
import { registryAssetName, STATE, submitResultDatum } from "./masumi.js";

const REDEEMER = {
  withdraw: Data.constr(0n, []),
  submitResult: Data.constr(5n, []),
  mint: Data.constr(0n, []),
  burn: Data.constr(2n, []),
};
const SLOT = SlotConfig.SLOT_CONFIG_NETWORK.Preprod;
const COOLDOWN_MS = BigInt(MASUMI_DEFAULT_DEPLOYMENT.cooldownPeriod);
/** POSIX ms the ledger exposes to scripts for a bound: the start of its slot. */
export const slotStartMs = (ms: bigint) => Time.slotToUnixTime(Time.unixTimeToSlot(ms, SLOT), SLOT);
export const ceilToSlotMs = (ms: bigint) => (slotStartMs(ms) === ms ? ms : slotStartMs(ms) + BigInt(SLOT.slotLength));

export interface EscrowLock {
  txHash: string;
  outputIndex: number;
  datum: MasumiDatumView | null;
  lovelace: bigint;
  tokens: Record<string, bigint>;
  hasReferenceScript: boolean;
  utxo: UTxO.UTxO;
}

/** What a lock must say for ReelForge to start work: exactly the terms it signed. */
export interface ExpectedLock {
  sellerAddress: string;
  referenceKey: string;
  referenceSignature: string;
  sellerNonce: string;
  buyerNonce: string;
  agentIdentifier: string;
  inputHash: string;
  payByTime: bigint;
  submitResultTime: bigint;
  unlockTime: bigint;
  externalDisputeUnlockTime: bigint;
  /** Unit (`lovelace`, `policy.name` or `policyname`) and minimum amount locked. */
  unit: string;
  amount: bigint;
}

/** Returns why `lock` does not satisfy `expected`, or null when it does. */
export function lockMismatch(lock: EscrowLock, e: ExpectedLock): string | null {
  const d = lock.datum;
  if (!d) return "no vested_pay V2 datum";
  if (lock.hasReferenceScript) return "carries a reference script";
  if (d.state !== STATE.FundsLocked) return `state ${d.state} is not FundsLocked`;
  if (d.resultHash !== "" || d.sellerCooldownTime !== 0n || d.buyerCooldownTime !== 0n) return "not a fresh lock";
  if (d.seller.payment.isScript || d.seller.payment.hash !== paymentKeyHash(e.sellerAddress)) return "seller mismatch";
  if (d.buyer.payment.isScript) return "buyer is a script";
  if (d.sellerReturnAddress !== null) return "unexpected seller return address";
  const eq: Array<[string, unknown, unknown]> = [
    ["reference_key", d.referenceKey, e.referenceKey], ["reference_signature", d.referenceSignature, e.referenceSignature],
    ["seller_nonce", d.sellerNonce, e.sellerNonce], ["buyer_nonce", d.buyerNonce, e.buyerNonce],
    ["agent_identifier", d.agentIdentifier, e.agentIdentifier], ["input_hash", d.inputHash, e.inputHash],
    ["pay_by_time", d.payByTime, e.payByTime], ["submit_result_time", d.submitResultTime, e.submitResultTime],
    ["unlock_time", d.unlockTime, e.unlockTime], ["external_dispute_unlock_time", d.externalDisputeUnlockTime, e.externalDisputeUnlockTime],
  ];
  for (const [name, got, want] of eq) if (String(got).toLowerCase() !== String(want).toLowerCase()) return `${name} mismatch`;
  const key = unitKey(e.unit);
  const paid = key === "" ? lock.lovelace - d.collateralReturnLovelace : lock.tokens[key] ?? 0n;
  if (paid < e.amount) return `paid ${paid} < ${e.amount} of ${e.unit}`;
  if (d.collateralReturnLovelace > lock.lovelace) return "collateral exceeds locked lovelace";
  return null;
}

/** JSON → transaction metadatum (strings must already be ≤64 bytes). */
function toMetadatum(v: unknown): TransactionMetadatum.TransactionMetadatum {
  if (typeof v === "string") {
    if (Buffer.byteLength(v) > 64) throw new Error(`metadata string over 64 bytes: ${v.slice(0, 24)}…`);
    return v;
  }
  if (typeof v === "number" || typeof v === "bigint") return BigInt(v);
  if (Array.isArray(v)) return v.map(toMetadatum);
  if (v && typeof v === "object") return new Map(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, toMetadatum(x)] as const));
  throw new Error(`unsupported metadata value ${String(v)}`);
}

const hexOf = (u: UTxO.UTxO) => TransactionHash.toHex(u.transactionId);

export function createChain(cfg: { blockfrost: Blockfrost; mnemonic: string; sellerAddress: string; log?: (m: string) => void }) {
  assertCanonicalContracts();
  const log = cfg.log ?? (() => {});
  const client = Client.make(preprod).withBlockfrost(cfg.blockfrost).withSeed({ mnemonic: cfg.mnemonic });
  const seller = Address.fromBech32(cfg.sellerAddress);
  const sellerVkh = paymentKeyHash(cfg.sellerAddress);
  const escrow = Address.fromBech32(ESCROW_ADDRESS);
  const bf = async (path: string) => {
    const r = await fetch(`${cfg.blockfrost.baseUrl}${path}`, { headers: { project_id: cfg.blockfrost.projectId } });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`Blockfrost ${path} → ${r.status}`);
    return r.json() as Promise<unknown>;
  };

  // One transaction at a time: they would otherwise race for the seller's inputs.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => { const run = queue.then(task, task); queue = run.catch(() => {}); return run; };

  /** Seller UTxOs safe to spend: never the registry NFT, never a reference script. */
  async function spendable() {
    const address = Address.toBech32(await client.address());
    if (address !== cfg.sellerAddress) throw new Error("SELLER_MNEMONIC does not derive the seller address");
    return (await client.getWalletUtxos()).filter(u => u.scriptRef === undefined && !Assets.getUnits(u.assets).some(x => x.startsWith(REGISTRY_POLICY_ID)));
  }

  async function tipMs(): Promise<bigint> {
    const b = await bf("/blocks/latest") as { time: number } | null;
    if (!b) throw new Error("no chain tip");
    return BigInt(b.time) * 1000n;
  }

  async function finish(built: { sign(): Promise<{ submit(): Promise<TransactionHash.TransactionHash> }> }, onSubmitted?: (h: string) => void) {
    const hash = await (await built.sign()).submit();
    const hex = TransactionHash.toHex(hash);
    onSubmitted?.(hex);
    await client.awaitTx(hash, 5_000, 600_000);
    return hex;
  }

  function toLock(u: UTxO.UTxO): EscrowLock {
    const tokens: Record<string, bigint> = {};
    for (const unit of Assets.getUnits(u.assets)) if (unit !== "lovelace") tokens[unit] = Assets.getByUnit(u.assets, unit);
    const datum = u.datumOption instanceof InlineDatum.InlineDatum ? parseMasumiLockDatum(u.datumOption.data) : null;
    return { txHash: hexOf(u), outputIndex: Number(u.index), datum, lovelace: Assets.lovelaceOf(u.assets), tokens, hasReferenceScript: u.scriptRef !== undefined, utxo: u };
  }

  /** Unspent escrow outputs created by one transaction (x402: the verified lock tx). */
  async function locksOfTx(txHash: string): Promise<EscrowLock[]> {
    const rows = await bf(`/txs/${txHash}/utxos`) as { outputs: Array<{ output_index: number; address: string; consumed_by_tx?: string | null; collateral?: boolean }> } | null;
    const idx = (rows?.outputs ?? []).filter(o => o.address === ESCROW_ADDRESS && !o.consumed_by_tx && !o.collateral).map(o => o.output_index);
    if (!idx.length) return [];
    const refs = idx.map(i => new TransactionInput.TransactionInput({ transactionId: TransactionHash.fromHex(txHash), index: BigInt(i) }));
    return (await client.getUtxosByOutRef(refs)).map(toLock);
  }

  /** Escrow UTxOs holding `unit` (standard path: Sokosumi's node locks tUSDM). */
  const locksWithUnit = async (unit: string) => (await client.getUtxosWithUnit(escrow, unitKey(unit))).map(toLock);
  /** All escrow UTxOs (paginated; used by collection). */
  const allLocks = async () => (await client.getUtxos(escrow)).map(toLock);

  /** Mints the ReelForge registry NFT to the seller with label-721 V2 metadata. */
  const register = (metadata: Record<string, unknown>) => serial(async () => {
    const wallet = await spendable();
    const seed = wallet.find(u => !Assets.hasMultiAsset(u.assets)) ?? wallet[0];
    if (!seed) throw new Error("Seller wallet has no spendable UTxO — fund it with tADA");
    const assetName = registryAssetName(hexOf(seed), Number(seed.index));
    const nft = Assets.addByHex(Assets.zero, REGISTRY_POLICY_ID, assetName, 1n);
    const built = await client.newTx()
      .collectFrom({ inputs: [seed] })
      .attachScript({ script: registryScript() })
      .mintAssets({ assets: nft, redeemer: REDEEMER.mint })
      .payToAddress({ address: seller, assets: Assets.withLovelace(nft, 2_000_000n), autoMinUtxo: true })
      .attachMetadata({ label: 721n, metadata: toMetadatum({ [REGISTRY_POLICY_ID]: { [assetName]: metadata }, version: "1" }) })
      .addSigner({ keyHash: KeyHash.fromHex(sellerVkh) })
      .build({ changeAddress: seller, availableUtxos: wallet });
    const txHash = await finish(built, h => log(`registry mint submitted ${h}`));
    return { txHash, agentIdentifier: REGISTRY_POLICY_ID + assetName };
  });

  const deregister = (agentIdentifier: string) => serial(async () => {
    const holder = (await client.getWalletUtxos()).find(u => Assets.getByUnit(u.assets, agentIdentifier) === 1n);
    if (!holder) throw new Error(`${agentIdentifier} is not held by the seller`);
    const built = await client.newTx()
      .collectFrom({ inputs: [holder] })
      .attachScript({ script: registryScript() })
      .mintAssets({ assets: Assets.addByHex(Assets.zero, REGISTRY_POLICY_ID, agentIdentifier.slice(56), -1n), redeemer: REDEEMER.burn })
      .addSigner({ keyHash: KeyHash.fromHex(sellerVkh) })
      .build({ changeAddress: seller, availableUtxos: await spendable() });
    return finish(built);
  });

  /** SubmitResult: continue the lock at the escrow with result_hash set. */
  const submitResult = (lock: EscrowLock, resultHashHex: string, onSubmitted?: (h: string) => void) => serial(async () => {
    const utxo = lock.utxo, d = lock.datum;
    if (!d || !(utxo.datumOption instanceof InlineDatum.InlineDatum)) throw new Error("lock has no inline datum");
    if (d.seller.payment.hash !== sellerVkh) throw new Error("lock belongs to another seller");
    if (d.state !== STATE.FundsLocked && d.state !== STATE.ResultSubmitted) throw new Error(`cannot submit from state ${d.state}`);
    const now = await tipMs();
    const earliest = ceilToSlotMs(d.sellerCooldownTime);
    const from = now - 60_000n > earliest ? now - 60_000n : earliest;
    const to = [now + 300_000n, d.submitResultTime - 120_000n].reduce((a, b) => (a < b ? a : b));
    if (to <= now + 30_000n || from >= to) throw new Error("SubmitResult window has closed");
    const sellerCooldown = slotStartMs(to) + COOLDOWN_MS;
    const built = await client.newTx()
      .collectFrom({ inputs: [utxo], redeemer: REDEEMER.submitResult })
      .attachScript({ script: paymentScript() })
      .payToAddress({
        address: utxo.address, assets: utxo.assets, autoMinUtxo: true,
        datum: new InlineDatum.InlineDatum({ data: submitResultDatum(utxo.datumOption.data, resultHashHex, sellerCooldown) }),
      })
      .addSigner({ keyHash: KeyHash.fromHex(sellerVkh) })
      .setValidity({ from, to })
      .build({ changeAddress: seller, availableUtxos: await spendable() });
    return finish(built, onSubmitted);
  });

  /** Withdraw a ResultSubmitted escrow after unlock_time; buyer collateral goes back tagged with the out-ref. */
  const withdraw = (lock: EscrowLock) => serial(async () => {
    const d = lock.datum!;
    const now = await tipMs();
    const from = ceilToSlotMs(d.unlockTime);
    if (now < from) throw new Error("unlock time not reached");
    let tx = client.newTx()
      .collectFrom({ inputs: [lock.utxo], redeemer: REDEEMER.withdraw })
      .attachScript({ script: paymentScript() })
      .addSigner({ keyHash: KeyHash.fromHex(sellerVkh) })
      .setValidity({ from, to: now + 300_000n });
    if (d.collateralReturnLovelace > 0n) {
      const a = d.buyerReturnAddress ?? d.buyer;
      if (a.pointer) throw new Error("pointer buyer address unsupported");
      const cred = (c: { isScript: boolean; hash: string }) => (c.isScript ? ScriptHash.fromHex(c.hash) : KeyHash.fromHex(c.hash));
      tx = tx.payToAddress({
        address: new Address.Address({ networkId: 0, paymentCredential: cred(a.payment), ...(a.stake ? { stakingCredential: cred(a.stake) } : {}) }),
        assets: Assets.fromLovelace(d.collateralReturnLovelace),
        datum: new InlineDatum.InlineDatum({ data: Data.constr(0n, [Data.bytearray(lock.txHash), Data.int(BigInt(lock.outputIndex))]) }),
        autoMinUtxo: true,
      });
    }
    return finish(await tx.build({ changeAddress: seller, availableUtxos: await spendable() }), h => log(`withdraw submitted ${h}`));
  });

  /** Locks of this seller that are ResultSubmitted and past unlock_time. */
  async function dueForCollection(): Promise<EscrowLock[]> {
    const [locks, now] = await Promise.all([allLocks(), tipMs()]);
    return locks.filter(l => l.datum && l.datum.state === STATE.ResultSubmitted && l.datum.resultHash !== ""
      && !l.datum.seller.payment.isScript && l.datum.seller.payment.hash === sellerVkh && l.datum.sellerReturnAddress === null
      && !l.datum.buyer.pointer && !l.datum.buyerReturnAddress?.pointer && l.datum.collateralReturnLovelace <= l.lovelace
      && now >= ceilToSlotMs(l.datum.unlockTime));
  }

  /** Refreshes a lock by out-ref (after SubmitResult the escrow UTxO is a new output). */
  async function lockByRef(txHash: string, index: number) {
    const [u] = await client.getUtxosByOutRef([new TransactionInput.TransactionInput({ transactionId: TransactionHash.fromHex(txHash), index: BigInt(index) })]);
    return u ? toLock(u) : null;
  }

  return { tipMs, locksOfTx, locksWithUnit, allLocks, lockByRef, register, deregister, submitResult, withdraw, dueForCollection, sellerVkh };
}
export type Chain = ReturnType<typeof createChain>;