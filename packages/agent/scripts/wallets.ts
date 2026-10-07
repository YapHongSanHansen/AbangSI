/**
 * Creates the two ReelForge preprod wallets if missing and stores their
 * mnemonics in the root .env. Mnemonics are never printed — only addresses.
 *   SELLER_MNEMONIC  the agent: signs terms, holds the registry NFT, runs escrow txs, receives payouts
 *   BUYER_MNEMONIC   a test buyer used by `pnpm buy` to pay ReelForge over x402
 */
import { readFileSync, writeFileSync } from "node:fs";
import { PrivateKey } from "@evolution-sdk/evolution";
import { toMasumiSellerSigner } from "@x402/cardano";
import { ROOT_ENV } from "../src/config.js";
import { NETWORK } from "../src/constants.js";

let env = readFileSync(ROOT_ENV, "utf8");
for (const name of ["SELLER_MNEMONIC", "BUYER_MNEMONIC"]) {
  const line = new RegExp(`^${name}=(.*)$`, "m");
  const current = env.match(line)?.[1]?.trim();
  if (!current) {
    const mnemonic = PrivateKey.generateMnemonic(256);
    env = line.test(env) ? env.replace(line, `${name}=${mnemonic}`) : `${env.trimEnd()}\n${name}=${mnemonic}\n`;
    process.env[name] = mnemonic;
    console.log(`${name}: generated`);
  } else {
    process.env[name] = current;
    console.log(`${name}: kept existing`);
  }
}
writeFileSync(ROOT_ENV, env);
const addr = (m: string) => toMasumiSellerSigner({ network: NETWORK, mnemonic: m }).sellerAddress;
console.log(`seller ${addr(process.env.SELLER_MNEMONIC!)}`);
console.log(`buyer  ${addr(process.env.BUYER_MNEMONIC!)}`);
console.log("Fund both with tADA (https://dispenser.masumi.network or https://docs.cardano.org/cardano-testnets/tools/faucet).");